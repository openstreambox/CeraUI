import { expect, test } from "bun:test";
import {
	acquireStreamingLifecycle,
	resetLifecycleInterlock,
	tryAcquireCellularRecovery,
	tryAcquireLifecycle,
} from "../modules/streaming/lifecycle-admission.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";

// Initialize the orchestrator before inspecting its production composition.
const { streamSessionProductionDeps } = await import(
	"../modules/streaming/stream-session-production.ts"
);

test("boot autostart waits for recovery cleanup instead of losing its one-shot start", async () => {
	resetLifecycleInterlock();
	const lease = tryAcquireCellularRecovery();
	if (!lease.admitted) throw new Error("fixture lease");
	let launched = false;
	const session = createStreamSessionOrchestrator({
		admitLifecycle: () => {
			const admit = streamSessionProductionDeps.admitLifecycle;
			if (!admit) throw new Error("Production lifecycle wiring missing");
			return admit();
		},
		createAttemptId: () => "boot",
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
	});
	try {
		const start = session.start({
			origin: "autostart",
			launch: async () => {
				launched = true;
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(launched).toBe(false);
		expect(
			(
				await session.start({
					origin: "ui",
					launch: async () => {
						throw new Error("Duplicate launch");
					},
				})
			).result,
		).toBe("busy");
		lease.lease.release();
		expect((await start).result).toBe("started");
		expect(launched).toBe(true);
	} finally {
		lease.lease.release();
		resetLifecycleInterlock();
	}
});

test("ordinary modem mutations retain their immediate refusal semantics", async () => {
	resetLifecycleInterlock();
	const lease = tryAcquireLifecycle("modem-transition");
	if (!lease.admitted) throw new Error("fixture lease");
	try {
		expect((await acquireStreamingLifecycle()).admitted).toBe(false);
	} finally {
		lease.lease.release();
		resetLifecycleInterlock();
	}
});

test("Stop during the recovery wait cancels the queued start", async () => {
	resetLifecycleInterlock();
	const lease = tryAcquireCellularRecovery();
	if (!lease.admitted) throw new Error("fixture lease");
	let launched = false;
	const session = createStreamSessionOrchestrator({
		admitLifecycle: () => {
			const admit = streamSessionProductionDeps.admitLifecycle;
			if (!admit) throw new Error("Production lifecycle wiring missing");
			return admit();
		},
		createAttemptId: () => "cancel",
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
	});
	try {
		const start = session.start({
			origin: "autostart",
			launch: async () => {
				launched = true;
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		await session.stop("operator");
		lease.lease.release();
		expect((await start).result).toBe("cancelled");
		expect(launched).toBe(false);
	} finally {
		lease.lease.release();
		resetLifecycleInterlock();
	}
});
