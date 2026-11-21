import { describe, expect, it } from "bun:test";
import {
	HOTSPOT_INTERFACE_EFFECT,
	MODEM_RADIO_MODE_EFFECT,
} from "./network-change-effects.ts";
import { harness, plan, session } from "./network-change-test-fakes.ts";
import { CANDIDATE_PREFIX, type SettledEvent } from "./network-checkpoint.ts";

const UNDO = { answer: "undo-automatically" } as const;
const KEEP = { answer: "keep-change" } as const;

/** An active Ethernet profile, plus two dormant duplicates of a modem profile. */
function world(options: { settleMs?: number } = {}) {
	const h = harness(options);
	const eth = h.fake.add("Wired", { "ipv4.addresses": "192.0.2.1/24" });
	h.fake.active.set("eth0", eth);
	const dupA = h.fake.add("Modem", { "gsm.apn": "old" }, false);
	const dupB = h.fake.add("Modem", { "gsm.apn": "old" }, false);
	const ethPlan = plan({
		devices: ["eth0"],
		profiles: [
			{
				uuid: eth,
				set: [["ipv4.addresses", "192.0.2.2/24"]],
				activateOn: "eth0",
			},
		],
	});
	const modemPlan = plan({
		devices: ["wwan0"],
		profiles: [dupA, dupB].map((uuid) => ({
			uuid,
			set: [["gsm.apn", "new"]] as Array<[string, string]>,
		})),
	});
	return { ...h, eth, dupA, dupB, ethPlan, modemPlan };
}

const creator = session("old", "eth0", 500);
const fresh = session("fresh", "eth0", 1001);

