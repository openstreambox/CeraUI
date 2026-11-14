import { expect, test } from "bun:test";
import {
	type BoxSample,
	LinkBoxHeatPolicy,
} from "../modules/streaming/heat-link-box-share.ts";

function item<T>(items: T[], index: number): T {
	const value = items[index];
	if (value === undefined) throw new Error("Missing fixture item");
	return value;
}

function sample(now: number, soc = 81): BoxSample {
	return {
		now,
		soc,
		socAt: now,
		session: "show",
		carrying: true,
		encoder: false,
		keepQuality: false,
		at: now,
		streamAt: now,
		rate: 1000,
		rate60: 1000,
		rtt: 20,
		rttMedian: 20,
		pathsComplete: true,
		phone: "phone",
		phoneVerified: true,
		links: [600, 300, 100].map((rate, i) => ({
			id: `leg${i}`,
			rate,
			provenRate: 1000,
			loss: 0,
			rtt: 20,
			rttMedian: 20,
			recovering: false,
			phoneUplink: i === 0,
			temperature: 70 + i,
		})),
		clients: ["phone", "guest", "admin"].map((id) => ({
			id,
			bound: true,
			ipv4Only: true,
			joinedAt: -200000,
			management: id === "admin",
			streaming: id === "phone",
			receiverFlow: false,
			lastCarryingAt: -200000,
			trafficKbps: 200,
		})),
	};
}
function warm(p: LinkBoxHeatPolicy, end = 75000, soc = 81) {
	let result = p.tick(sample(0, soc));
	for (let t = 1000; t <= end; t += 1000) result = p.tick(sample(t, soc));
	return result;
}
test("thermal dwell and step order: USB, one loan, one client", () => {
	const p = new LinkBoxHeatPolicy();
	expect(p.tick(sample(0))).toMatchObject({
		usb: false,
		lend: null,
		pause: [],
	});
	expect(p.tick(sample(1000))).toMatchObject({ lend: null, pause: [] });
	// Use a continuous trace, rather than letting a gap count as hot time.
	const q = new LinkBoxHeatPolicy();
	expect(warm(q, 10000)).toMatchObject({ usb: true, lend: null, pause: [] });
	expect(warm(new LinkBoxHeatPolicy(), 70000)).toMatchObject({
		lend: "leg2",
		pause: [],
	});
	expect(warm(new LinkBoxHeatPolicy(), 71000)).toMatchObject({
		lend: "leg2",
		pause: ["guest"],
	});
});
test("largest leg, phone uplink, recovering legs and insufficient room are never lent", () => {
	for (const change of [
		(s: BoxSample) => {
			item(s.links, 2).phoneUplink = true;
		},
		(s: BoxSample) => {
			item(s.links, 2).recovering = true;
		},
		(s: BoxSample) => {
			for (const l of s.links) l.provenRate = l.rate;
		},
		(s: BoxSample) => {
			item(s.links, 2).rate = 600;
		},
	]) {
		const p = new LinkBoxHeatPolicy();
		for (let t = 0; t <= 80000; t += 1000) {
			const s = sample(t);
			change(s);
			expect(p.tick(s).lend).toBeNull();
		}
	}
});
test("unknown or stale traffic numbers fail closed and recover an active loan immediately", () => {
	for (const alter of [
		(s: BoxSample) => {
			s.at -= 2001;
		},
		(s: BoxSample) => {
			s.streamAt -= 3001;
		},
		(s: BoxSample) => {
			s.rate = Number.NaN;
		},
	]) {
		const p = new LinkBoxHeatPolicy();
		warm(p);
		const s = sample(76000);
		alter(s);
		expect(p.tick(s)).toMatchObject({ lend: null, pause: [] });
	}
});
test("stream dip rolls back now and two rollbacks stop further lending", () => {
	const p = new LinkBoxHeatPolicy();
	warm(p);
	const dip = sample(76000);
	dip.rate = 850;
	expect(p.tick(dip)).toMatchObject({ lend: null, pause: [] });
	for (let t = 77000; t < 976000; t += 1000)
		expect(p.tick(sample(t)).lend).toBeNull();
	let result = p.tick(sample(976000));
	for (let t = 977000; t <= 1040000; t += 1000) result = p.tick(sample(t));
	expect(result.lend).toBe("leg2");
	const second = sample(1041000);
	second.rate = 850;
	expect(p.tick(second).lend).toBeNull();
	for (let t = 1042000; t <= 2100000; t += 1000)
		expect(p.tick(sample(t)).lend).toBeNull();
});
test("RTT and peer loss require five continuous seconds; peer dropout is immediate", () => {
	for (const signal of ["rtt", "loss", "drop"] as const) {
		const p = new LinkBoxHeatPolicy();
		warm(p);
		for (let t = 76000; t <= 81000; t += 1000) {
			const s = sample(t);
			if (signal === "rtt") s.rtt = 30;
			if (signal === "loss") item(s.links, 0).loss = 0.06;
			if (signal === "drop") s.links.splice(0, 1);
			expect(p.tick(s).lend).toBe(
				signal === "drop" || t === 81000 ? null : "leg2",
			);
		}
	}
});
test("phone, management, possible streamers, new or ambiguous clients remain online", () => {
	for (const alter of [
		(s: BoxSample) => {
			item(s.clients, 1).streaming = true;
		},
		(s: BoxSample) => {
			item(s.clients, 1).receiverFlow = true;
		},
		(s: BoxSample) => {
			item(s.clients, 1).bound = false;
		},
		(s: BoxSample) => {
			item(s.clients, 1).ipv4Only = false;
		},
		(s: BoxSample) => {
			item(s.clients, 1).joinedAt = s.now;
		},
		(s: BoxSample) => {
			item(s.clients, 1).lastCarryingAt = s.now;
		},
		(s: BoxSample) => {
			s.phoneVerified = false;
		},
	]) {
		const p = new LinkBoxHeatPolicy();
		for (let t = 0; t <= 80000; t += 1000) {
			const s = sample(t);
			alter(s);
			expect(p.tick(s).pause).toEqual([]);
		}
	}
});
test("Let back on prevents re-pause for the session", () => {
	const p = new LinkBoxHeatPolicy();
	expect(warm(p).pause).toEqual(["guest"]);
	p.letBackOn("guest");
	for (let t = 76000; t <= 900000; t += 1000)
		expect(p.tick(sample(t)).pause).toEqual([]);
});
test("Keep quality, session change, encoder takeover and stream end restore everything", () => {
	for (const alter of [
		(s: BoxSample) => {
			s.keepQuality = true;
		},
		(s: BoxSample) => {
			s.session = "next";
		},
		(s: BoxSample) => {
			s.encoder = true;
		},
		(s: BoxSample) => {
			s.carrying = false;
		},
	]) {
		const p = new LinkBoxHeatPolicy();
		warm(p);
		const s = sample(76000);
		alter(s);
		expect(p.tick(s)).toMatchObject({ lend: null, pause: [] });
	}
});
test("cooling honors hold and reverse order, and boundary noise does not flap", () => {
	const p = new LinkBoxHeatPolicy();
	warm(p);
	for (let t = 76000; t < 310000; t += 1000)
		expect(p.tick(sample(t, 74 + (t % 2000 ? 1 : 0))).pause).toEqual(["guest"]);
	let last = 310000;
	let r = p.tick(sample(last, 50));
	for (; last < 430000 && r.pause.length; last += 1000)
		r = p.tick(sample(last, 50));
	expect(r.pause).toEqual([]);
	expect(r.lend).toBe("leg2");
	for (let t = last + 1000; t < last + 120000; t += 1000)
		expect(p.tick(sample(t, 50)).lend).toBe("leg2");
	for (let t = last + 120000; t <= 800000; t += 1000) r = p.tick(sample(t, 50));
	expect(r).toMatchObject({ usb: false, lend: null, pause: [] });
});
test("status describes confirmed effects only; reasons belong in the timeline", () => {
	const p = new LinkBoxHeatPolicy();
	const r = warm(p);
	expect(p.status({ lend: null, pause: [] })).toContain("keeps all its links");
	expect(p.status({ lend: r.lend, pause: r.pause })).toContain(
		"one other device",
	);
	expect(p.status({ lend: r.lend, pause: [] })).toContain("other links");
});

