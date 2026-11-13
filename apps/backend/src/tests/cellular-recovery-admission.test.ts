/*
    What a stream start may assume after it waited for recovery's cleanup hold
    on the lifecycle interlock, tested through the production wiring:

    S1  Nothing. Every admission gate (barrier, journal block, operator intent,
        duplicate start) is judged again at the instant the lease is taken.
    S2  Stop ends the wait at once and answers the start it interrupted; a
        timeout is never reported for a start the operator stopped.
    S3  An external start waits a bounded time; an internal origin (autostart,
        restoration) waits as long as it would for the barrier.
    S4  While a start waits, recovery does not take the interlock again, and a
        timed-out start never frees a lease that still protects cleanup.
    S5  A modem change keeps its immediate refusal: only recovery is waited for.
*/

import { afterEach, beforeEach, expect, test } from "bun:test";
import { resetCellularSourcesForTest } from "../modules/network/cellular-source-state.ts";
import {
	isLifecycleHeld,
	resetLifecycleInterlock,
	setMutationBlocks,
	tryAcquireCellularRecovery,
	tryAcquireLifecycle,
} from "../modules/streaming/lifecycle-admission.ts";
import {
	beginRecoveryBarrier,
	completeRecoveryBarrier,
	resetRecoveryBarrier,
} from "../modules/streaming/recovery-barrier.ts";
import {
	createStreamSessionOrchestrator,
	type StreamSessionOrchestratorDeps,
} from "../modules/streaming/stream-session-orchestrator.ts";

// Initialize the orchestrator before inspecting its production composition.
const { streamSessionProductionDeps: production } = await import(
	"../modules/streaming/stream-session-production.ts"
);

beforeEach(() => {
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	resetCellularSourcesForTest();
});
afterEach(() => {
	resetLifecycleInterlock();
	resetRecoveryBarrier();
});

/** A session behind the production admission gates. */
function session(extra: Partial<StreamSessionOrchestratorDeps> = {}) {
	if (!production.admitLifecycle)
		throw new Error("Production lifecycle wiring missing");
	const gates: Partial<StreamSessionOrchestratorDeps> = {};
	for (const name of [
		"admitLifecycle",
		"lifecycleWait",
		"awaitRecovery",
		"recoveryPending",
		"blockingMutation",
	] as const)
		if (production[name] !== undefined)
			Object.assign(gates, { [name]: production[name] });
	return createStreamSessionOrchestrator({
		...gates,
		createAttemptId: () => "attempt",
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		...extra,
	});
}
function recoveryHold() {
	const admission = tryAcquireCellularRecovery();
	if (!admission.admitted) throw new Error("fixture lease");
	return admission.lease;
}
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
/** Settles with the value, or "pending" when it has not settled in time. */
function within<T>(promise: Promise<T>, ms = 500): Promise<T | "pending"> {
	return Promise.race([
		promise,
		new Promise<"pending">((resolve) => setTimeout(resolve, ms, "pending")),
	]);
}
function launch(flag: { launched: boolean }) {
	return async () => {
		flag.launched = true;
	};
}

test("S3: boot autostart waits for recovery cleanup instead of losing its one-shot start", async () => {
	const hold = recoveryHold(),
		flag = { launched: false },
		streams = session();
	const start = streams.start({ origin: "autostart", launch: launch(flag) });
	await tick();
	expect(flag.launched).toBe(false);
	expect(
		(
			await streams.start({
				origin: "ui",
				launch: async () => {
					throw new Error("Duplicate launch");
				},
			})
		).result,
	).toBe("busy");
	hold.release();
	expect((await start).result).toBe("started");
	expect(flag.launched).toBe(true);
});

test("S3: an internal origin outlasts the external limit, and an external start is refused at it", async () => {
	const hold = recoveryHold(),
		flag = { launched: false },
		streams = session({ lifecycleWaitMs: 20 });
	const boot = streams.start({ origin: "autostart", launch: launch(flag) });
	expect(await within(boot, 120)).toBe("pending");
	expect(flag.launched).toBe(false);
	hold.release();
	expect((await boot).result).toBe("started");
	await streams.stop("operator");

	const second = recoveryHold(),
		other = { launched: false };
	const external = await within(
		streams.start({ origin: "ui", launch: launch(other) }),
	);
	if (external === "pending") throw new Error("external start never settled");
	expect(external.result).toBe("failed");
	if (external.result === "failed")
		expect(external.failure.class).toBe("modem_transition_active");
	expect(other.launched).toBe(false);
	// S4: the refusal took nothing from the cleanup that still runs.
	expect(isLifecycleHeld()).toBe(true);
	second.release();
	expect(isLifecycleHeld()).toBe(false);
});

test("S1: a barrier raised during the wait refuses an external start", async () => {
	const hold = recoveryHold(),
		flag = { launched: false },
		streams = session();
	const start = streams.start({ origin: "ui", launch: launch(flag) });
	await tick();
	beginRecoveryBarrier();
	hold.release();
	const result = await start;
	expect(flag.launched).toBe(false);
	expect(result.result).toBe("failed");
	if (result.result === "failed")
		expect(result.failure.class).toBe("recovery_pending");
});

