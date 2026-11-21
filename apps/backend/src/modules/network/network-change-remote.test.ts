/**
 * The second round of the network-change owner: sessions that cannot confirm
 * (no arrival evidence), and the limits the first review left open (queueing
 * instead of "busy", undo backoff, checkpoint identity, notice reasons).
 */
import { describe, expect, it } from "bun:test";
import {
	fakeReachability,
	harness,
	plan,
	session,
} from "./network-change-test-fakes.ts";
import { undoBackoffMs } from "./network-checkpoint.ts";

const UNDO = { answer: "undo-automatically" } as const;
const REACH = { answer: "keep-if-reachable" } as const;

function world(options: Parameters<typeof harness>[0] = {}): ReturnType<
	typeof harness
> & {
	eth: string;
	ethPlan: ReturnType<typeof plan>;
} {
	const h = harness(options);
	const eth = h.fake.add("Wired", { "ipv4.method": "auto" });
	h.fake.active.set("eth0", eth);
	const ethPlan = plan({
		devices: ["eth0"],
		profiles: [
			{ uuid: eth, set: [["ipv4.method", "shared"]], activateOn: "eth0" },
		],
	});
	return { ...h, eth, ethPlan };
}

const relayOverEth = session("relay", undefined, 500, {
	carriers: ["eth0"],
	tunnel: true,
});

describe("before applying: does the change cut the requesting session?", () => {
	it("route evidence names the cut, but never skips the prompt", async () => {
		const w = world({ reachability: fakeReachability().deps });
		const cuts = await w.owner.apply(relayOverEth, w.ethPlan);
		expect(cuts).toMatchObject({
			kind: "ask-before",
			cut: "cuts",
			via: "eth0",
			messageKey: "network.changeSafety.askBefore.routeCuts",
		});
		const elsewhere = session("relay", undefined, 500, {
			carriers: ["wwan0"],
			tunnel: true,
		});
		// A route that misses the port is a guess, not evidence: still asked.
		expect(await w.owner.apply(elsewhere, w.ethPlan)).toMatchObject({
			kind: "ask-before",
			cut: "unknown",
			messageKey: "network.changeSafety.askBefore.unknown",
		});
		const shared = session("relay", undefined, 500, {
			carriers: ["eth0", "wwan0"],
			tunnel: true,
		});
		expect(await w.owner.apply(shared, w.ethPlan)).toMatchObject({
			cut: "may-cut",
			via: "eth0",
		});
		expect(w.fake.calls).toEqual([]);
	});

	it("without anything to probe, the honest label is 'unless someone on eth0 confirms'", async () => {
		const w = world();
		const ask = await w.owner.apply(relayOverEth, w.ethPlan);
		expect(ask).toMatchObject({
			primary: {
				answer: "undo-automatically",
				labelKey: "network.changeSafety.askBefore.undoVia",
			},
			deliberate: { labelKey: "network.changeSafety.askBefore.keepRemote" },
		});
		expect(ask).not.toHaveProperty("alternative");
		await expect(w.owner.apply(relayOverEth, w.ethPlan, REACH)).rejects.toThrow(
			"Reachability check unavailable",
		);
		expect(w.fake.calls).toEqual([]);
	});

	it("an empty probe list is the same as no probe", async () => {
		const probe = fakeReachability();
		probe.state.available = false;
		const w = world({ reachability: probe.deps });
		const ask = await w.owner.apply(relayOverEth, w.ethPlan);
		expect(ask).toMatchObject({ primary: { answer: "undo-automatically" } });
		await expect(
			w.owner.apply(relayOverEth, w.ethPlan, REACH),
		).rejects.toThrow();
	});

	it("warns on the prompt while a stream is live", async () => {
		const w = world({ isStreaming: () => true });
		expect(await w.owner.apply(relayOverEth, w.ethPlan)).toMatchObject({
			liveKey: "network.changeSafety.askBefore.live",
		});
		const idle = world({ isStreaming: () => false });
		expect(
			await idle.owner.apply(relayOverEth, idle.ethPlan),
		).not.toHaveProperty("liveKey");
	});
});