test("candidate sawtooth resets the continuous dwell", () => {
	const p = new LinkBoxHeatPolicy();
	for (let t = 0; t <= 130000; t += 1000) {
		const s = sample(t);
		if (t % 50000 === 0) item(s.links, 2).rate = 160;
		expect(p.tick(s).lend).toBeNull();
	}
});
test("a previously large leg needs sixty seconds under thirty percent, then candidate dwell", () => {
	const p = new LinkBoxHeatPolicy();
	for (let t = 0; t <= 30000; t += 1000) {
		const s = sample(t);
		item(s.links, 2).rate = 410;
		expect(p.tick(s).lend).toBeNull();
	}
	for (let t = 31000; t < 151000; t += 1000)
		expect(p.tick(sample(t)).lend).toBeNull();
	expect(p.tick(sample(151000)).lend).toBe("leg2");
});
test("duplicate legs, future timestamps, invalid values and gaps cannot establish dwell", () => {
	for (const alter of [
		(s: BoxSample) => {
			item(s.links, 1).id = "leg0";
		},
		(s: BoxSample) => {
			s.at = s.now + 1;
		},
		(s: BoxSample) => {
			item(s.links, 2).loss = NaN;
		},
		(s: BoxSample) => {
			s.rate60 = 0;
		},
	]) {
		const p = new LinkBoxHeatPolicy();
		for (let t = 0; t < 90000; t += 1000) {
			const s = sample(t);
			alter(s);
			expect(p.tick(s).lend).toBeNull();
		}
	}
	const p = new LinkBoxHeatPolicy();
	warm(p, 69000);
	expect(p.tick(sample(73000))).toMatchObject({ lend: null, pause: [] });
});
test("newly protected client is released even while still critical", () => {
	const p = new LinkBoxHeatPolicy();
	warm(p);
	const s = sample(76000);
	item(s.clients, 1).management = true;
	expect(p.tick(s)).toMatchObject({ lend: "leg2", pause: [] });
	for (let t = 77000; t < 676000; t += 1000)
		expect(p.tick(sample(t)).pause).toEqual([]);
	expect(p.tick(sample(676000)).pause).toEqual(["guest"]);
});
test("no producer evidence implies no traffic effects or success notice", () => {
	const p = new LinkBoxHeatPolicy();
	for (let t = 0; t < 90000; t += 1000) {
		const s = sample(t);
		s.at = -100000;
		expect(p.tick(s)).toMatchObject({ lend: null, pause: [] });
	}
	expect(p.status({ lend: null, pause: [] })).toContain("can't see");
});