test("S1: a barrier raised during the wait holds an internal start until it lowers", async () => {
	const hold = recoveryHold(),
		flag = { launched: false },
		streams = session();
	const start = streams.start({ origin: "restoration", launch: launch(flag) });
	await tick();
	beginRecoveryBarrier();
	hold.release();
	expect(await within(start, 60)).toBe("pending");
	expect(flag.launched).toBe(false);
	expect(completeRecoveryBarrier()).toBe(true);
	expect((await start).result).toBe("started");
	expect(flag.launched).toBe(true);
});

test("S1: a journal block that appears during the wait refuses the start", async () => {
	const hold = recoveryHold(),
		flag = { launched: false },
		streams = session();
	const start = streams.start({ origin: "ui", launch: launch(flag) });
	await tick();
	setMutationBlocks([
		{
			stableKey: "blocked-during-wait",
			refusal: "mutation_blocked",
			blocksStreaming: true,
		},
	]);
	hold.release();
	const result = await start;
	expect(flag.launched).toBe(false);
	expect(result.result).toBe("failed");
	if (result.result === "failed") {
		expect(result.failure.class).toBe("mutation_blocked");
		expect(result.failure.code).toBe("blocked-during-wait");
	}
});

test("S1: a barrier raised while the engine state is read refuses the start at the admission point", async () => {
	const flag = { launched: false };
	let queried = 0;
	const streams = session({
		// After a backend restart the first start reads the engine's state
		// before it can be admitted.
		initialLiveness: "unknown",
		queryRuntime: async () => {
			queried++;
			beginRecoveryBarrier();
			return "idle";
		},
	});
	const result = await streams.start({ origin: "ui", launch: launch(flag) });
	expect(queried).toBeGreaterThan(0);
	expect(flag.launched).toBe(false);
	expect(result.result).toBe("failed");
	if (result.result === "failed")
		expect(result.failure.class).toBe("recovery_pending");
	expect(isLifecycleHeld()).toBe(false);
});

test("S2: a wait that reports a timeout after Stop still answers cancelled", async () => {
	const hold = recoveryHold(),
		flag = { launched: false };
	let expire: (() => void) | undefined;
	const streams = session({
		// A waiter that cannot be cancelled: only its own timeout ends it.
		lifecycleWait: () => ({
			wait: () =>
				new Promise((resolve) => {
					expire = () => resolve("timeout");
				}),
			cancel: () => {},
			done: () => {},
		}),
	});
	const start = streams.start({ origin: "ui", launch: launch(flag) });
	await tick();
	await streams.stop("operator");
	expire?.();
	expect((await start).result).toBe("cancelled");
	expect(flag.launched).toBe(false);
	hold.release();
});

test("S2: Stop during the recovery wait cancels the queued start", async () => {
	const hold = recoveryHold(),
		flag = { launched: false },
		streams = session();
	const start = streams.start({ origin: "autostart", launch: launch(flag) });
	await tick();
	await streams.stop("operator");
	hold.release();
	expect((await start).result).toBe("cancelled");
	expect(flag.launched).toBe(false);
});

test("S2: Start, Stop, Start — the first is cancelled at once and the second takes its place", async () => {
	const hold = recoveryHold(),
		first = { launched: false },
		second = { launched: false },
		streams = session({ lifecycleWaitMs: 2000 });
	const one = streams.start({ origin: "ui", launch: launch(first) });
	await tick();
	await streams.stop("operator");
	const two = streams.start({ origin: "ui", launch: launch(second) });
	// Cleanup still holds the interlock: neither answer may wait for it.
	const cancelled = await within(one, 200);
	if (cancelled === "pending") throw new Error("Stop did not end the wait");
	expect(cancelled.result).toBe("cancelled");
	expect(await within(two, 50)).toBe("pending");
	hold.release();
	expect((await two).result).toBe("started");
	expect(first.launched).toBe(false);
	expect(second.launched).toBe(true);
});

test("S4: recovery cannot retake the interlock ahead of a waiting start", async () => {
	const hold = recoveryHold(),
		flag = { launched: false },
		streams = session();
	const start = streams.start({ origin: "ui", launch: launch(flag) });
	await tick();
	hold.release();
	expect(tryAcquireCellularRecovery().admitted).toBe(false);
	expect((await start).result).toBe("started");
	await streams.stop("operator");
	const later = tryAcquireCellularRecovery();
	expect(later.admitted).toBe(true);
	if (later.admitted) later.lease.release();
});

test("S5: ordinary modem mutations retain their immediate refusal semantics", async () => {
	const lease = tryAcquireLifecycle("modem-transition");
	if (!lease.admitted) throw new Error("fixture lease");
	const flag = { launched: false },
		streams = session();
	const result = await within(
		streams.start({ origin: "autostart", launch: launch(flag) }),
		100,
	);
	if (result === "pending") throw new Error("a modem change was waited for");
	expect(result.result).toBe("failed");
	if (result.result === "failed")
		expect(result.failure.class).toBe("modem_transition_active");
	expect(flag.launched).toBe(false);
	lease.lease.release();
});