describe("keep-if-reachable: the box checks its own way out", () => {
	it("is checkpointed like any protected change, and nobody's session confirms it", async () => {
		const probe = fakeReachability(false);
		const w = world({ reachability: probe.deps });
		const pending = await w.owner.apply(relayOverEth, w.ethPlan, REACH);
		expect(pending.kind).toBe("pending");
		expect(w.fake.calls[0]).toBe("create:eth0:90");
		if (pending.kind !== "pending") throw new Error("expected pending");
		w.at(50_000);
		await expect(
			w.owner.confirm(pending.id, session("later", undefined, 40_000)),
		).rejects.toThrow();
		expect(w.fake.calls).not.toContain("destroy");
	});

	it("needs two fresh successes in a row after the settle time", async () => {
		const probe = fakeReachability(true);
		const w = world({ reachability: probe.deps });
		await w.owner.apply(relayOverEth, w.ethPlan, REACH);
		w.at(16_001);
		expect(await w.owner.tick()).toBe(false);
		// A failure in between resets the count.
		probe.state.up = false;
		w.at(21_001);
		expect(await w.owner.tick()).toBe(false);
		probe.state.up = true;
		w.at(26_001);
		expect(await w.owner.tick()).toBe(false);
		// Too soon after the previous probe: not probed at all.
		w.at(27_000);
		expect(await w.owner.tick()).toBe(false);
		expect(probe.state.probes).toBe(3);
		w.at(31_001);
		expect(await w.owner.tick()).toBe(true);
		expect(w.fake.calls.slice(-3)).toEqual([
			"destroy",
			"persist:Wired",
			"remove:Wired",
		]);
		expect(w.fake.byId("Wired")[0]?.[1].settings["ipv4.method"]).toBe("shared");
	});

	it("a probe that throws counts as unreachable", async () => {
		const w = world({
			reachability: {
				available: () => true,
				probe: async () => {
					throw new Error("no route");
				},
			},
		});
		await w.owner.apply(relayOverEth, w.ethPlan, REACH);
		for (const t of [16_001, 21_001, 26_001]) {
			w.at(t);
			expect(await w.owner.tick()).toBe(false);
		}
		expect(w.fake.calls).not.toContain("destroy");
	});

	it("never commits after NetworkManager's own timer undid the change", async () => {
		const probe = fakeReachability(true);
		const w = world({ reachability: probe.deps });
		await w.owner.apply(relayOverEth, w.ethPlan, REACH);
		w.at(16_001);
		await w.owner.tick();
		await w.fake.expireAll();
		w.at(21_001);
		expect(await w.owner.tick()).toBe(true);
		expect(w.fake.calls).not.toContain("destroy");
		expect(w.fake.byId("Wired")[0]?.[1].settings["ipv4.method"]).toBe("auto");
		// Lost early (well before the deadline): reported as a restart.
		expect((await w.owner.status()).notice?.reason).toBe("restart");
	});

	it("an unreachable box is undone at the deadline with the 'lost the internet' notice", async () => {
		const probe = fakeReachability(false);
		const w = world({ reachability: probe.deps });
		await w.owner.apply(relayOverEth, w.ethPlan, REACH);
		await w.fake.expireAll();
		w.at(91_000);
		expect(await w.owner.tick()).toBe(true);
		const status = await w.owner.status();
		expect(status.notice).toMatchObject({
			reason: "unreachable",
			messageKey: "network.changeSafety.notice.unreachable",
		});
	});

	it("a backend restart only restarts the count; NetworkManager still holds the timer", async () => {
		const probe = fakeReachability(true);
		const w = world({ reachability: probe.deps });
		await w.owner.apply(relayOverEth, w.ethPlan, REACH);
		w.at(16_001);
		await w.owner.tick();
		const next = w.restartBackend();
		expect(await next.reconcile("backend-start")).toBe("resumed");
		w.at(21_001);
		expect(await next.tick()).toBe(false);
		w.at(26_001);
		expect(await next.tick()).toBe(true);
	});
});