test("effect owner confirms actions, restores clients before links, and retries unconfirmed returns", async () => {
	const { LinkBoxHeatSession } = await import(
		"../modules/streaming/heat-link-box-share.ts"
	);
	const events: string[] = [];
	let returned = false;
	let s = sample(0);
	const session = new LinkBoxHeatSession({
		spareUsb: async (on) => {
			events.push(`usb:${on}`);
		},
		lend: async (id, safe) => {
			if (!safe()) return false;
			events.push(`lend:${id}`);
			return true;
		},
		returnLink: async (id) => {
			events.push(`return:${id}`);
			return returned;
		},
		pause: async (id, safe) => {
			if (id && !safe()) return false;
			events.push(`pause:${id}`);
			return true;
		},
	});
	for (let t = 0; t <= 75000; t += 1000) {
		s = sample(t);
		await session.update(() => s);
	}
	expect(events).toContain("lend:leg2");
	expect(events).toContain("pause:guest");
	s = sample(76000);
	s.keepQuality = true;
	events.length = 0;
	const pending = await session.update(() => s);
	expect(events.indexOf("pause:null")).toBeLessThan(
		events.indexOf("return:leg2"),
	);
	expect(pending.returning).toBe("leg2");
	expect(pending.status).toContain("hasn't come back");
	returned = true;
	s = sample(77000);
	s.keepQuality = true;
	expect(await session.update(() => s)).toMatchObject({
		lend: null,
		pause: [],
		returning: null,
	});
});

test("an asynchronous owner rechecks the current snapshot before restriction", async () => {
	const { LinkBoxHeatSession } = await import(
		"../modules/streaming/heat-link-box-share.ts"
	);
	let s = sample(0);
	let actual = 0;
	const session = new LinkBoxHeatSession({
		spareUsb: async () => {},
		returnLink: async () => true,
		pause: async () => true,
		lend: async (_id, safe) => {
			s = { ...s, keepQuality: true };
			if (safe()) actual++;
			return false;
		},
	});
	let result: Awaited<ReturnType<typeof session.update>> | undefined;
	for (let t = 0; t <= 71000; t += 1000) {
		s = sample(t);
		result = await session.update(() => s);
	}
	expect(actual).toBe(0);
	expect(result?.lend).toBeNull();
});