describe("network change confirmation", () => {
	it("arms the daemon's 90 second deadline before touching any profile", async () => {
		const w = world();
		await w.owner.apply(creator, w.ethPlan, UNDO);
		expect(w.fake.calls.slice(0, 2)).toEqual(["create:eth0:90", "clone:Wired"]);
	});
	it("requires a session opened after the change over the changed interface", async () => {
		const w = world();
		const pending = await w.owner.apply(creator, w.ethPlan, UNDO);
		if (pending.kind !== "pending") throw new Error("expected pending");
		for (const s of [
			creator,
			{ ...fresh, openedAt: 999 },
			{ ...fresh, authenticated: false },
			{ ...fresh, ingress: "wlan0" },
			{ ...fresh, ingress: undefined },
			// The creator's identity never confirms, even with a later timestamp.
			{ ...fresh, id: creator.id },
		])
			await expect(w.owner.confirm(pending.id, s)).rejects.toThrow();
		// Another path never confirms a change to this one, however late.
		w.at(60_000);
		await expect(
			w.owner.confirm(pending.id, session("phone", "wlan0", 50_000)),
		).rejects.toThrow();
		expect(w.fake.calls).not.toContain("destroy");
		await w.owner.confirm(pending.id, fresh);
		expect(w.fake.calls.slice(-3)).toEqual([
			"destroy",
			"persist:Wired",
			"remove:Wired",
		]);
	});
	it("does not promote after timeout even when the client kept the pending id", async () => {
		const w = world();
		const pending = await w.owner.apply(creator, w.ethPlan, UNDO);
		await w.fake.expireAll();
		if (pending.kind !== "pending") throw new Error("expected pending");
		await expect(w.owner.confirm(pending.id, fresh)).rejects.toThrow();
		expect(w.fake.calls.filter((c) => c.startsWith("persist"))).toEqual([]);
	});
	it("checks the deadline before destroying or promoting", async () => {
		const w = world();
		const pending = await w.owner.apply(creator, w.ethPlan, UNDO);
		w.at(91_001);
		if (pending.kind !== "pending") throw new Error("expected pending");
		await expect(w.owner.confirm(pending.id, fresh)).rejects.toThrow();
		expect(w.fake.calls).not.toContain("destroy");
	});
	it("rolls back a failed apply without writing a profile", async () => {
		const w = world();
		w.fake.fail.add("activate");
		await expect(w.owner.apply(creator, w.ethPlan, UNDO)).rejects.toThrow(
			"activate failed",
		);
		expect(w.fake.calls).toContain("rollback");
		expect(w.fake.calls.filter((c) => c.startsWith("persist"))).toEqual([]);
		expect(w.fake.byId("Wired")).toHaveLength(1);
		expect(await w.fake.nm.listByPrefix(CANDIDATE_PREFIX)).toEqual([]);
		// A failure the caller saw is not an ask-after notice.
		expect((await w.owner.status()).notice).toBeNull();
	});
	it("refuses overlapping changes until the daemon checkpoint expires", async () => {
		const w = world();
		await w.owner.apply(creator, w.ethPlan, UNDO);
		await expect(w.owner.apply(creator, w.modemPlan, UNDO)).rejects.toThrow(
			"pending",
		);
		await w.fake.expireAll();
		w.at(91_000);
		await w.owner.apply(creator, w.modemPlan, UNDO);
		expect(w.fake.calls.filter((c) => c.startsWith("create"))).toEqual([
			"create:eth0:90",
			"create:wwan0:90",
		]);
	});
	it("does not dispatch for an unauthenticated session or an empty device set", async () => {
		const w = world();
		await expect(
			w.owner.apply({ ...creator, authenticated: false }, w.ethPlan, UNDO),
		).rejects.toThrow();
		await expect(w.owner.apply(creator, plan(), UNDO)).rejects.toThrow();
		expect(w.fake.calls).toEqual([]);
	});
	it("refuses simultaneous applies while checkpoint creation is in flight", async () => {
		const w = world();
		const first = w.owner.apply(creator, w.ethPlan, UNDO);
		await expect(w.owner.apply(creator, w.modemPlan, UNDO)).rejects.toThrow(
			"busy",
		);
		await first;
	});
	it("refuses a session opened during apply before the candidate was ready", async () => {
		const w = world();
		const activate = w.fake.nm.activate;
		w.fake.nm.activate = async (uuid, device) => {
			w.at(2000);
			await activate(uuid, device);
		};
		const pending = await w.owner.apply(creator, w.ethPlan, UNDO);
		if (pending.kind !== "pending") throw new Error("expected pending");
		await expect(w.owner.confirm(pending.id, fresh)).rejects.toThrow();
		expect(w.fake.calls).not.toContain("destroy");
	});
	it("never promotes when the daemon rejects checkpoint destruction", async () => {
		const w = world();
		const pending = await w.owner.apply(creator, w.ethPlan, UNDO);
		w.fake.fail.add("destroy");
		if (pending.kind !== "pending") throw new Error("expected pending");
		await expect(w.owner.confirm(pending.id, fresh)).rejects.toThrow(
			"destroy failed",
		);
		expect(w.fake.calls.filter((c) => c.startsWith("persist"))).toEqual([]);
	});
	it("does not apply when checkpoint creation fails", async () => {
		const w = world();
		w.fake.fail.add("create");
		await expect(w.owner.apply(creator, w.ethPlan, UNDO)).rejects.toThrow(
			"create failed",
		);
		expect(w.fake.calls.some((c) => c.startsWith("clone"))).toBe(false);
	});
	it("clears its pending status only when the daemon's checkpoint is gone", async () => {
		const w = world();
		const pending = await w.owner.apply(creator, w.ethPlan, UNDO);
		if (pending.kind !== "pending") throw new Error("expected pending");
		expect((await w.owner.status()).pending?.id).toBe(pending.id);
		expect(await w.owner.tick()).toBe(false);
		await w.fake.expireAll();
		w.at(91_000);
		await w.owner.tick();
		expect((await w.owner.status()).pending).toBeNull();
	});
});

