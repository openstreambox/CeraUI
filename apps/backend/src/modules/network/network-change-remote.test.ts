/**
 * The second round of the network-change owner: sessions that cannot confirm
 * (no arrival evidence), and the limits the first review left open (queueing
 * instead of "busy", undo backoff, checkpoint identity, notice reasons).
 */
import { describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEffectRegistry } from "./network-change-effects.ts";
import { createFileJournalStore } from "./network-change-journal.ts";
import {
	createFakeNm,
	fakeReachability,
	harness,
	plan,
	session,
} from "./network-change-test-fakes.ts";
import {
	createNetworkChangeOwner,
	NetworkChangeInFlightError,
	undoBackoffMs,
} from "./network-checkpoint.ts";

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

/** A tailnet session riding eth0: the one transport the box can test. */
const tailnetPeer = session("tailnet", undefined, 500, {
	carriers: ["eth0"],
	tunnel: true,
	tailnetPeer: "100.101.102.103",
});
/** A session through a local proxy: no testable transport. */
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
		await expect(w.owner.apply(tailnetPeer, w.ethPlan, REACH)).rejects.toThrow(
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
			w.owner.apply(tailnetPeer, w.ethPlan, REACH),
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
	it("only a session with a testable path to its own device is offered it", async () => {
		const probe = fakeReachability();
		const w = world({ reachability: probe.deps });
		// A proxied or relayed session: the box can't test the way back to it.
		const proxied = await w.owner.apply(relayOverEth, w.ethPlan);
		expect(proxied).toMatchObject({
			primary: {
				answer: "undo-automatically",
				labelKey: "network.changeSafety.askBefore.undoVia",
			},
			deliberate: { answer: "keep-change" },
		});
		expect(proxied).not.toHaveProperty("alternative");
		await expect(w.owner.apply(relayOverEth, w.ethPlan, REACH)).rejects.toThrow(
			"Reachability check unavailable",
		);
		expect(await w.owner.apply(tailnetPeer, w.ethPlan)).toMatchObject({
			primary: { answer: "keep-if-reachable" },
			alternative: { answer: "undo-automatically" },
		});
		// tailscaled not available: not offered either.
		probe.state.available = false;
		expect(await w.owner.apply(tailnetPeer, w.ethPlan)).toMatchObject({
			primary: { answer: "undo-automatically" },
		});
		expect(w.fake.calls).toEqual([]);
	});

	it("probes the requester recorded in the transaction, nothing else", async () => {
		const probe = fakeReachability(true);
		const w = world({ reachability: probe.deps });
		await w.owner.apply(tailnetPeer, w.ethPlan, REACH);
		expect((await w.journal.read()).tx?.reachability).toEqual({
			kind: "tailnet-peer",
			peer: "100.101.102.103",
		});
		w.at(16_001);
		await w.owner.tick();
		// A backend restart reads the requester back from the journal.
		const next = w.restartBackend();
		w.at(21_001);
		await next.tick();
		w.at(26_001);
		expect(await next.tick()).toBe(true);
		expect(probe.state.peers).toEqual([
			"100.101.102.103",
			"100.101.102.103",
			"100.101.102.103",
		]);
	});

	it("a socket the front door once placed on the changed port is refused, even with stale evidence", async () => {
		const w = world({ reachability: fakeReachability().deps });
		const stale = { ...tailnetPeer, capturedIngress: "eth0" };
		await expect(w.owner.apply(stale, w.ethPlan, REACH)).rejects.toThrow(
			"Reachability check unavailable",
		);
		expect(w.fake.calls).toEqual([]);
	});

	it("a new session over the changed port may still confirm it: the stronger evidence wins", async () => {
		const w = world({ reachability: fakeReachability(false).deps });
		const pending = await w.owner.apply(tailnetPeer, w.ethPlan, REACH);
		if (pending.kind !== "pending") throw new Error("expected pending");
		await w.owner.confirm(pending.id, session("laptop", "eth0", 1_001));
		expect(w.fake.calls).toContain("destroy");
		expect(w.fake.calls).toContain("persist:Wired");
	});

	it("is checkpointed like any protected change, and an unknown session cannot confirm it", async () => {
		const probe = fakeReachability(false);
		const w = world({ reachability: probe.deps });
		const pending = await w.owner.apply(tailnetPeer, w.ethPlan, REACH);
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
		await w.owner.apply(tailnetPeer, w.ethPlan, REACH);
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
		await w.owner.apply(tailnetPeer, w.ethPlan, REACH);
		for (const t of [16_001, 21_001, 26_001]) {
			w.at(t);
			expect(await w.owner.tick()).toBe(false);
		}
		expect(w.fake.calls).not.toContain("destroy");
	});

	it("never commits after NetworkManager's own timer undid the change", async () => {
		const probe = fakeReachability(true);
		const w = world({ reachability: probe.deps });
		await w.owner.apply(tailnetPeer, w.ethPlan, REACH);
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
		await w.owner.apply(tailnetPeer, w.ethPlan, REACH);
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
		await w.owner.apply(tailnetPeer, w.ethPlan, REACH);
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
		let entered: () => void = () => {};
		const inside = new Promise<void>((resolve) => {
			entered = resolve;
		});
		w.fake.nm.live = async (ref) => {
			if (first) {
				first = false;
				entered();
				await gate;
			}
			return live(ref);
		};
		const tick = w.owner.tick();
		// The tick is inside NetworkManager now; only then does confirm arrive.
		await inside;
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

describe("checkpoint operations are pinned to the daemon that made them", () => {
	it("a daemon restart at the destroy boundary never lets the change be promoted", async () => {
		const w = world();
		const pending = await w.owner.apply(
			session("old", "eth0", 500),
			w.ethPlan,
			UNDO,
		);
		if (pending.kind !== "pending") throw new Error("expected pending");
		const path = (await w.journal.read()).tx?.checkpoint as string;
		const destroy = w.fake.nm.destroy;
		w.fake.nm.destroy = async (ref) => {
			// NetworkManager restarts and a new checkpoint takes the same path
			// between the liveness check and the destroy call.
			w.fake.restart();
			w.fake.foreignCheckpointAt(path);
			await destroy(ref);
		};
		await expect(
			w.owner.confirm(pending.id, session("new", "eth0", 1_001)),
		).rejects.toThrow("unknown bus name");
		expect(w.fake.calls).not.toContain("persist:Wired");
		w.fake.nm.destroy = destroy;
		expect(await w.owner.tick()).toBe(true);
		// The foreign checkpoint is untouched, the change is undone.
		expect(w.fake.hasCheckpoint(path)).toBe(true);
		expect(w.fake.calls).not.toContain("rollback");
		expect(w.fake.byId("Wired")[0]?.[1].settings["ipv4.method"]).toBe("auto");
	});

	it("the same holds for a keep-if-reachable commit", async () => {
		const w = world({ reachability: fakeReachability().deps });
		await w.owner.apply(tailnetPeer, w.ethPlan, REACH);
		const path = (await w.journal.read()).tx?.checkpoint as string;
		const destroy = w.fake.nm.destroy;
		w.fake.nm.destroy = async (ref) => {
			w.fake.restart();
			w.fake.foreignCheckpointAt(path);
			await destroy(ref);
		};
		w.at(16_001);
		await w.owner.tick();
		w.at(21_001);
		await expect(w.owner.tick()).rejects.toThrow("unknown bus name");
		expect(w.fake.calls).not.toContain("persist:Wired");
		expect(w.fake.hasCheckpoint(path)).toBe(true);
	});

	it("a checkpoint without a complete identity is refused before any profile is touched", async () => {
		const w = world();
		const create = w.fake.nm.create;
		w.fake.nm.create = async (devices, timeout) => {
			const ref = await create(devices, timeout);
			return { ...ref, created: "" };
		};
		await expect(
			w.owner.apply(session("old", "eth0", 500), w.ethPlan, UNDO),
		).rejects.toThrow("identity");
		expect(w.fake.calls.some((c) => c.startsWith("clone"))).toBe(false);
	});

	it("an old record without an identity is undone without any path-only call", async () => {
		const w = world();
		await w.owner.apply(session("old", "eth0", 500), w.ethPlan, UNDO);
		const journal = await w.journal.read();
		const tx = journal.tx as NonNullable<typeof journal.tx>;
		delete tx.checkpointOwner;
		delete tx.checkpointCreated;
		await w.journal.write(journal);
		const before = w.fake.calls.length;
		expect(await w.owner.tick()).toBe(true);
		const after = w.fake.calls.slice(before);
		expect(after).not.toContain("rollback");
		expect(after).not.toContain("destroy");
		expect(w.fake.byId("Wired")[0]?.[1].settings["ipv4.method"]).toBe("auto");
		expect(w.fake.active.get("eth0")).toBe(w.eth);
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

describe("journal reset runs inside the owner", () => {
	function fileOwner() {
		const dir = mkdtempSync(join(tmpdir(), "nc-owner-"));
		const path = join(dir, "journal.json");
		const fake = createFakeNm();
		const owner = createNetworkChangeOwner({
			now: () => 1000,
			bootId: async () => "boot-1",
			nm: fake.nm,
			effects: createEffectRegistry([]),
			journal: createFileJournalStore(path),
		});
		return { dir, path, fake, owner };
	}

	it("moves only a journal that still fails to read, and sweeps leftover candidates", async () => {
		const f = fileOwner();
		writeFileSync(f.path, "{not json");
		const uuid = f.fake.add("ceralive-candidate-0123abcd-0", {});
		const { movedTo } = await f.owner.resetDamagedJournal();
		expect(movedTo.startsWith(`${f.path}.damaged-`)).toBe(true);
		expect(existsSync(f.path)).toBe(false);
		expect(readFileSync(movedTo, "utf8")).toBe("{not json");
		expect(f.fake.profiles.has(uuid)).toBe(false);
		rmSync(f.dir, { recursive: true, force: true });
	});

	it("a well-formed wrapper around a broken transaction is damaged, not readable", async () => {
		const f = fileOwner();
		writeFileSync(
			f.path,
			JSON.stringify({
				version: 1,
				notice: null,
				tx: { id: "x", state: "pending", mode: "undo-automatically" },
			}),
			{ mode: 0o600 },
		);
		await expect(f.owner.status()).rejects.toThrow("unavailable");
		await f.owner.resetDamagedJournal();
		expect((await f.owner.status()).pending).toBeNull();
		rmSync(f.dir, { recursive: true, force: true });
	});

	it("two resets at once move the damaged journal once and refuse the rest", async () => {
		const f = fileOwner();
		writeFileSync(f.path, "{not json");
		const results = await Promise.allSettled([
			f.owner.resetDamagedJournal(),
			f.owner.resetDamagedJournal(),
		]);
		expect(results.map((r) => r.status).sort()).toEqual([
			"fulfilled",
			"rejected",
		]);
		const refused = results.find((r) => r.status === "rejected") as
			| PromiseRejectedResult
			| undefined;
		// After the first move nothing is left to read as damaged.
		expect(String(refused?.reason)).toMatch(/readable/);
		rmSync(f.dir, { recursive: true, force: true });
	});

	it("a readable journal, with a change in flight, is never moved", async () => {
		const f = fileOwner();
		const eth = f.fake.add("Wired", { "ipv4.method": "auto" });
		f.fake.active.set("eth0", eth);
		await f.owner.apply(
			session("old", "eth0", 500),
			plan({
				devices: ["eth0"],
				profiles: [
					{ uuid: eth, set: [["ipv4.method", "shared"]], activateOn: "eth0" },
				],
			}),
			UNDO,
		);
		await expect(f.owner.resetDamagedJournal()).rejects.toThrow("readable");
		expect((await f.owner.status()).pending).not.toBeNull();
		rmSync(f.dir, { recursive: true, force: true });
	});
});

describe("the rest of the review's limits", () => {
	it("an apply during an undo's backoff is refused as in flight, without a retry", async () => {
		const w = world();
		await w.owner.apply(session("old", "eth0", 500), w.ethPlan, UNDO);
		w.fake.fail.add("remove");
		await w.fake.expireAll();
		w.at(91_000);
		await w.owner.tick();
		expect(w.logs).toHaveLength(1);
		const other = plan({ devices: ["eth1"], profiles: [] });
		for (let i = 0; i < 5; i++) {
			const error = await w.owner
				.apply(session("x", "wlan0", 500), { ...other, effects: [] }, UNDO)
				.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(NetworkChangeInFlightError);
		}
		// Still only the one attempt: the applies did not retry the undo.
		expect(w.logs).toHaveLength(1);
	});

	it("a change still pending is refused with the typed in-flight error", async () => {
		const w = world();
		await w.owner.apply(session("old", "eth0", 500), w.ethPlan, UNDO);
		const error = await w.owner
			.apply(session("old", "eth0", 500), w.ethPlan, UNDO)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(NetworkChangeInFlightError);
	});

	it("a notice answered meanwhile refuses a re-apply that carries its id", async () => {
		const w = world();
		await w.owner.apply(session("s", "eth0", 500), w.ethPlan, UNDO);
		await w.fake.expireAll();
		w.at(91_000);
		await w.owner.tick();
		const notice = (await w.owner.status()).notice;
		if (!notice) throw new Error("expected notice");
		await w.owner.leaveUndone(notice.id, session("phone", "wlan0"));
		await expect(
			w.owner.apply(session("s", "wlan0", 500), w.ethPlan, {
				...UNDO,
				deliberate: true,
				noticeId: notice.id,
			}),
		).rejects.toThrow("already answered");
		expect(w.fake.calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
	});

	it("a re-apply carrying the notice id consumes it in the same write", async () => {
		const w = world();
		await w.owner.apply(session("s", "eth0", 500), w.ethPlan, UNDO);
		await w.fake.expireAll();
		w.at(91_000);
		await w.owner.tick();
		const notice = (await w.owner.status()).notice;
		if (!notice) throw new Error("expected notice");
		const result = await w.owner.apply(session("s", "wlan0", 500), w.ethPlan, {
			...UNDO,
			deliberate: true,
			noticeId: notice.id,
		});
		expect(result.kind).toBe("pending");
		expect((await w.owner.status()).notice).toBeNull();
	});

	it("an owner call from inside a settle handler is refused instead of waiting for itself", async () => {
		let nested: unknown;
		let ownerRef:
			| {
					leaveUndone: (
						id: string,
						s: ReturnType<typeof session>,
					) => Promise<void>;
			  }
			| undefined;
		const w = world({
			onSettled: async () => {
				nested = await ownerRef
					?.leaveUndone("n", session("x", "eth0"))
					.catch((e: unknown) => e);
			},
		});
		ownerRef = w.owner;
		const pending = await w.owner.apply(
			session("old", "eth0", 500),
			w.ethPlan,
			UNDO,
		);
		if (pending.kind !== "pending") throw new Error("expected pending");
		await w.owner.confirm(pending.id, session("new", "eth0", 1_001));
		expect(String(nested)).toMatch(/Nested network change/);
	});

	it("a deadline that passed while the backend was down is not called a restart", async () => {
		const w = world();
		await w.owner.apply(session("old", "eth0", 500), w.ethPlan, UNDO);
		// NetworkManager's timer fired while the backend was down; same boot.
		await w.fake.expireAll();
		w.at(120_000);
		expect(await w.restartBackend().reconcile("backend-start")).toBe("undone");
		expect((await w.owner.status()).notice?.reason).toBe("disconnected");
	});
});
