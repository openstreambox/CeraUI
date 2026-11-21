/**
 * The network-change owner for remote sessions (no arrival evidence), and the
 * limits the earlier reviews left open (queueing instead of "busy", undo
 * backoff, checkpoint identity, notice reasons, journal validation).
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
	browser,
	CODE,
	createFakeNm,
	harness,
	plan,
	session,
} from "./network-change-test-fakes.ts";
import {
	createNetworkChangeOwner,
	NetworkChangeInFlightError,
	undoBackoffMs,
} from "./network-checkpoint.ts";

const UNDO = {
	answer: "undo-automatically",
	confirmationCode: CODE,
} as const;
/** The requester's browser, and a new connection of it after the settle time. */
const creator = browser("old", { ingress: "eth0", openedAt: 500 });
const back = browser("new", { ingress: "eth0", openedAt: 16_001 });

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

/** A remote browser through a local proxy, riding eth0. */
const relayOverEth = browser("relay", {
	openedAt: 500,
	route: { carriers: ["eth0"], tunnel: true },
});

describe("before applying: does the change cut the requesting session?", () => {
	it("route evidence names the cut, but never skips the prompt", async () => {
		const w = world();
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

	it("a remote browser can confirm, so it is told this browser confirms", async () => {
		const w = world();
		const ask = await w.owner.apply(relayOverEth, w.ethPlan);
		expect(ask).toMatchObject({
			canConfirm: true,
			primary: {
				answer: "undo-automatically",
				labelKey: "network.changeSafety.askBefore.undo",
			},
			deliberate: { labelKey: "network.changeSafety.askBefore.keepRemote" },
		});
		// The automatic keep from an earlier design is not an answer any more.
		await expect(
			w.owner.apply(relayOverEth, w.ethPlan, {
				answer: "keep-if-reachable" as never,
			}),
		).rejects.toThrow("Unknown answer");
		expect(w.fake.calls).toEqual([]);
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

describe("one operation at a time, without 'busy' refusals", () => {
	it("a confirmation that lands during a tick waits for it and succeeds", async () => {
		const w = world();
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
		w.at(17_000);
		const tick = w.owner.tick();
		// The tick is inside NetworkManager now; only then does confirm arrive.
		await inside;
		const confirm = w.owner.confirm(pending.id, CODE, back);
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
		const apply = w.owner.apply(creator, w.ethPlan, UNDO);
		await Promise.resolve();
		expect(await w.owner.tick()).toBe(false);
		release();
		expect((await apply).kind).toBe("pending");
	});

	it("a tick in the same turn as a queued request skips, before the request starts", async () => {
		const w = world();
		let reads = 0;
		const read = w.journal.read;
		w.journal.read = async () => {
			reads++;
			return read();
		};
		// Both calls are made before either runs: the apply is only queued.
		const apply = w.owner.apply(creator, w.ethPlan, UNDO);
		const tick = w.owner.tick();
		expect(await tick).toBe(false);
		expect((await apply).kind).toBe("pending");
		// Only the apply read the journal; the tick never entered the queue.
		expect(reads).toBe(1);
		// And two ticks in one turn run once.
		reads = 0;
		await Promise.all([w.owner.tick(), w.owner.tick()]);
		expect(reads).toBe(1);
	});
});

describe("an undo that keeps failing backs off and says so", () => {
	it("retries after 5, 10, 20 s and logs each attempt", async () => {
		const w = world();
		await w.owner.apply(creator, w.ethPlan, UNDO);
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
		const pending = await w.owner.apply(creator, w.ethPlan, UNDO);
		if (pending.kind !== "pending") throw new Error("expected pending");
		const path = (await w.journal.read()).tx?.checkpoint as string;
		expect((await w.journal.read()).tx?.checkpointCreated).toBeDefined();
		// NetworkManager restarted and someone else got the same path.
		w.fake.restart();
		w.fake.foreignCheckpointAt(path);
		await expect(w.owner.confirm(pending.id, CODE, back)).rejects.toThrow();
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
		const pending = await w.owner.apply(creator, w.ethPlan, UNDO);
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
		await expect(w.owner.confirm(pending.id, CODE, back)).rejects.toThrow(
			"unknown bus name",
		);
		expect(w.fake.calls).not.toContain("persist:Wired");
		w.fake.nm.destroy = destroy;
		expect(await w.owner.tick()).toBe(true);
		// The foreign checkpoint is untouched, the change is undone.
		expect(w.fake.hasCheckpoint(path)).toBe(true);
		expect(w.fake.calls).not.toContain("rollback");
		expect(w.fake.byId("Wired")[0]?.[1].settings["ipv4.method"]).toBe("auto");
	});

	it("a checkpoint without a complete identity is refused before any profile is touched", async () => {
		const w = world();
		const create = w.fake.nm.create;
		w.fake.nm.create = async (devices, timeout) => {
			const ref = await create(devices, timeout);
			return { ...ref, created: "" };
		};
		await expect(w.owner.apply(creator, w.ethPlan, UNDO)).rejects.toThrow(
			"identity",
		);
		expect(w.fake.calls.some((c) => c.startsWith("clone"))).toBe(false);
	});

	it("an old record without an identity is undone without any path-only call", async () => {
		const w = world();
		await w.owner.apply(creator, w.ethPlan, UNDO);
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

describe("a record without the bus instance id names no checkpoint", () => {
	it("is undone without any checkpoint call", async () => {
		const w = world();
		await w.owner.apply(creator, w.ethPlan, UNDO);
		const journal = await w.journal.read();
		const tx = journal.tx as NonNullable<typeof journal.tx>;
		delete tx.checkpointBus;
		await w.journal.write(journal);
		const before = w.fake.calls.length;
		expect(await w.owner.tick()).toBe(true);
		const after = w.fake.calls.slice(before);
		expect(after).not.toContain("rollback");
		expect(after).not.toContain("destroy");
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
			creator,
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

describe("the journal is validated as deeply as it is used", () => {
	function stored(tx: Record<string, unknown>) {
		const dir = mkdtempSync(join(tmpdir(), "nc-journal-"));
		const path = join(dir, "journal.json");
		writeFileSync(path, JSON.stringify({ version: 1, notice: null, tx }), {
			mode: 0o600,
		});
		return { dir, store: createFileJournalStore(path) };
	}
	async function written() {
		const w = world();
		await w.owner.apply(creator, w.ethPlan, UNDO);
		return (await w.journal.read()).tx as unknown as Record<string, unknown>;
	}

	it("a journal written by a real apply reads back", async () => {
		const tx = await written();
		const f = stored(tx);
		expect((await f.store.read()).tx?.challenge?.host).toBe(
			"box.example.ts.net",
		);
		rmSync(f.dir, { recursive: true, force: true });
	});

	it("refuses present fields of the wrong shape and a pending change without its deadline", async () => {
		const tx = await written();
		for (const broken of [
			{ ...tx, expiresAt: "later" },
			{ ...tx, appliedAt: undefined },
			{ ...tx, expiresAt: undefined },
			{ ...tx, expiresClock: -1 },
			{ ...tx, checkpointBus: 7 },
			{ ...tx, undoReason: "elsewhere" },
			{ ...tx, mode: "keep-somehow" },
			{ ...tx, challenge: { ...(tx.challenge as object), codeHash: "x" } },
			// A one-element array around a valid digest is not a digest.
			{
				...tx,
				challenge: {
					...(tx.challenge as object),
					codeHash: ["a".repeat(64)],
				},
			},
			// A checkpoint identity the adapter would refuse on every tick.
			{ ...tx, checkpoint: "/not/a/checkpoint" },
			{ ...tx, checkpointOwner: "org.freedesktop.NetworkManager" },
			{ ...tx, checkpointCreated: "0" },
			{ ...tx, checkpointBus: "XYZ" },
			// Identity parts without the checkpoint path.
			{ ...tx, checkpoint: undefined },
			// A challenge on a change that has no undo.
			{ ...tx, mode: "keep-change", state: "kept" },
			{ ...tx, challenge: { ...(tx.challenge as object), origin: "" } },
			{ ...tx, confirmedVia: 3 },
			{
				...tx,
				profiles: [{ ...(tx.profiles as object[])[0], promoted: "yes" }],
			},
		]) {
			const f = stored(broken);
			await expect(f.store.read()).rejects.toThrow("unavailable");
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	it("a pending profile change without its checkpoint is refused; an effect-only one is fine", async () => {
		const tx = await written();
		for (const key of [
			"checkpoint",
			"checkpointOwner",
			"checkpointCreated",
			"checkpointBus",
		])
			delete tx[key];
		const profileOnly = stored(tx);
		await expect(profileOnly.store.read()).rejects.toThrow("unavailable");
		rmSync(profileOnly.dir, { recursive: true, force: true });
		const effectOnly = stored({
			...tx,
			plan: { ...(tx.plan as object), profiles: [] },
		});
		expect((await effectOnly.store.read()).tx?.state).toBe("pending");
		rmSync(effectOnly.dir, { recursive: true, force: true });
	});

	it("a journal left by the automatic-keep preview reads as its nearest current meaning", async () => {
		const tx = await written();
		delete tx.challenge;
		const f = stored({
			...tx,
			mode: "keep-if-reachable",
			undoReason: "unreachable",
			reachability: { kind: "tailnet-peer", peer: "100.64.0.1" },
		});
		const journal = await f.store.read();
		expect(journal.tx?.mode).toBe("undo-automatically");
		expect(journal.tx?.undoReason).toBe("disconnected");
		expect(journal.tx).not.toHaveProperty("reachability");
		rmSync(f.dir, { recursive: true, force: true });
		// A settled notice of that reason: readable, so role writes still work.
		const dir = mkdtempSync(join(tmpdir(), "nc-journal-"));
		const path = join(dir, "journal.json");
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				tx: null,
				notice: {
					id: "n1",
					reason: "unreachable",
					createdAt: 5,
					plan: plan({ devices: ["eth0"] }),
				},
			}),
			{ mode: 0o600 },
		);
		const read = await createFileJournalStore(path).read();
		expect(read.notice?.reason).toBe("disconnected");
		rmSync(dir, { recursive: true, force: true });
	});

	it("an older record without a checkpoint identity or boot-clock stamps still reads", async () => {
		const tx = await written();
		for (const key of [
			"checkpointOwner",
			"checkpointCreated",
			"checkpointBus",
			"startedClock",
			"appliedClock",
			"expiresClock",
			"challenge",
		])
			delete tx[key];
		const f = stored(tx);
		expect((await f.store.read()).tx?.state).toBe("pending");
		rmSync(f.dir, { recursive: true, force: true });
	});
});

describe("the rest of the review's limits", () => {
	it("an apply during an undo's backoff is refused as in flight, without a retry", async () => {
		const w = world();
		await w.owner.apply(creator, w.ethPlan, UNDO);
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
		await w.owner.apply(creator, w.ethPlan, UNDO);
		const error = await w.owner
			.apply(creator, w.ethPlan, UNDO)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(NetworkChangeInFlightError);
	});

	it("a notice answered meanwhile refuses a re-apply that carries its id", async () => {
		const w = world();
		await w.owner.apply(creator, w.ethPlan, UNDO);
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
		await w.owner.apply(creator, w.ethPlan, UNDO);
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
		const pending = await w.owner.apply(creator, w.ethPlan, UNDO);
		if (pending.kind !== "pending") throw new Error("expected pending");
		await w.owner.confirm(pending.id, CODE, back);
		expect(String(nested)).toMatch(/Nested network change/);
	});

	it("a deadline that passed while the backend was down is not called a restart", async () => {
		const w = world();
		await w.owner.apply(creator, w.ethPlan, UNDO);
		// NetworkManager's timer fired while the backend was down; same boot.
		await w.fake.expireAll();
		w.at(120_000);
		expect(await w.restartBackend().reconcile("backend-start")).toBe("undone");
		expect((await w.owner.status()).notice?.reason).toBe("disconnected");
	});
});
