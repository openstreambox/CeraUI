import { afterEach, describe, expect, test } from "bun:test";
import { currentRuntimeObservationSilence } from "../modules/streaming/engine-runtime-observation.ts";
import {
	forgetSessionEngine,
	noteSessionEngine,
	parseEngineInvocation,
	sessionEngineReplaced,
} from "../modules/streaming/session-engine.ts";
import {
	restorationUnknownDeadlineMs,
	runStreamRestoration,
	settleStreamRestoration,
} from "../modules/streaming/stream-restoration.ts";
import {
	createStreamSessionOrchestrator,
	SILENT_WITNESS_QUERIES,
} from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";

// After systemd restarts cerastream under a live session, that session cannot
// exist any more: it lived in the old engine process. The restarted engine is
// idle and sends no status, so a reconcile could only say "unknown" and the
// page claimed LIVE until an operator Stop. These cases pin when the backend
// may now conclude idle, and every case where it still must not.

const OLD = "0123456789abcdef0123456789abcdef";
const NEW = "fedcba9876543210fedcba9876543210";

afterEach(() => {
	forgetSessionEngine();
});

describe("parseEngineInvocation", () => {
	test("reads a running unit's invocation", () => {
		expect(parseEngineInvocation(`MainPID=4242\nInvocationID=${OLD}\n`)).toBe(
			OLD,
		);
	});
	test("an engine with no process, or an unreadable answer, has none", () => {
		expect(parseEngineInvocation(`MainPID=0\nInvocationID=${OLD}`)).toBe(
			undefined,
		);
		expect(parseEngineInvocation("MainPID=4242\nInvocationID=")).toBe(
			undefined,
		);
		expect(parseEngineInvocation("MainPID=x\nInvocationID=zz")).toBe(undefined);
		expect(parseEngineInvocation("")).toBe(undefined);
	});
});

describe("the session's engine record", () => {
	test("replaced only when a recorded invocation differs from the running one", async () => {
		expect(await sessionEngineReplaced(async () => NEW)).toBe(false); // none
		await noteSessionEngine(
			() => true,
			async () => OLD,
		);
		expect(await sessionEngineReplaced(async () => OLD)).toBe(false);
		expect(await sessionEngineReplaced(async () => undefined)).toBe(false);
		expect(await sessionEngineReplaced(async () => NEW)).toBe(true);
		forgetSessionEngine();
		expect(await sessionEngineReplaced(async () => NEW)).toBe(false);
	});

	test("a commit that is no longer current records nothing", async () => {
		await noteSessionEngine(
			() => false,
			async () => OLD,
		);
		expect(await sessionEngineReplaced(async () => NEW)).toBe(false);
	});

	test("a record dropped while the read runs is not compared", async () => {
		await noteSessionEngine(
			() => true,
			async () => OLD,
		);
		expect(
			await sessionEngineReplaced(async () => {
				forgetSessionEngine(); // the session went idle meanwhile
				return NEW;
			}),
		).toBe(false);
	});
});

type Engine = "silent" | "streaming" | "idle" | "down";

/**
 * A backend whose own stream lost its engine: launched, committed, then the
 * engine-loss stop could not reach the engine, leaving `stop_failed`.
 */
async function sessionAfterEngineLoss(opts: {
	engine: () => Engine;
	replaced: () => boolean;
	canReconcileIdle?: () => boolean;
	engineStopped?: () => boolean;
}) {
	let queries = 0;
	const orchestrator = createStreamSessionOrchestrator({
		createAttemptId: () => "attempt",
		setStreamingStatus: () => {},
		stopRuntime: async () => {
			throw new Error("engine down");
		},
		queryRuntime: async () => {
			queries += 1;
			const now = opts.engine();
			if (now === "down") return "unknown";
			if (now !== "silent") return now;
			currentRuntimeObservationSilence()();
			return "unknown";
		},
		sessionEngineReplaced: async () => opts.replaced(),
		// The engine unit runs unless a test says otherwise; never the host.
		engineStopped: async () => opts.engineStopped?.() ?? false,
		...(opts.canReconcileIdle
			? { canReconcileIdle: opts.canReconcileIdle }
			: {}),
	});
	const started = await orchestrator.start({
		origin: "ui",
		launch: async () => {},
	});
	expect(started.result).toBe("started");
	const stopped = await orchestrator.stop("engine_loss");
	expect(stopped.result).toBe("stop_failed");
	queries = 0;
	return {
		orchestrator,
		get queries() {
			return queries;
		},
	};
}