test("failed restoration remains owned and a later queued update can retry", async () => {
	const { LinkBoxHeatSession } = await import(
		"../modules/streaming/heat-link-box-share.ts"
	);
	let s = sample(0);
	let fail = true;
	const session = new LinkBoxHeatSession({
		spareUsb: async () => {},
		lend: async (_id, safe) => safe(),
		pause: async (id, safe) => (id ? safe() : true),
		returnLink: async () => {
			if (fail) throw new Error("return not confirmed");
			return true;
		},
	});
	for (let t = 0; t <= 75000; t += 1000) {
		s = sample(t);
		await session.update(() => s);
	}
	s = sample(76000);
	s.keepQuality = true;
	await expect(session.update(() => s)).rejects.toThrow("return not confirmed");
	fail = false;
	s = sample(77000);
	s.keepQuality = true;
	expect(await session.update(() => s)).toMatchObject({
		lend: null,
		pause: [],
		returning: null,
	});
});

test("fresh session resets rollback and client exemptions without inheriting a loan", () => {
	const p = new LinkBoxHeatPolicy();
	warm(p);
	p.letBackOn("guest");
	const first = sample(76000);
	first.session = "next";
	expect(p.tick(first)).toMatchObject({ lend: null, pause: [] });
	let result = p.tick({ ...sample(77000), session: "next" });
	for (let t = 78000; t <= 151000; t += 1000)
		result = p.tick({ ...sample(t), session: "next" });
	expect(result).toMatchObject({ lend: "leg2", pause: ["guest"] });
});

test("carrying planner accepts the session policy, never legacy main-link labels", async () => {
	const { planLinkBoxHeat } = await import(
		"../modules/streaming/heat-link-box.ts"
	);
	const policy = new LinkBoxHeatPolicy();
	let result: ReturnType<typeof planLinkBoxHeat> | undefined;
	for (let t = 0; t <= 71000; t += 1000) {
		const s = sample(t);
		result = planLinkBoxHeat(
			3,
			true,
			false,
			{
				at: t,
				carrying: "streaming",
				encoder: false,
				mainLink: null,
				phone: null,
				links: [],
				clients: null,
				measured: { sample: s, policy },
			},
			t,
		);
	}
	expect(result).toMatchObject({ usb: true, lend: "leg2", pause: ["guest"] });
});

test("carrying admission veto releases policy state before a later fresh report", async () => {
	const { planLinkBoxHeat } = await import(
		"../modules/streaming/heat-link-box.ts"
	);
	const policy = new LinkBoxHeatPolicy();
	warm(policy);
	const evidence = (s: BoxSample) => ({
		at: s.now,
		carrying: "streaming" as const,
		encoder: false,
		mainLink: null,
		phone: null,
		links: [],
		clients: null,
		measured: { sample: s, policy },
	});
	const s = sample(76000);
	expect(planLinkBoxHeat(3, false, false, evidence(s), 76000)).toMatchObject({
		lend: null,
		pause: [],
	});
	expect(
		planLinkBoxHeat(3, true, false, evidence(sample(77000)), 77000),
	).toMatchObject({ lend: null, pause: [] });
});

test("warm, hot and critical temperatures admit only their own steps", () => {
	expect(warm(new LinkBoxHeatPolicy(), 80000, 71)).toMatchObject({
		usb: true,
		lend: null,
		pause: [],
	});
	expect(warm(new LinkBoxHeatPolicy(), 80000, 76)).toMatchObject({
		usb: true,
		lend: "leg2",
		pause: [],
	});
	expect(warm(new LinkBoxHeatPolicy(), 80000, 81)).toMatchObject({
		usb: true,
		lend: "leg2",
		pause: ["guest"],
	});
});

test("hottest eligible modem wins, and a newly used phone uplink returns immediately", () => {
	const p = new LinkBoxHeatPolicy();
	for (let t = 0; t <= 75000; t += 1000) {
		const s = sample(t);
		s.links.push({ ...item(s.links, 2), id: "leg3", temperature: 90 });
		expect(p.tick(s).lend).toBe(t < 70000 ? null : "leg3");
	}
	const s = sample(76000);
	s.links.push({
		...item(s.links, 2),
		id: "leg3",
		temperature: 90,
		phoneUplink: true,
	});
	expect(p.tick(s)).toMatchObject({ lend: null, pause: [] });
});

