import { expect, test } from "bun:test";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";

// After a control-connection loss the local retirement ends this process's
// sender, so #124 refuses to adopt the still-streaming engine session. A
// session this same process launched is Stopped as its own; nothing else is.
function harness(opts: {
	readonly unownedSenderPresent?: boolean;
	readonly launched: boolean;
}) {
	let runtime: "idle" | "streaming" = "streaming";
	let ownedEvidence = false;
	let clock = 0;
	const stops: number[] = [];
	const stopCauses: string[] = [];
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => "loss",
		now: () => clock,
		lossStopWindowMs: 10_000,
		setStreamingStatus: () => {},
		initialLiveness: () => (opts.launched ? "idle" : "unknown"),
		queryRuntime: async () => runtime,
		canReconcileStreaming: () => ownedEvidence,
		canReconcileIdle: () => opts.unownedSenderPresent !== true,
		stopRuntime: async (generation) => {
			stops.push(generation);
			runtime = "idle";
		},
		retireRuntime: async () => {},
		onStreamStopped: (cause) => {
			stopCauses.push(cause);
		},
	});
	return {
		session,
		stops,
		stopCauses,
		runtime: () => runtime,
		setRuntime: (next: "idle" | "streaming") => {
			runtime = next;
		},
		setOwnedEvidence: (next: boolean) => {
			ownedEvidence = next;
		},
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

const launch = async () => ({ success: true }) as const;

test("a session this process launched is Stopped as its own after the loss", async () => {
	const h = harness({ launched: true });
	expect((await h.session.start({ origin: "ui", launch })).result).toBe(
		"started",
	);
	await h.session.retireLostSession();
	expect(h.session.streamLiveness()).toBe("unknown");

	expect(await h.session.reconcile()).toBe("idle");
	expect(h.stops).toHaveLength(1);
	expect(h.runtime()).toBe("idle");
	// The loss is the only stop cause, so an armed marker survives.
	expect(h.stopCauses).toEqual(["engine_loss"]);
});

test("a possible unowned sender keeps the lost session protected", async () => {
	const h = harness({ launched: true, unownedSenderPresent: true });
	await h.session.start({ origin: "ui", launch });
	await h.session.retireLostSession();

	expect(await h.session.reconcile()).toBe("reconciling");
	expect(h.session.streamLiveness()).toBe("unknown");
	expect(h.stops).toEqual([]);
});

test("without a loss in this process the engine session stays protected", async () => {
	const h = harness({ launched: false });
	expect(await h.session.reconcile()).toBe("reconciling");
	expect(h.stops).toEqual([]);
});

test("an operator Stop ends the loss record before a new Start", async () => {
	const h = harness({ launched: true });
	await h.session.start({ origin: "ui", launch });
	await h.session.retireLostSession();
	expect((await h.session.stop("operator")).result).toBe("stopped");
	expect(h.stops).toHaveLength(1);
	await h.session.start({ origin: "ui", launch });
	h.setRuntime("streaming");
	// #124 decides alone again: no owned evidence keeps it protected, no Stop.
	expect(await h.session.reconcile()).toBe("reconciling");
	expect(h.stops).toHaveLength(1);
});

test("a Start refused as busy during loss reconciliation keeps the recovery record", async () => {
	const h = harness({ launched: true });
	await h.session.start({ origin: "ui", launch });
	await h.session.retireLostSession();
	expect((await h.session.start({ origin: "ui", launch })).result).toBe("busy");

	expect(await h.session.reconcile()).toBe("idle");
	expect(h.stops).toHaveLength(1);
});

test("a lost observation-only connection gives no Stop authority", async () => {
	const h = harness({ launched: false });
	// Adopted on owned evidence, never launched by this process.
	h.setOwnedEvidence(true);
	expect(await h.session.reconcile()).toBe("streaming");
	h.setOwnedEvidence(false);
	await h.session.retireLostSession();

	expect(await h.session.reconcile()).toBe("reconciling");
	expect(h.stops).toEqual([]);
});

test("a confirmed idle engine expires the recovery record", async () => {
	const h = harness({ launched: true });
	await h.session.start({ origin: "ui", launch });
	await h.session.retireLostSession();
	h.setRuntime("idle");
	expect(await h.session.reconcile()).toBe("idle");
	expect(h.stops).toEqual([]);

	// A later session the engine runs is not the lost one.
	h.setRuntime("streaming");
	expect(await h.session.reconcile()).toBe("reconciling");
	expect(h.stops).toEqual([]);
});

test("the heartbeat after the restoration window leaves a streaming session protected", async () => {
	const h = harness({ launched: true });
	await h.session.start({ origin: "ui", launch });
	await h.session.retireLostSession();
	// Restoration has given up; the engine reports a streaming session later.
	h.advance(10_001);

	await h.session.reconcileLostSession(() => true);
	expect(h.stops).toEqual([]);
	expect(h.session.snapshot().state).toBe("reconciling");
	expect(h.session.streamLiveness()).toBe("unknown");
	// The record is gone, so no later heartbeat Stops either.
	await h.session.reconcileLostSession(() => true);
	expect(h.stops).toEqual([]);
});

test("the heal and heartbeat reconciliation Stops the lost own session within the window", async () => {
	const h = harness({ launched: true });
	await h.session.start({ origin: "ui", launch });
	await h.session.retireLostSession();
	h.advance(9_000);

	await h.session.reconcileLostSession(() => true);
	expect(h.stops).toHaveLength(1);
	expect(h.session.snapshot().state).toBe("idle");
	expect(h.session.streamLiveness()).toBe("idle");
	// The settled loss is not reconciled again.
	await h.session.reconcileLostSession(() => true);
	expect(h.stops).toHaveLength(1);
});