describe("inactive and duplicate profiles go through candidates", () => {
	it("edits only in-memory candidates and leaves every original untouched", async () => {
		const w = world();
		await w.owner.apply(session("s", "eth0"), w.modemPlan);
		for (const uuid of [w.dupA, w.dupB]) {
			expect(w.fake.profiles.get(uuid)?.settings["gsm.apn"]).toBe("old");
			expect(w.fake.profiles.get(uuid)?.storage).toBe("disk");
		}
		const candidates = await w.fake.nm.listByPrefix(CANDIDATE_PREFIX);
		expect(candidates).toHaveLength(2);
		for (const uuid of candidates) {
			const p = w.fake.profiles.get(uuid);
			expect(p?.settings["gsm.apn"]).toBe("new");
			expect(p?.storage).toBe("memory");
			expect(p?.autoconnect).toBe(false);
		}
	});
	it("a candidate never autoconnects behind the owner's back", async () => {
		const w = world();
		await w.owner.apply(creator, w.ethPlan, UNDO);
		const [candidate] = await w.fake.nm.listByPrefix(CANDIDATE_PREFIX);
		expect(w.fake.profiles.get(w.eth)?.autoconnect).toBe(true);
		expect(w.fake.profiles.get(candidate as string)?.autoconnect).toBe(false);
	});
	it("restores dormant duplicates on expiry, which a device checkpoint alone does not", async () => {
		const w = world();
		await w.owner.apply(session("s", "eth0"), w.modemPlan);
		await w.fake.expireAll();
		w.at(91_000);
		await w.owner.tick();
		expect(w.fake.byId("Modem")).toHaveLength(2);
		for (const [, p] of w.fake.byId("Modem"))
			expect(p.settings["gsm.apn"]).toBe("old");
		expect(await w.fake.nm.listByPrefix(CANDIDATE_PREFIX)).toEqual([]);
	});
	it("promotes every duplicate on confirmation under its original name and autoconnect", async () => {
		const w = world({ settleMs: 0 });
		const s = session("s", "eth0");
		const pending = await w.owner.apply(s, w.modemPlan);
		if (pending.kind !== "pending") throw new Error("expected pending");
		w.at(2000);
		await w.owner.confirm(pending.id, s);
		const modems = w.fake.byId("Modem");
		expect(modems).toHaveLength(2);
		for (const [uuid, p] of modems) {
			expect([w.dupA, w.dupB]).not.toContain(uuid);
			expect(p).toMatchObject({ autoconnect: false, storage: "disk" });
			expect(p.settings["gsm.apn"]).toBe("new");
		}
		expect(await w.fake.nm.listByPrefix(CANDIDATE_PREFIX)).toEqual([]);
	});
	it("an active candidate takes over without a second activation", async () => {
		const w = world();
		const pending = await w.owner.apply(creator, w.ethPlan, UNDO);
		if (pending.kind !== "pending") throw new Error("expected pending");
		const candidate = w.fake.active.get("eth0");
		await w.owner.confirm(pending.id, fresh);
		expect(w.fake.active.get("eth0")).toBe(candidate);
		expect(w.fake.calls.filter((c) => c.startsWith("activate"))).toHaveLength(
			1,
		);
		expect(w.fake.byId("Wired")).toHaveLength(1);
	});
});