test("relay counters without complete routed-phone coverage cannot authorize a loan", () => {
	const p = new LinkBoxHeatPolicy();
	for (let t = 0; t <= 80000; t += 1000) {
		const s = sample(t);
		s.pathsComplete = false;
		expect(p.tick(s)).toMatchObject({ lend: null, pause: [] });
	}
});

test("unknown observations cannot count toward large-leg release hysteresis", () => {
	const p = new LinkBoxHeatPolicy();
	for (let t = 0; t <= 20000; t += 1000) {
		const s = sample(t);
		item(s.links, 2).rate = 410;
		p.tick(s);
	}
	for (let t = 21000; t <= 50000; t += 1000) p.tick(sample(t));
	for (let t = 51000; t <= 110000; t += 1000) {
		const s = sample(t);
		s.pathsComplete = false;
		p.tick(s);
	}
	for (let t = 111000; t < 231000; t += 1000)
		expect(p.tick(sample(t)).lend).toBeNull();
	expect(p.tick(sample(231000)).lend).toBe("leg2");
});

test("time spent waiting for confirmed restoration never counts toward a new loan", async () => {
	const { LinkBoxHeatSession } = await import(
		"../modules/streaming/heat-link-box-share.ts"
	);
	let s = sample(0);
	let returned = false;
	let loans = 0;
	const session = new LinkBoxHeatSession({
		spareUsb: async () => {},
		lend: async (_id, safe) => {
			if (!safe()) return false;
			loans++;
			return true;
		},
		pause: async (id, safe) => (id ? safe() : true),
		returnLink: async () => returned,
	});
	for (let t = 0; t <= 75000; t += 1000) {
		s = sample(t);
		await session.update(() => s);
	}
	s = sample(76000);
	s.rate = 850;
	await session.update(() => s);
	for (let t = 77000; t <= 1100000; t += 1000) {
		s = sample(t);
		await session.update(() => s);
	}
	returned = true;
	s = sample(1101000);
	await session.update(() => s);
	for (let t = 1102000; t < 1162000; t += 1000) {
		s = sample(t);
		await session.update(() => s);
		expect(loans).toBe(1);
	}
});

test("a source exception releases existing restrictions rather than retaining a stale loan", async () => {
	const { LinkBoxHeatSession } = await import(
		"../modules/streaming/heat-link-box-share.ts"
	);
	let s = sample(0);
	const actions: string[] = [];
	const session = new LinkBoxHeatSession({
		spareUsb: async () => {},
		lend: async (_id, safe) => safe(),
		pause: async (id, safe) => {
			if (id && !safe()) return false;
			actions.push(`pause:${id}`);
			return true;
		},
		returnLink: async (id) => {
			actions.push(`return:${id}`);
			return true;
		},
	});
	for (let t = 0; t <= 75000; t += 1000) {
		s = sample(t);
		await session.update(() => s);
	}
	actions.length = 0;
	expect(
		await session.update(() => {
			throw new Error("source unavailable");
		}),
	).toMatchObject({ lend: null, pause: [] });
	expect(actions).toEqual(["pause:null", "return:leg2"]);
});

test("an invalid clock releases the loan and cannot resume it on the next valid sample", () => {
	const p = new LinkBoxHeatPolicy();
	warm(p);
	const invalid = sample(76000);
	invalid.now = NaN;
	expect(p.tick(invalid)).toMatchObject({ lend: null, pause: [] });
	expect(p.tick(sample(77000))).toMatchObject({ lend: null, pause: [] });
});

