import { afterEach, expect, test } from "bun:test";
import { setForwardActive } from "../modules/streaming/forward-activity.ts";
import {
	resetLifecycleInterlock,
	STREAMING_ACTIVE,
	setMutationBlocks,
	tryAcquireLifecycle,
	tryAcquireModemMutation,
} from "../modules/streaming/lifecycle-admission.ts";
import {
	beginRecoveryBarrier,
	resetRecoveryBarrier,
} from "../modules/streaming/recovery-barrier.ts";
import {
	currentStartLock,
	READINESS_RECOVERY_PENDING,
} from "../modules/streaming/stream-readiness.ts";

// The lock check against the real interlock state Start reads, not stubs.

afterEach(() => {
	setForwardActive(false);
	resetLifecycleInterlock();
	resetRecoveryBarrier();
});

test("an idle box has no lock", () => {
	expect(currentStartLock()).toEqual({ state: "ok" });
});

test("a per-device modem lease without a journal hold blocks, as Start refuses it", () => {
	const lease = tryAcquireModemMutation("modem-1");
	expect(lease.admitted).toBe(true);
	const lock = currentStartLock();
	expect(lock).toEqual({ state: "blocked", code: "MODEM_TRANSITION_ACTIVE" });
	// Start's own admission gives the same answer.
	const admission = tryAcquireLifecycle("streaming");
	expect(admission.admitted).toBe(false);
	if (!admission.admitted) expect(admission.refusal).toBe(lock.code);
});

test("an established forward blocks with the interlock's code", () => {
	setForwardActive(true);
	expect(currentStartLock()).toEqual({
		state: "blocked",
		code: STREAMING_ACTIVE,
	});
});

test("a start already holding the interlock blocks", () => {
	const lease = tryAcquireLifecycle("streaming");
	expect(lease.admitted).toBe(true);
	expect(currentStartLock().state).toBe("blocked");
});

test("recovery wins over a journal hold and a lease, as in Start", () => {
	setMutationBlocks([
		{
			stableKey: "modem-1",
			refusal: "mutation_in_progress",
			blocksStreaming: true,
		},
	]);
	tryAcquireModemMutation("modem-2");
	beginRecoveryBarrier();
	expect(currentStartLock()).toEqual({
		state: "blocked",
		code: READINESS_RECOVERY_PENDING,
	});
	resetRecoveryBarrier();
	expect(currentStartLock()).toEqual({
		state: "blocked",
		code: "mutation_in_progress",
	});
});

test("previewing never takes the interlock", () => {
	currentStartLock();
	currentStartLock();
	expect(tryAcquireLifecycle("streaming").admitted).toBe(true);
});