describe("no unconfirmed edit outlives a restart", () => {
	it("NetworkManager restart: candidates removed, original back, effects undone, ask after", async () => {
		const w = world();
		const p = plan({
			...w.ethPlan,
			effects: [
				{
					kind: MODEM_RADIO_MODE_EFFECT,
					devices: ["wwan0"],
					spec: { modem: "modem0", mode: "4g" },
				},
			],
		});
		await w.owner.apply(creator, p, UNDO);
		w.fake.restart();
		expect(await w.fake.nm.listByPrefix(CANDIDATE_PREFIX)).toHaveLength(1);
		expect(await w.owner.reconcile("network-restart")).toBe("undone");
		expect(await w.fake.nm.listByPrefix(CANDIDATE_PREFIX)).toEqual([]);
		expect(w.fake.active.get("eth0")).toBe(w.eth);
		expect(w.effects.radio.get("modem0")).toBe("4g|5g");
		expect((await w.owner.status()).notice?.reason).toBe("restart");
	});
	it("a checkpoint lost early is a restart, even if only the timer notices", async () => {
		const w = world();
		await w.owner.apply(creator, w.ethPlan, UNDO);
		w.fake.restart();
		w.at(10_000);
		await w.owner.tick();
		expect(w.fake.active.get("eth0")).toBe(w.eth);
		expect((await w.owner.status()).notice?.reason).toBe("restart");
	});
	it("backend restart while NetworkManager still holds the timer resumes the change", async () => {
		const w = world();
		const pending = await w.owner.apply(creator, w.ethPlan, UNDO);
		const next = w.restartBackend();
		expect(await next.reconcile("backend-start")).toBe("resumed");
		if (pending.kind !== "pending") throw new Error("expected pending");
		await next.confirm(pending.id, fresh);
		expect(w.fake.byId("Wired")[0]?.[1].settings["ipv4.addresses"]).toBe(
			"192.0.2.2/24",
		);
	});
	it("reboot: memory candidates vanish, recorded undos replay, the notice survives", async () => {
		const w = world();
		await w.owner.apply(
			creator,
			plan({
				...w.ethPlan,
				effects: [
					{
						kind: HOTSPOT_INTERFACE_EFFECT,
						devices: ["ap0"],
						spec: { ifname: "ap0" },
					},
				],
			}),
			UNDO,
		);
		expect(w.effects.interfaces.has("ap0")).toBe(false);
		w.fake.reboot();
		w.newBoot();
		const next = w.restartBackend();
		expect(await next.reconcile("boot")).toBe("undone");
		expect(w.effects.interfaces.has("ap0")).toBe(true);
		expect(w.fake.byId("Wired")[0]?.[1].settings["ipv4.addresses"]).toBe(
			"192.0.2.1/24",
		);
		expect((await next.status()).notice?.reason).toBe("restart");
	});
	it("sweeps a candidate created just before a crash, before the journal named it", async () => {
		const w = world();
		await w.fake.nm.cloneCandidate(w.dupA, `${CANDIDATE_PREFIX}deadbeef-0`);
		expect(await w.owner.reconcile("network-restart")).toBe("clean");
		expect(await w.fake.nm.listByPrefix(CANDIDATE_PREFIX)).toEqual([]);
	});
	it("a crash after confirmation rolls forward, never back", async () => {
		const w = world();
		const pending = await w.owner.apply(creator, w.ethPlan, UNDO);
		if (pending.kind !== "pending") throw new Error("expected pending");
		w.fake.fail.add("remove");
		await expect(w.owner.confirm(pending.id, fresh)).rejects.toThrow();
		w.fake.fail.delete("remove");
		expect(await w.restartBackend().reconcile("backend-start")).toBe(
			"promoted",
		);
		const wired = w.fake.byId("Wired");
		expect(wired).toHaveLength(1);
		expect(wired[0]?.[1].settings["ipv4.addresses"]).toBe("192.0.2.2/24");
	});
	it("keeps an incomplete undo on record and retries only what is left", async () => {
		const w = world();
		await w.owner.apply(
			creator,
			plan({
				...w.ethPlan,
				effects: [
					{
						kind: HOTSPOT_INTERFACE_EFFECT,
						devices: ["ap0"],
						spec: { ifname: "ap0" },
					},
					{
						kind: MODEM_RADIO_MODE_EFFECT,
						devices: ["wwan0"],
						spec: { modem: "modem0", mode: "4g" },
					},
				],
			}),
			UNDO,
		);
		w.effects.failUndo.add("hotspot");
		w.fake.restart();
		expect(await w.owner.reconcile("network-restart")).toBe("incomplete");
		expect((await w.owner.status()).undoIncomplete).toBe(true);
		w.effects.failUndo.delete("hotspot");
		await w.owner.tick();
		expect((await w.owner.status()).undoIncomplete).toBe(false);
		expect(w.effects.interfaces.has("ap0")).toBe(true);
		expect(w.effects.log.filter((l) => l.startsWith("mode-undo"))).toHaveLength(
			1,
		);
	});
});