test("largest eligible leg below forty percent is independently protected", () => {
	const p = new LinkBoxHeatPolicy();
	let result: ReturnType<LinkBoxHeatPolicy["tick"]> | undefined;
	for (let t = 0; t <= 80000; t += 1000) {
		const s = sample(t);
		s.links.forEach((l, i) => {
			l.rate = 150 - i * 10;
			l.phoneUplink = false;
			l.temperature = 90 - i;
		});
		result = p.tick(s);
		expect(result.lend).not.toBe("leg0");
	}
	expect(result?.lend).toBe("leg1");
});
test("phone identity alone protects the busiest non-streaming client", () => {
	const p = new LinkBoxHeatPolicy();
	let result: ReturnType<LinkBoxHeatPolicy["tick"]> | undefined;
	for (let t = 0; t <= 80000; t += 1000) {
		const s = sample(t);
		item(s.clients, 0).streaming = false;
		item(s.clients, 0).trafficKbps = 900;
		result = p.tick(s);
		expect(result.pause).not.toContain("phone");
	}
	expect(result?.pause).toEqual(["guest"]);
});
test("four-link peer dropout restores while three valid links remain", () => {
	const p = new LinkBoxHeatPolicy();
	const four = (t: number) => {
		const s = sample(t);
		s.links.push({ ...item(s.links, 0), id: "leg3" });
		return s;
	};
	for (let t = 0; t <= 75000; t += 1000) p.tick(four(t));
	const s = four(76000);
	s.links.splice(3, 1);
	expect(p.tick(s)).toMatchObject({ lend: null, pause: [] });
});
test("lifting a client waits two minutes before pausing another", () => {
	const p = new LinkBoxHeatPolicy();
	expect(warm(p).pause).toEqual(["guest"]);
	for (let t = 76000; t <= 196000; t += 1000) {
		const s = sample(t);
		item(s.clients, 1).streaming = true;
		s.clients.push({ ...item(s.clients, 1), id: "other", streaming: false });
		expect(p.tick(s).pause).toEqual(t < 196000 ? [] : ["other"]);
	}
});
test("two brief thermal gaps do not spend the session rollback budget", () => {
	const p = new LinkBoxHeatPolicy();
	warm(p);
	let result: ReturnType<LinkBoxHeatPolicy["tick"]> | undefined;
	for (let t = 76000; t <= 500000; t += 1000) {
		const s = sample(t);
		if (t === 100000 || t === 300000) s.soc = null;
		result = p.tick(s);
		if (s.soc === null)
			expect(result).toMatchObject({ lend: "leg2", pause: ["guest"] });
	}
	expect(result?.lend).toBe("leg2");
});
test("frozen, future and missing thermal timestamps release restrictions", () => {
	for (const at of [0, 76001, NaN]) {
		const p = new LinkBoxHeatPolicy();
		warm(p);
		const s = sample(76000);
		for (let t = 76000; t <= 79000; t += 1000) {
			s.now = s.at = s.streamAt = t;
			s.socAt = at === 76001 ? t + 1 : at;
			expect(p.tick(s)).toMatchObject(
				t < 79000
					? { lend: "leg2", pause: ["guest"] }
					: { lend: null, pause: [] },
			);
		}
	}
});

test("permission previews cannot spend rollback budget", () => {
	const p = new LinkBoxHeatPolicy();
	warm(p);
	const dip = sample(76000);
	dip.rate = 850;
	expect(p.preview(dip).lend).toBeNull();
	expect(p.preview(dip).lend).toBeNull();
	expect(p.tick(sample(76000)).lend).toBe("leg2");
});
test("outer stage dip clears policy admission and requires fresh dwell", async () => {
	const { planLinkBoxHeat } = await import(
		"../modules/streaming/heat-link-box.ts"
	);
	const policy = new LinkBoxHeatPolicy();
	warm(policy);
	const run = (t: number, stage: number) =>
		planLinkBoxHeat(
			stage,
			true,
			false,
			{
				at: t,
				carrying: "streaming",
				encoder: false,
				mainLink: null,
				phone: null,
				links: [],
				clients: null,
				measured: { sample: sample(t), policy },
			},
			t,
		);
	expect(run(76000, 1).lend).toBeNull();
	for (let t = 77000; t < 147000; t += 1000) expect(run(t, 3).lend).toBeNull();
	expect(run(147000, 3).lend).toBe("leg2");
});
test("calm stream, own loss and two healthy peers each gate admission", () => {
	for (const change of [
		(s: BoxSample) => {
			s.rate = 940;
		},
		(s: BoxSample) => {
			s.rtt = 27;
		},
		(s: BoxSample) => {
			item(s.links, 2).loss = 0.021;
		},
		(s: BoxSample) => {
			item(s.links, 0).loss = 0.021;
		},
		(s: BoxSample) => {
			item(s.links, 0).recovering = true;
		},
	]) {
		const p = new LinkBoxHeatPolicy();
		for (let t = 0; t <= 80000; t += 1000) {
			const s = sample(t);
			change(s);
			expect(p.tick(s).lend).toBeNull();
		}
	}
});
test("smallest tied-temperature leg and busiest eligible client win", () => {
	const p = new LinkBoxHeatPolicy();
	let result: ReturnType<LinkBoxHeatPolicy["tick"]> | undefined;
	for (let t = 0; t <= 80000; t += 1000) {
		const s = sample(t);
		s.links.push({ ...item(s.links, 2), id: "smaller", rate: 90 });
		item(s.clients, 1).trafficKbps = 200;
		s.clients.push({ ...item(s.clients, 1), id: "other", trafficKbps: 300 });
		result = p.tick(s);
	}
	expect(result).toMatchObject({ lend: "smaller", pause: ["other"] });
});
test("unknown phone membership prevents pausing and tick gaps restore loans", () => {
	const p = new LinkBoxHeatPolicy();
	warm(p);
	const s = sample(76000);
	s.clients.shift();
	expect(p.tick(s).pause).toEqual([]);
	expect(p.tick(sample(80000))).toMatchObject({ lend: null, pause: [] });
});

