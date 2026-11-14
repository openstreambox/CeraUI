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
test("unknown or stale numbers fail closed and recover an active loan immediately", () => {
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
		(s: BoxSample) => {
			s.soc = null;
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
			item(s.links, 2).id = "leg0";
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