describe("reconcile after the engine restarted under this backend's session", () => {
	test("a replaced engine that stays silent proves the session ended", async () => {
		const s = await sessionAfterEngineLoss({
			engine: () => "silent",
			replaced: () => true,
		});
		expect(await s.orchestrator.reconcile()).toBe("idle");
		expect(s.queries).toBe(SILENT_WITNESS_QUERIES);
	});

	test("the same engine process, silent, proves nothing", async () => {
		const s = await sessionAfterEngineLoss({
			engine: () => "silent",
			replaced: () => false,
		});
		expect(await s.orchestrator.reconcile()).not.toBe("idle");
		expect(s.queries).toBe(1);
	});

	test("a replaced engine that is still down proves nothing", async () => {
		const s = await sessionAfterEngineLoss({
			engine: () => "down",
			replaced: () => true,
		});
		expect(await s.orchestrator.reconcile()).not.toBe("idle");
	});

	test("a replaced engine whose unit has no process yet proves nothing", async () => {
		const s = await sessionAfterEngineLoss({
			engine: () => "down",
			replaced: () => true,
			engineStopped: () => true,
		});
		expect(await s.orchestrator.reconcile()).not.toBe("idle");
	});

	test("a replaced engine that reports a session is never taken for idle", async () => {
		let n = 0;
		const s = await sessionAfterEngineLoss({
			// Silent once, then a status says it streams.
			engine: () => (n++ === 0 ? "silent" : "streaming"),
			replaced: () => true,
		});
		expect(await s.orchestrator.reconcile()).not.toBe("idle");
	});

	test("an unowned sender keeps the protection even when the engine was replaced", async () => {
		const s = await sessionAfterEngineLoss({
			engine: () => "silent",
			replaced: () => true,
			canReconcileIdle: () => false,
		});
		expect(await s.orchestrator.reconcile()).not.toBe("idle");
	});
});

describe("restoration after an engine restart", () => {
	test("the engine's own restart gets the declared bound, other triggers keep 10 s", () => {
		expect(restorationUnknownDeadlineMs("engine_restart")).toBe(30_000);
		expect(restorationUnknownDeadlineMs("service_restart")).toBe(10_000);
	});

	test("an engine back after 12 s is restored, not given up on", async () => {
		const bootId = "11111111-1111-4111-8111-111111111111";
		let marker = JSON.stringify({
			bootId,
			armedAt: 1,
			config: { pipeline: "hdmi" },
		});
		let now = 0;
		const launches: unknown[] = [];
		const run = runStreamRestoration(
			{
				marker: {
					markerPath: "memory",
					readBootId: () => bootId,
					readMarker: () => marker,
					writeMarker: (_path, value) => {
						marker = value;
					},
					removeMarker: () => {},
				},
				awaitRecovery: async () => {},
				// Down (unknown) for 12 s, then a decisive idle.
				runtimeState: async () => (now < 12_000 ? "unknown" : "idle"),
				lifecycleState: () => "idle",
				launch: async (config) => {
					launches.push(config);
					return { ok: true as const };
				},
				now: () => now,
				wait: async (ms) => {
					now += ms;
				},
				pollIntervalMs: 1_000,
				logger: { info: () => {}, warn: () => {} },
				publish: () => {},
				// No unknownDeadlineMs: the trigger's default applies.
			},
			"engine_restart",
		);
		const outcome = await run;
		await settleStreamRestoration();
		expect(outcome).toMatchObject({ result: "recovered" });
		expect(launches).toHaveLength(1);
	});
});

describe("production wiring", () => {
	test("an idle lifecycle drops the record; the orchestrator dep is bound", async () => {
		await noteSessionEngine(
			() => true,
			async () => OLD,
		);
		expect(await sessionEngineReplaced(async () => NEW)).toBe(true);
		streamSessionProductionDeps.setLifecycleState?.("idle");
		expect(await sessionEngineReplaced(async () => NEW)).toBe(false);
		expect(streamSessionProductionDeps.sessionEngineReplaced).toBeDefined();
	});
});