describe("effects outside NetworkManager carry a recorded undo", () => {
	const effectsPlan = () =>
		plan({
			devices: [],
			effects: [
				{
					kind: HOTSPOT_INTERFACE_EFFECT,
					devices: ["ap0"],
					spec: { ifname: "ap0" },
				},
				{
					kind: MODEM_RADIO_MODE_EFFECT,
					devices: ["wwan0"],
					spec: { modem: "modem0", mode: "4g" },
				},
			],
		});
	it("journals each undo before the effect runs", async () => {
		const w = world();
		const order: string[] = [];
		const write = w.journal.write;
		w.journal.write = async (j) => {
			const states = j.tx?.effects.map((e) => `${e.kind}:${e.state}`) ?? [];
			order.push(states.join(","));
			await write(j);
		};
		const driver = w.effects.registry.get(HOTSPOT_INTERFACE_EFFECT);
		const apply = driver.apply;
		driver.apply = async (spec) => {
			order.push("APPLY");
			await apply(spec);
		};
		await w.owner.apply(session("s", "eth0"), effectsPlan());
		const at = order.indexOf("APPLY");
		expect(order[at - 1]).toBe(`${HOTSPOT_INTERFACE_EFFECT}:intent`);
		driver.apply = apply;
	});
	it("replays undos in reverse order on timeout", async () => {
		const w = world();
		await w.owner.apply(session("s", "eth0"), effectsPlan());
		w.at(91_000);
		await w.owner.tick();
		expect(w.effects.log).toEqual([
			"teardown:ap0",
			"mode:modem0=4g",
			"mode-undo:modem0=4g|5g",
			"restore:ap0",
		]);
		expect(w.effects.interfaces.has("ap0")).toBe(true);
	});
	it("replays an undo recorded just before a crash interrupted the effect", async () => {
		const w = world();
		const driver = w.effects.registry.get(MODEM_RADIO_MODE_EFFECT);
		const apply = driver.apply;
		driver.apply = async () => {
			throw new Error("crash");
		};
		await expect(
			w.owner.apply(session("s", "eth0"), effectsPlan()),
		).rejects.toThrow("crash");
		driver.apply = apply;
		expect(w.effects.radio.get("modem0")).toBe("4g|5g");
		expect(w.effects.interfaces.has("ap0")).toBe(true);
	});
	it("checkpoints only the profile interfaces; effect-only changes use the journaled deadline", async () => {
		const w = world();
		await w.owner.apply(
			creator,
			plan({ ...w.ethPlan, effects: effectsPlan().effects }),
			UNDO,
		);
		expect(w.fake.calls[0]).toBe("create:eth0:90");
		await w.fake.expireAll();
		w.at(91_000);
		await w.owner.tick();
		const v = world();
		const pending = await v.owner.apply(session("s", "eth0"), effectsPlan());
		expect(v.fake.calls.some((c) => c.startsWith("create"))).toBe(false);
		expect(pending.kind).toBe("pending");
		v.at(50_000);
		expect(await v.owner.tick()).toBe(false);
		v.at(91_000);
		await v.owner.tick();
		expect(v.effects.interfaces.has("ap0")).toBe(true);
		expect(v.effects.radio.get("modem0")).toBe("4g|5g");
		expect((await v.owner.status()).notice?.reason).toBe("disconnected");
	});
	it("refuses an effect without a registered undo before changing anything", async () => {
		const w = world();
		await expect(
			w.owner.apply(
				session("s", "eth0"),
				plan({ effects: [{ kind: "firmware", devices: ["x0"], spec: null }] }),
			),
		).rejects.toThrow("No recorded undo");
		expect(w.fake.calls).toEqual([]);
	});
});

