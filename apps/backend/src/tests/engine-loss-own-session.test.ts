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
	const stops: number[] = [];
	const stopCauses: string[] = [];
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => "loss",
		setStreamingStatus: () => {},
		initialLiveness: () => (opts.launched ? "idle" : "unknown"),
		queryRuntime: async () => runtime,
		canReconcileStreaming: () => false,
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