test("USB owner sees unknown temperature while link return is pending", async () => {
	const { LinkBoxHeatSession } = await import(
		"../modules/streaming/heat-link-box-share.ts"
	);
	let s = sample(0);
	const usb: boolean[] = [];
	const owner = new LinkBoxHeatSession({
		spareUsb: async (_eligible, known) => {
			usb.push(known);
		},
		lend: async (_id, safe) => safe(),
		pause: async (id, safe) => (id ? safe() : true),
		returnLink: async () => false,
	});
	for (let t = 0; t <= 75000; t += 1000) {
		s = sample(t);
		await owner.update(() => s);
	}
	s = sample(76000);
	s.pathsComplete = false;
	s.soc = null;
	expect((await owner.update(() => s)).returning).toBe("leg2");
	expect(usb.at(-1)).toBe(false);
});
test("rollback timeline names the signal", () => {
	const p = new LinkBoxHeatPolicy();
	warm(p);
	const s = sample(76000);
	s.rate = 850;
	p.tick(s);
	expect(p.timeline.at(-1)?.reason).toBe("stream receive rate fell");
});

test("one hundred kbit client stays online and hot never pauses even briefly", () => {
	for (const soc of [76, 81]) {
		const p = new LinkBoxHeatPolicy();
		for (let t = 0; t <= 80000; t += 1000) {
			const s = sample(t, soc);
			if (soc === 81) item(s.clients, 1).trafficKbps = 100;
			expect(p.tick(s).pause).toEqual([]);
		}
	}
});
test("large leg holds protection in the thirty to forty percent band", () => {
	const p = new LinkBoxHeatPolicy();
	for (let t = 0; t <= 30000; t += 1000) {
		const s = sample(t);
		item(s.links, 2).rate = 410;
		p.tick(s);
	}
	for (let t = 31000; t <= 120000; t += 1000) {
		const s = sample(t);
		item(s.links, 2).rate = 350;
		p.tick(s);
	}
	for (let t = 121000; t < 241000; t += 1000)
		expect(p.tick(sample(t)).lend).toBeNull();
	expect(p.tick(sample(241000)).lend).toBe("leg2");
});
test("a rested leg becoming the largest returns immediately", () => {
	const p = new LinkBoxHeatPolicy();
	warm(p);
	const s = sample(76000);
	item(s.links, 0).rate = 80;
	item(s.links, 1).rate = 90;
	expect(p.tick(s)).toMatchObject({ lend: null, pause: [] });
});
test("no pause is applied without a confirmed link restriction", async () => {
	const { LinkBoxHeatSession } = await import(
		"../modules/streaming/heat-link-box-share.ts"
	);
	let s = sample(0);
	let pauses = 0;
	const owner = new LinkBoxHeatSession({
		spareUsb: async () => {},
		lend: async () => false,
		pause: async (id) => {
			if (id) pauses++;
			return true;
		},
		returnLink: async () => true,
	});
	for (let t = 0; t <= 80000; t += 1000) {
		s = sample(t);
		await owner.update(() => s);
	}
	expect(pauses).toBe(0);
});