describe("ask before: the arrival interface decides", () => {
	it("asks before a change that cuts the session's own path, without applying", async () => {
		const w = world();
		const result = await w.owner.apply(creator, w.ethPlan);
		expect(result).toMatchObject({
			kind: "ask-before",
			messageKey: "network.changeSafety.askBefore.own",
			via: "eth0",
			seconds: 90,
			primary: { answer: "undo-automatically" },
			deliberate: { answer: "keep-change" },
		});
		expect(result).not.toHaveProperty("preselected");
		expect(w.fake.calls).toEqual([]);
	});
	it("never keeps a disconnecting change by default: it needs its explicit action", async () => {
		const w = world();
		// Own path, no answer: only the prompt, nothing applied.
		expect((await w.owner.apply(creator, w.ethPlan)).kind).toBe("ask-before");
		expect((await w.owner.apply(creator, w.ethPlan, {})).kind).toBe(
			"ask-before",
		);
		// Anything but the two explicit answers is refused, nothing applied.
		for (const answer of ["keep", "yes", "", true, null])
			await expect(
				w.owner.apply(creator, w.ethPlan, { answer: answer as never }),
			).rejects.toThrow("Unknown answer");
		expect(w.fake.calls).toEqual([]);
		expect((await w.owner.status()).kept).toBeNull();
		// Another path without a prompt still gets the automatic undo.
		const other = await w.owner.apply(session("s", "eth0"), w.modemPlan);
		expect(other.kind).toBe("pending");
		expect(w.fake.calls.some((c) => c.startsWith("create"))).toBe(true);
		expect((await w.owner.status()).kept).toBeNull();
		await w.fake.expireAll();
		w.at(91_000);
		await w.owner.tick();
		for (const [, p] of w.fake.byId("Modem"))
			expect(p.settings["gsm.apn"]).toBe("old");
		// Only the explicit deliberate answer keeps it.
		const kept = await w.owner.apply(creator, w.ethPlan, KEEP);
		expect(kept.kind).toBe("kept");
	});
	it("needs no prompt for a change that does not touch the session's path", async () => {
		const w = world();
		const result = await w.owner.apply(session("s", "eth0"), w.modemPlan);
		expect(result.kind).toBe("pending");
	});
	it("asks before when the arrival interface is unknown", async () => {
		const w = world();
		const result = await w.owner.apply(session("s", undefined), w.modemPlan);
		expect(result).toMatchObject({
			kind: "ask-before",
			messageKey: "network.changeSafety.askBefore.unknown",
			via: undefined,
		});
		expect(w.fake.calls).toEqual([]);
	});
	it("an unknown arrival interface never confirms", async () => {
		const w = world({ settleMs: 0 });
		const pending = await w.owner.apply(
			session("s", undefined),
			w.modemPlan,
			UNDO,
		);
		if (pending.kind !== "pending") throw new Error("expected pending");
		w.at(5000);
		await expect(
			w.owner.confirm(pending.id, session("n", undefined, 4000)),
		).rejects.toThrow();
		await w.owner.confirm(pending.id, session("n", "wwan0", 4000));
	});
	it("'Make the change' (undone without confirmation) is the normal confirm-or-rollback", async () => {
		const w = world();
		await w.owner.apply(creator, w.ethPlan, UNDO);
		expect(w.fake.active.get("eth0")).not.toBe(w.eth);
		await w.fake.expireAll();
		w.at(91_000);
		await w.owner.tick();
		expect(w.fake.active.get("eth0")).toBe(w.eth);
	});
	it("the deliberate 'disconnect me and don't undo it' applies with no auto-undo and keeps the recorded undo", async () => {
		const w = world();
		const p = plan({
			...w.ethPlan,
			effects: [
				{
					kind: HOTSPOT_INTERFACE_EFFECT,
					devices: ["ap0"],
					spec: { ifname: "ap0" },
				},
			],
		});
		const kept = await w.owner.apply(creator, p, KEEP);
		expect(kept.kind).toBe("kept");
		expect(w.fake.calls.some((c) => c.startsWith("create"))).toBe(false);
		w.at(200_000);
		await w.owner.tick();
		w.fake.reboot();
		w.newBoot();
		expect(await w.restartBackend().reconcile("boot")).toBe("kept");
		expect(w.fake.byId("Wired")[0]?.[1].settings["ipv4.addresses"]).toBe(
			"192.0.2.2/24",
		);
		expect(w.effects.interfaces.has("ap0")).toBe(false);
		const status = await w.owner.status();
		expect(status.kept?.undoKey).toBe("network.changeSafety.kept.undo");
		// The undo runs from any other signed-in connection.
		if (kept.kind !== "kept") throw new Error("expected kept");
		await w.owner.undoKept(kept.id, session("phone", "wlan0", 300_000));
		const wired = w.fake.byId("Wired");
		expect(wired).toHaveLength(1);
		expect(wired[0]?.[0]).toBe(w.eth);
		expect(wired[0]?.[1].settings["ipv4.addresses"]).toBe("192.0.2.1/24");
		expect(w.fake.active.get("eth0")).toBe(w.eth);
		expect(w.effects.interfaces.has("ap0")).toBe(true);
		expect((await w.owner.status()).kept).toBeNull();
	});
	it("a later change retires the previous kept change's backups", async () => {
		const w = world();
		await w.owner.apply(creator, w.ethPlan, KEEP);
		expect(w.fake.byId("Wired")).toHaveLength(1);
		await w.owner.apply(session("s", "eth0"), w.modemPlan);
		expect(
			[...w.fake.profiles.values()].filter((p) =>
				p.id.startsWith("ceralive-backup-"),
			),
		).toEqual([]);
	});
});