describe("one operation at a time, without 'busy' refusals", () => {
	it("a confirmation that lands during a tick waits for it and succeeds", async () => {
		const w = world();
		const creator = session("old", "eth0", 500);
		const pending = await w.owner.apply(creator, w.ethPlan, UNDO);
		if (pending.kind !== "pending") throw new Error("expected pending");
		const live = w.fake.nm.live;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let first = true;
		w.fake.nm.live = async (path) => {
			if (first) {
				first = false;
				await gate;
			}
			return live(path);
		};
		const tick = w.owner.tick();
		const confirm = w.owner.confirm(pending.id, session("new", "eth0", 1_001));
		release();
		expect(await tick).toBe(false);
		await confirm;
		expect(w.fake.calls).toContain("destroy");
	});

	it("the tick still skips a turn instead of queueing behind a request", async () => {
		const w = world();
		const slow = w.fake.nm.create;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		w.fake.nm.create = async (devices, timeout) => {
			await gate;
			return slow(devices, timeout);
		};
		const apply = w.owner.apply(session("old", "eth0", 500), w.ethPlan, UNDO);
		await Promise.resolve();
		expect(await w.owner.tick()).toBe(false);
		release();
		expect((await apply).kind).toBe("pending");
	});
});

describe("an undo that keeps failing backs off and says so", () => {
	it("retries after 5, 10, 20 s and logs each attempt", async () => {
		const w = world();
		await w.owner.apply(session("old", "eth0", 500), w.ethPlan, UNDO);
		// NetworkManager keeps refusing to remove the candidate.
		w.fake.fail.add("remove");
		await w.fake.expireAll();
		w.at(91_000);
		expect(await w.owner.tick()).toBe(false);
		let status = await w.owner.status();
		expect(status.undoIncomplete).toBe(true);
		expect(status.problem?.errors[0]).toContain("candidate");
		expect(status.problem?.nextAttemptAt).toBe(96_000);
		expect(w.logs.at(-1)).toContain("undo attempt 1 incomplete");
		// Not retried before the backoff.
		w.at(95_999);
		expect(await w.owner.tick()).toBe(false);
		expect(w.logs).toHaveLength(1);
		w.at(96_000);
		await w.owner.tick();
		expect(w.logs.at(-1)).toContain("undo attempt 2");
		status = await w.owner.status();
		expect(status.problem?.nextAttemptAt).toBe(106_000);
		w.fake.fail.delete("remove");
		w.at(106_000);
		expect(await w.owner.tick()).toBe(true);
		status = await w.owner.status();
		expect(status.undoIncomplete).toBe(false);
		expect(status.problem).toBeNull();
	});

	it("caps the backoff at five minutes", () => {
		expect(undoBackoffMs(1)).toBe(5_000);
		expect(undoBackoffMs(2)).toBe(10_000);
		expect(undoBackoffMs(3)).toBe(20_000);
		expect(undoBackoffMs(20)).toBe(300_000);
	});
});

describe("the checkpoint is ours only with its creation stamp", () => {
	it("a foreign checkpoint reusing the journaled path is neither rolled back nor destroyed", async () => {
		const w = world();
		const creator = session("old", "eth0", 500);
		const pending = await w.owner.apply(creator, w.ethPlan, UNDO);
		if (pending.kind !== "pending") throw new Error("expected pending");
		const path = (await w.journal.read()).tx?.checkpoint as string;
		expect((await w.journal.read()).tx?.checkpointCreated).toBeDefined();
		// NetworkManager restarted and someone else got the same path.
		w.fake.restart();
		w.fake.foreignCheckpointAt(path);
		await expect(
			w.owner.confirm(pending.id, session("new", "eth0", 1_001)),
		).rejects.toThrow();
		expect(await w.owner.tick()).toBe(true);
		expect(w.fake.hasCheckpoint(path)).toBe(true);
		expect(w.fake.calls).not.toContain("rollback");
		expect(w.fake.calls).not.toContain("destroy");
		expect((await w.owner.status()).notice?.reason).toBe("restart");
	});
});

describe("notices say what actually happened", () => {
	it("a crash before the change was applied says it was never made", async () => {
		const w = world();
		// The process died right after the first journal write: the journal
		// still says "applying" and nothing was activated.
		const journal = await w.journal.read();
		journal.tx = {
			id: "11111111-2222-4333-8444-555555555555",
			bootId: "boot-1",
			state: "applying",
			mode: "undo-automatically",
			path: "own",
			creator: "old",
			devices: ["eth0"],
			startedAt: 1000,
			plan: w.ethPlan,
			profiles: [],
			effects: [],
		};
		await w.journal.write(journal);
		w.newBoot();
		expect(await w.restartBackend().reconcile("backend-start")).toBe("undone");
		expect((await w.owner.status()).notice).toMatchObject({
			reason: "interrupted",
			messageKey: "network.changeSafety.notice.interrupted",
		});
	});
});