for (const every of [30, 65, 125, 300]) {
	for (const fault of ["null", "stale"] as const) {
		test(`one-hour repeated ${fault} thermal gaps every ${every}s do not cycle restrictions`, () => {
			const p = new LinkBoxHeatPolicy();
			let previous = { lend: null as string | null, pause: [] as string[] };
			let loans = 0,
				pauses = 0;
			for (let t = 0; t <= 3600000; t += 1000) {
				const s = sample(t);
				s.clients.push(
					{ ...item(s.clients, 1), id: "g2" },
					{ ...item(s.clients, 1), id: "g3" },
				);
				if (t > 0 && t % (every * 1000) === 0) {
					if (fault === "null") s.soc = null;
					else s.socAt = t - 2001;
				}
				const next = p.tick(s);
				if (next.lend && !previous.lend) loans++;
				if (next.pause.length && !previous.pause.length) pauses++;
				previous = next;
			}
			expect({ loans, pauses }).toEqual(
				every === 30 ? { loans: 0, pauses: 0 } : { loans: 1, pauses: 1 },
			);
			expect(previous).toMatchObject(
				every === 30
					? { lend: null, pause: [] }
					: { lend: "leg2", pause: ["g2"] },
			);
			expect(p.timeline).toEqual([]);
		});
	}
}

test("thermal freshness accepts 2000ms and starts grace at 2001ms", () => {
	for (const age of [2000, 2001]) {
		const p = new LinkBoxHeatPolicy();
		warm(p);
		for (let t = 76000; t <= 79000; t += 1000) {
			const s = sample(t);
			s.socAt = t - age;
			expect(p.tick(s).lend).toBe(age === 2001 && t === 79000 ? null : "leg2");
		}
	}
});
test("thermal grace adds no steps and keeps stream and client protections active", () => {
	const p = new LinkBoxHeatPolicy();
	warm(p, 70000);
	const s = sample(71000);
	s.soc = null;
	expect(p.tick(s)).toMatchObject({ lend: "leg2", pause: [] });
	s.now = s.at = s.streamAt = 72000;
	s.rate = 850;
	expect(p.tick(s)).toMatchObject({ lend: null, pause: [] });
	const q = new LinkBoxHeatPolicy();
	warm(q);
	const c = sample(76000);
	c.soc = null;
	item(c.clients, 1).streaming = true;
	expect(q.tick(c)).toMatchObject({ lend: "leg2", pause: [] });
});
test("thermal expiry releases at three seconds without locking the loan", () => {
	const p = new LinkBoxHeatPolicy();
	warm(p);
	for (let t = 76000; t <= 79000; t += 1000) {
		const s = sample(t);
		s.soc = null;
		expect(p.tick(s).lend).toBe(t < 79000 ? "leg2" : null);
	}
	for (let t = 80000; t <= 140000; t += 1000) p.tick(sample(t));
	expect(p.tick(sample(141000)).lend).toBe("leg2");
});
test("stage ceiling lifts pause and spaces the next pause after reheating", () => {
	const p = new LinkBoxHeatPolicy();
	warm(p);
	const s = sample(76000);
	expect(p.tick(s, 2)).toMatchObject({ lend: "leg2", pause: [] });
	for (let t = 77000; t <= 196000; t += 1000) {
		const next = sample(t);
		next.clients.push({ ...item(next.clients, 1), id: "other" });
		expect(p.tick(next).pause).toEqual(t < 196000 ? [] : ["other"]);
	}
});
test("rollback lift spaces a new client's pause even with another available leg", () => {
	const p = new LinkBoxHeatPolicy();
	warm(p);
	const s = sample(76000);
	s.rate = 850;
	p.tick(s);
	for (let t = 77000; t <= 196000; t += 1000) {
		const next = sample(t);
		item(next.links, 1).rate = 100;
		next.clients.push({ ...item(next.clients, 1), id: "other" });
		expect(p.tick(next).pause).toEqual(t < 196000 ? [] : ["other"]);
	}
});
test("session rechecks cannot spend rollback budget", async () => {
	const { LinkBoxHeatSession } = await import(
		"../modules/streaming/heat-link-box-share.ts"
	);
	let s = sample(0);
	const owner = new LinkBoxHeatSession({
		spareUsb: async () => {},
		returnLink: async () => true,
		lend: async (_id, safe) => {
			const good = s;
			s = { ...s, rate: 850 };
			expect(safe()).toBe(false);
			expect(safe()).toBe(false);
			s = good;
			return safe();
		},
		pause: async (_id, safe) => safe(),
	});
	for (let t = 0; t <= 75000; t += 1000) {
		s = sample(t);
		await owner.update(() => s);
	}
	s = sample(76000);
	expect(await owner.update(() => s)).toMatchObject({
		lend: "leg2",
		pause: ["guest"],
	});
});