describe("ask after: the box undid a change nobody confirmed", () => {
	async function cutUnexpectedly(w: ReturnType<typeof world>) {
		const pending = await w.owner.apply(session("s", "eth0"), w.modemPlan);
		if (pending.kind !== "pending") throw new Error("expected pending");
		// The creator's acknowledgement never arrives: the change cut them off.
		await w.fake.expireAll();
		w.at(91_000);
		await w.owner.tick();
		return pending;
	}
	it("the creator's own connection confirms another path only after the settle time", async () => {
		const w = world();
		const s = session("s", "eth0");
		const pending = await w.owner.apply(s, w.modemPlan);
		if (pending.kind !== "pending") throw new Error("expected pending");
		w.at(2000);
		await expect(w.owner.confirm(pending.id, s)).rejects.toThrow();
		w.at(16_001);
		await w.owner.confirm(pending.id, s);
		expect((await w.owner.status()).notice).toBeNull();
	});
	it("undoes as planned and shows one notice to every device until answered", async () => {
		const w = world();
		await cutUnexpectedly(w);
		for (const [, p] of w.fake.byId("Modem"))
			expect(p.settings["gsm.apn"]).toBe("old");
		const laptop = await w.owner.status();
		const phone = await w.restartBackend().status();
		expect(laptop.notice).toMatchObject({
			reason: "disconnected",
			messageKey: "network.changeSafety.notice.disconnected",
		});
		expect(phone.notice?.id).toBe(laptop.notice?.id as string);
	});
	it("'Leave it undone' clears the notice everywhere and it never shows again", async () => {
		const w = world();
		await cutUnexpectedly(w);
		const notice = (await w.owner.status()).notice;
		if (!notice) throw new Error("expected notice");
		const before = w.changes();
		await w.owner.leaveUndone(notice.id, session("phone", "wlan0"));
		expect(w.changes()).toBeGreaterThan(before);
		expect((await w.owner.status()).notice).toBeNull();
		expect((await w.restartBackend().status()).notice).toBeNull();
		await expect(
			w.owner.leaveUndone(notice.id, session("laptop", "eth0")),
		).rejects.toThrow("already answered");
		await expect(
			w.owner.reapply(notice.id, session("laptop", "eth0"), "keep-change"),
		).rejects.toThrow("already answered");
	});
	it("'Make the change' asks before, then re-applies and clears the notice", async () => {
		const w = world();
		await cutUnexpectedly(w);
		const notice = (await w.owner.status()).notice;
		if (!notice) throw new Error("expected notice");
		const ask = await w.owner.reapply(notice.id, session("s", "eth0"));
		expect(ask.kind).toBe("ask-before");
		expect((await w.owner.status()).notice?.id).toBe(notice.id);
		const kept = await w.owner.reapply(
			notice.id,
			session("s", "eth0"),
			"keep-change",
		);
		expect(kept.kind).toBe("kept");
		expect((await w.owner.status()).notice).toBeNull();
		// Kept: the deadline passes and nothing is undone again.
		w.at(400_000);
		await w.owner.tick();
		for (const [, p] of w.fake.byId("Modem"))
			expect(p.settings["gsm.apn"]).toBe("new");
	});
	it("'Make the change' with 'undo automatically' arms a normal confirm window", async () => {
		const w = world();
		await cutUnexpectedly(w);
		const notice = (await w.owner.status()).notice;
		if (!notice) throw new Error("expected notice");
		const result = await w.owner.reapply(
			notice.id,
			session("s", "eth0"),
			"undo-automatically",
		);
		expect(result.kind).toBe("pending");
		expect((await w.owner.status()).notice).toBeNull();
	});
	it("the notice survives a reboot until someone answers", async () => {
		const w = world();
		await cutUnexpectedly(w);
		w.fake.reboot();
		w.newBoot();
		const next = w.restartBackend();
		await next.reconcile("boot");
		expect((await next.status()).notice?.reason).toBe("disconnected");
	});
});

