import { afterEach, expect, test } from "bun:test";
import {
	resetLifecycleInterlock,
	tryAcquireLifecycle,
} from "../modules/streaming/lifecycle-admission.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";

// `startView` is the read-only half of Start's duplicate-start rejection, which
// the stream-ready flag reports as its lock check.

afterEach(() => resetLifecycleInterlock());

function attemptIds(): () => string {
	let next = 0;
	return () => `attempt-${++next}`;
}

function orchestrator(
	overrides: Partial<
		Parameters<typeof createStreamSessionOrchestrator>[0]
	> = {},
) {
	return createStreamSessionOrchestrator({
		createAttemptId: attemptIds(),
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		admitLifecycle: () => tryAcquireLifecycle("streaming"),
		...overrides,
	});
}

test("an idle session after the boot reconcile is idle", async () => {
	const o = orchestrator();
	await o.reconcile();
	expect(o.startView()).toBe("idle");
});

test("a running stream is busy, and Start agrees", async () => {
	const o = orchestrator();
	await o.reconcile();
	const started = await o.start({ origin: "ui", launch: async () => {} });
	expect(started.result).toBe("started");
	expect(o.startView()).toBe("busy");
	const again = await o.start({ origin: "ui", launch: async () => {} });
	expect(again.result).toBe("busy");
});

test("a stop that failed leaves Start refusing, and the view busy or reconciling", async () => {
	const o = orchestrator({
		stopRuntime: async () => {
			throw new Error("stop_failed");
		},
		queryRuntime: async () => "streaming",
	});
	await o.reconcile();
	await o.start({ origin: "ui", launch: async () => {} });
	await o.stop("operator").catch(() => undefined);
	const view = o.startView();
	expect(view === "busy" || view === "reconciling").toBe(true);
	const again = await o.start({ origin: "ui", launch: async () => {} });
	expect(again.result).not.toBe("started");
});