describe("callers persist their intent only when a change settles", () => {
	function settledWorld() {
		const events: SettledEvent[] = [];
		let fail = false;
		const h = harness({
			onSettled: (event) => {
				if (fail) throw new Error("intent write failed");
				events.push(event);
			},
		});
		const eth = h.fake.add("Wired", { "ipv4.method": "auto" }, false);
		h.fake.active.set("eth0", eth);
		const ethPlan = plan({
			devices: ["eth0"],
			profiles: [
				{
					uuid: eth,
					set: [["ipv4.method", "shared"]],
					activateOn: "eth0",
					autoconnect: true,
				},
			],
		});
		return {
			...h,
			eth,
			ethPlan,
			events,
			failSettle: (value: boolean) => {
				fail = value;
			},
		};
	}

	it("reports nothing while pending, and the candidate on commit", async () => {
		const w = settledWorld();
		const pending = await w.owner.apply(creator, w.ethPlan, UNDO);
		if (pending.kind !== "pending") throw new Error("expected pending");
		expect(w.events).toEqual([]);
		await w.owner.confirm(pending.id, fresh);
		expect(w.events).toHaveLength(1);
		const [event] = w.events;
		expect(event?.outcome).toBe("committed");
		expect(event?.profiles[0]?.original).toBe(w.eth);
		const candidate = event?.profiles[0]?.candidate as string;
		expect(w.fake.profiles.get(candidate)?.id).toBe("Wired");
	});

	it("writes the edit's autoconnect on promotion, never on the candidate", async () => {
		const w = settledWorld();
		const pending = await w.owner.apply(creator, w.ethPlan, UNDO);
		if (pending.kind !== "pending") throw new Error("expected pending");
		const candidate = w.fake.active.get("eth0") as string;
		expect(w.fake.profiles.get(candidate)?.autoconnect).toBe(false);
		await w.owner.confirm(pending.id, fresh);
		expect(w.fake.profiles.get(candidate)?.autoconnect).toBe(true);
	});

	it("keeps the original's autoconnect when the edit names none", async () => {
		const w = world();
		const pending = await w.owner.apply(creator, w.ethPlan, UNDO);
		if (pending.kind !== "pending") throw new Error("expected pending");
		const candidate = w.fake.active.get("eth0") as string;
		await w.owner.confirm(pending.id, fresh);
		expect(w.fake.profiles.get(candidate)?.autoconnect).toBe(true);
	});

	it("reports an automatic undo with its reason, and a failed apply as failed", async () => {
		const w = settledWorld();
		await w.owner.apply(creator, w.ethPlan, UNDO);
		await w.fake.expireAll();
		w.at(91_001);
		await w.owner.tick();
		expect(w.events.map((e) => [e.outcome, e.reason])).toEqual([
			["undone", "disconnected"],
		]);
		w.fake.fail.add("activate");
		await expect(w.owner.apply(creator, w.ethPlan, UNDO)).rejects.toThrow();
		expect(w.events.at(-1)?.reason).toBe("failed");
	});

	it("reports a kept change as committed, and its undo as reverted", async () => {
		const w = settledWorld();
		const kept = await w.owner.apply(creator, w.ethPlan, KEEP);
		if (kept.kind !== "kept") throw new Error("expected kept");
		expect(w.events.map((e) => e.outcome)).toEqual(["committed"]);
		await w.owner.undoKept(kept.id, session("other", "wlan0", 2000));
		expect(w.events.map((e) => e.outcome)).toEqual(["committed", "reverted"]);
	});

	it("keeps the transaction when the intent write fails, and rolls forward later", async () => {
		const w = settledWorld();
		const pending = await w.owner.apply(creator, w.ethPlan, UNDO);
		if (pending.kind !== "pending") throw new Error("expected pending");
		w.failSettle(true);
		await expect(w.owner.confirm(pending.id, fresh)).rejects.toThrow(
			"intent write failed",
		);
		expect((await w.journal.read()).tx?.state).toBe("confirming");
		w.failSettle(false);
		expect(await w.restartBackend().reconcile("backend-start")).toBe(
			"promoted",
		);
		expect(w.events.map((e) => e.outcome)).toEqual(["committed"]);
		expect((await w.journal.read()).tx).toBeNull();
	});
});
