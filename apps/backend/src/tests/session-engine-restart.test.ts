import { afterEach, describe, expect, test } from "bun:test";
import {
	type CerastreamClient,
	CerastreamRpcError,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import { CerastreamBackend } from "../modules/streaming/cerastream-backend.ts";
import {
	currentRuntimeObservationSilence,
	type SilenceEvidence,
	withRuntimeObservationOwner,
} from "../modules/streaming/engine-runtime-observation.ts";
import {
	type EngineIdentity,
	forgetSessionEngine,
	parseEngineIdentity,
	recordedSessionEngine,
	recordSessionEngine,
	setEngineIdentityReaderForTest,
} from "../modules/streaming/session-engine.ts";
import {
	StreamStartFailure,
	typedStartFailure,
} from "../modules/streaming/start-failure-taxonomy.ts";
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
const NEWER = "00112233445566778899aabbccddeeff";
const id = (invocation: string, pid = "100"): EngineIdentity => ({
	invocation,
	pid,
});

afterEach(() => {
	forgetSessionEngine();
	setEngineIdentityReaderForTest(undefined);
});

describe("parseEngineIdentity", () => {
	test("reads a running unit's invocation and main PID", () => {
		expect(parseEngineIdentity(`MainPID=4242\nInvocationID=${OLD}\n`)).toEqual({
			invocation: OLD,
			pid: "4242",
		});
	});
	test("an engine with no process, or an unreadable answer, has none", () => {
		expect(parseEngineIdentity(`MainPID=0\nInvocationID=${OLD}`)).toBe(
			undefined,
		);
		expect(parseEngineIdentity("MainPID=4242\nInvocationID=")).toBe(undefined);
		expect(parseEngineIdentity("MainPID=x\nInvocationID=zz")).toBe(undefined);
		expect(parseEngineIdentity("")).toBe(undefined);
	});
});

// ── the launch record: read around the Start itself ────────────────────────

const STREAM_CONFIG: RuntimeConfig = {
	max_br: 8000,
	srt_latency: 2000,
	balancer: "adaptive",
	pipeline: "h264_hdmi_1080p",
};
const RUN_OPTS = {
	pipeline: "hdmi",
	host: "127.0.0.1",
	port: 9000,
	streamid: "s",
};

function fakeClient(): CerastreamClient {
	const client = {
		hello: {
			protocol: "cerastream-ipc/1",
			schema_version: SCHEMA_VERSION,
			engine_version: "test",
		},
		start: async () => ({ session_id: "s1", state: "streaming" }),
		stop: async () => ({ state: "idle" }),
		listDevices: async () => ({ devices: [] }),
		subscribeEvents: async () => ({
			result: { subscribed: ["status"] },
			close: () => {},
		}),
		close: async () => {},
		rawRequest: async (method: string) =>
			method === "start" ? { session_id: "s1", state: "streaming" } : {},
	};
	return client as unknown as CerastreamClient;
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function backendWith(reads: Array<EngineIdentity | undefined>) {
	return new CerastreamBackend({
		connect: async () => fakeClient(),
		connectOptions: {},
		getConfig: () => STREAM_CONFIG,
		saveConfig: () => undefined,
		bridge: {
			notify: () => undefined,
			notificationExists: () => false,
			removeNotification: () => {},
			broadcastStatus: () => {},
			broadcastBuffering: () => undefined,
		},
		execPath: "cerastream",
		configPath: "/tmp/cerastream-session-engine.json",
		logger: quiet,
		onSessionConnectionLost: () => {},
		onEngineUnreachable: () => {},
		readEngineIdentity: async () => reads.shift(),
		onLaunchEngine: () => {},
	});
}

describe("the Start records the engine it ran in", () => {
	test("the same process before the connect and after the ack is recorded", async () => {
		const backend = backendWith([id(OLD), id(OLD)]);
		await backend.start(STREAM_CONFIG, RUN_OPTS);
		await backend.settleLaunchEngine();
		expect(backend.launchedEngineInvocation()).toBe(OLD);
	});

	test("an engine replaced during the Start records nothing", async () => {
		const backend = backendWith([id(OLD), id(NEW, "200")]);
		await backend.start(STREAM_CONFIG, RUN_OPTS);
		await backend.settleLaunchEngine();
		expect(backend.launchedEngineInvocation()).toBe(undefined);
	});

	test("a new main PID in the same invocation records nothing", async () => {
		const backend = backendWith([id(OLD, "100"), id(OLD, "101")]);
		await backend.start(STREAM_CONFIG, RUN_OPTS);
		await backend.settleLaunchEngine();
		expect(backend.launchedEngineInvocation()).toBe(undefined);
	});

	test("an unreadable unit records nothing", async () => {
		const backend = backendWith([undefined, id(OLD)]);
		await backend.start(STREAM_CONFIG, RUN_OPTS);
		await backend.settleLaunchEngine();
		expect(backend.launchedEngineInvocation()).toBe(undefined);
	});
});

// ── the replaced-engine witness in reconcile ───────────────────────────────

type Reply = "empty" | "no_report" | "streaming" | "idle" | "down";

/**
 * A backend whose own stream lost its engine: launched, committed, then the
 * engine-loss stop could not reach the engine, leaving `stop_failed`.
 */
async function sessionAfterEngineLoss(opts: {
	recorded: string | undefined;
	serving: () => EngineIdentity | undefined;
	reply: () => Reply;
	canReconcileIdle?: () => boolean;
	awaitsIdleWitness?: () => boolean;
	ownedSessionRemains?: () => boolean;
	onRead?: () => void;
}) {
	let queries = 0;
	let reads = 0;
	let stopReachesEngine = false;
	const ota = { marks: 0, releases: 0 };
	const census = { idle: 0, owned: 0, stops: 0 };
	const orchestrator = createStreamSessionOrchestrator({
		createAttemptId: () => "attempt",
		setStreamingStatus: () => {},
		stopRuntime: async () => {
			census.stops += 1;
			if (!stopReachesEngine) throw new Error("engine down");
		},
		markStreamingForOta: () => {
			ota.marks += 1;
			return true;
		},
		unmarkStreamingForOta: () => {
			ota.releases += 1;
			return true;
		},
		canReconcileIdle: () => {
			census.idle += 1;
			return opts.canReconcileIdle?.() ?? true;
		},
		ownedSessionRemains: () => {
			census.owned += 1;
			return opts.ownedSessionRemains?.() ?? false;
		},
		queryRuntime: async () => {
			queries += 1;
			const now = opts.reply();
			if (now === "down") return "unknown";
			if (now === "streaming" || now === "idle") return now;
			currentRuntimeObservationSilence()(
				now === "empty" ? "empty_snapshot" : "no_report",
			);
			return "unknown";
		},
		sessionEngine: {
			recorded: () => opts.recorded,
			readServing: async () => {
				reads += 1;
				opts.onRead?.();
				return opts.serving();
			},
		},
		engineStopped: async () => false,
		...(opts.awaitsIdleWitness
			? { awaitsIdleWitness: opts.awaitsIdleWitness }
			: {}),
	});
	const started = await orchestrator.start({
		origin: "ui",
		launch: async () => {},
	});
	expect(started.result).toBe("started");
	expect((await orchestrator.stop("engine_loss")).result).toBe("stop_failed");
	queries = 0;
	reads = 0;
	ota.marks = 0;
	ota.releases = 0;
	census.idle = 0;
	census.owned = 0;
	census.stops = 0;
	return {
		orchestrator,
		ota,
		census,
		stopReachesEngine: () => {
			stopReachesEngine = true;
		},
		get queries() {
			return queries;
		},
		get reads() {
			return reads;
		},
	};
}

describe("reconcile after the engine restarted under this backend's session", () => {
	test("one replacement, silent with an empty session list twice, proves the session ended", async () => {
		const s = await sessionAfterEngineLoss({
			recorded: OLD,
			serving: () => id(NEW),
			reply: () => "empty",
		});
		expect(await s.orchestrator.reconcile()).toBe("idle");
		expect(s.queries).toBe(SILENT_WITNESS_QUERIES);
		expect(s.reads).toBe(2); // before the first query, after the last
	});

	test("the same engine process, silent, proves nothing", async () => {
		const s = await sessionAfterEngineLoss({
			recorded: OLD,
			serving: () => id(OLD),
			reply: () => "empty",
		});
		expect(await s.orchestrator.reconcile()).not.toBe("idle");
		expect(s.queries).toBe(1);
	});

	test("no launch record proves nothing and reads nothing", async () => {
		const s = await sessionAfterEngineLoss({
			recorded: undefined,
			serving: () => id(NEW),
			reply: () => "empty",
		});
		expect(await s.orchestrator.reconcile()).not.toBe("idle");
		expect(s.reads).toBe(0);
	});

	test("an RPC error instead of an empty session list is not silence here", async () => {
		const s = await sessionAfterEngineLoss({
			recorded: OLD,
			serving: () => id(NEW),
			reply: () => "no_report",
		});
		expect(await s.orchestrator.reconcile()).not.toBe("idle");
	});

	test("a replaced engine that is still down proves nothing", async () => {
		const s = await sessionAfterEngineLoss({
			recorded: OLD,
			serving: () => undefined,
			reply: () => "down",
		});
		expect(await s.orchestrator.reconcile()).not.toBe("idle");
	});

	test("a second replacement between the reads proves nothing", async () => {
		let reads = 0;
		const s = await sessionAfterEngineLoss({
			recorded: OLD,
			serving: () => (reads++ === 0 ? id(NEW) : id(NEWER, "300")),
			reply: () => "empty",
		});
		expect(await s.orchestrator.reconcile()).not.toBe("idle");
	});

	test("an engine restarted in place (new PID) between the reads proves nothing", async () => {
		let reads = 0;
		const s = await sessionAfterEngineLoss({
			recorded: OLD,
			serving: () => (reads++ === 0 ? id(NEW, "200") : id(NEW, "201")),
			reply: () => "empty",
		});
		expect(await s.orchestrator.reconcile()).not.toBe("idle");
	});

	test("a status that says it streams is never taken for idle", async () => {
		let n = 0;
		const s = await sessionAfterEngineLoss({
			recorded: OLD,
			serving: () => id(NEW),
			reply: () => (n++ === 0 ? "empty" : "streaming"),
		});
		expect(await s.orchestrator.reconcile()).not.toBe("idle");
	});

	test("an unowned sender keeps the protection", async () => {
		const s = await sessionAfterEngineLoss({
			recorded: OLD,
			serving: () => id(NEW),
			reply: () => "empty",
			canReconcileIdle: () => false,
		});
		expect(await s.orchestrator.reconcile()).not.toBe("idle");
	});

	test("an operator Stop during the closing read wins over the witness", async () => {
		let reads = 0;
		let stopping: Promise<unknown> | undefined;
		const s = await sessionAfterEngineLoss({
			recorded: OLD,
			serving: () => id(NEW),
			reply: () => "empty",
			onRead: () => {
				if (++reads === 2) stopping = s.orchestrator.stop("operator");
			},
		});
		expect(await s.orchestrator.reconcile()).not.toBe("idle");
		// The superseded witness never reaches the idle census or the cleanup
		// of owned processes.
		expect(s.census.idle).toBe(0);
		expect(s.census.owned).toBe(0);
		await stopping;
	});

	test("an operator Stop during the opening read wins too", async () => {
		let stopping: Promise<unknown> | undefined;
		let first = true;
		const s = await sessionAfterEngineLoss({
			recorded: OLD,
			serving: () => id(NEW),
			reply: () => "empty",
			onRead: () => {
				if (first) stopping = s.orchestrator.stop("operator");
				first = false;
			},
		});
		const queriesBefore = s.queries;
		expect(await s.orchestrator.reconcile()).not.toBe("idle");
		expect(s.queries).toBe(queriesBefore);
		await stopping;
	});
});

// ── silence evidence from the real engine query ────────────────────────────

describe("what the engine query reports as silence", () => {
	async function evidenceFor(
		listSwitchTargets: () => Promise<unknown>,
	): Promise<SilenceEvidence | undefined> {
		const client = {
			...(fakeClient() as unknown as Record<string, unknown>),
			listSwitchTargets,
		} as unknown as CerastreamClient;
		const backend = new CerastreamBackend({
			connect: async () => client,
			connectOptions: {},
			logger: quiet,
			// The silent window expires at once.
			scheduleTimeout: (callback) => setTimeout(callback, 0),
			cancelTimeout: (timer) => clearTimeout(timer),
			readEngineIdentity: async () => undefined,
		});
		let evidence: SilenceEvidence | undefined;
		await withRuntimeObservationOwner(
			() => true,
			() => backend.reconcileRuntimeState(),
			undefined,
			(e) => {
				evidence = e;
			},
		);
		return evidence;
	}

	test("a valid empty session list is an empty snapshot", async () => {
		expect(await evidenceFor(async () => ({ switch_targets: [] }))).toBe(
			"empty_snapshot",
		);
	});

	test("an RPC error on a readable schema is only a missing report", async () => {
		expect(
			await evidenceFor(async () => {
				throw new CerastreamRpcError(-32601, "method not found");
			}),
		).toBe("no_report");
	});
});

// ── restoration window and admission ───────────────────────────────────────

function restorationWith(idleAtMs: number) {
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
			runtimeState: async () => {
				// Each query takes 3 s, like a silent engine query.
				now += 3_000;
				return now < idleAtMs ? "unknown" : "idle";
			},
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
	return { run, launches };
}

describe("restoration after an engine restart", () => {
	test("the engine's own restart gets the declared bound, other triggers keep 10 s", () => {
		expect(restorationUnknownDeadlineMs("engine_restart")).toBe(30_000);
		expect(restorationUnknownDeadlineMs("service_restart")).toBe(10_000);
	});

	test("an engine that answers idle after 12 s is restored", async () => {
		const r = restorationWith(12_000);
		expect(await r.run).toMatchObject({ result: "recovered" });
		await settleStreamRestoration();
		expect(r.launches).toHaveLength(1);
	});

	test("an idle answer from a query that crossed 30 s does not launch", async () => {
		const r = restorationWith(29_500); // answered at about 31 s
		expect(await r.run).toMatchObject({
			result: "failed",
			reason: "runtime_state_unknown",
		});
		await settleStreamRestoration();
		expect(r.launches).toHaveLength(0);
	});
});

// ── production wiring ──────────────────────────────────────────────────────

describe("production wiring", () => {
	test("a launch records the engine through the backend's default hook", async () => {
		// No `onLaunchEngine` injected: the production binding records it.
		const reads = [id(OLD), id(OLD)];
		const backend = new CerastreamBackend({
			connect: async () => fakeClient(),
			connectOptions: {},
			getConfig: () => STREAM_CONFIG,
			saveConfig: () => undefined,
			logger: quiet,
			onSessionConnectionLost: () => {},
			onEngineUnreachable: () => {},
			readEngineIdentity: async () => reads.shift(),
		});
		await backend.start(STREAM_CONFIG, RUN_OPTS);
		await backend.settleLaunchEngine();
		expect(recordedSessionEngine()).toBe(OLD);
	});

	test("a launch no longer current when its reads settle records nothing", async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const recorded: Array<string | undefined> = [];
		let reads = 0;
		const backend = new CerastreamBackend({
			connect: async () => fakeClient(),
			connectOptions: {},
			getConfig: () => STREAM_CONFIG,
			saveConfig: () => undefined,
			logger: quiet,
			onSessionConnectionLost: () => {},
			onEngineUnreachable: () => {},
			readEngineIdentity: async () => {
				if (++reads === 2) await held; // the after-ack read
				return id(OLD);
			},
			onLaunchEngine: (invocation) => recorded.push(invocation),
		});
		await backend.start(STREAM_CONFIG, RUN_OPTS);
		await new Promise<void>((resolve) => backend.stop(resolve));
		release();
		await backend.settleLaunchEngine();
		expect(recorded).toEqual([]);
	});

	test("the witness reads the record and the unit through the bound dependency", async () => {
		recordSessionEngine(OLD);
		setEngineIdentityReaderForTest(async () => id(NEW));
		const bound = streamSessionProductionDeps.sessionEngine;
		expect(bound?.recorded()).toBe(OLD);
		expect(await bound?.readServing()).toEqual(id(NEW));
	});

	test("an idle lifecycle drops the record", () => {
		recordSessionEngine(OLD);
		streamSessionProductionDeps.setLifecycleState?.("idle");
		expect(recordedSessionEngine()).toBe(undefined);
	});
});

// ── the OTA guard across the restart handoff ──────────────────────────────

async function heldIdle(
	opts: Partial<Parameters<typeof sessionAfterEngineLoss>[0]> = {},
) {
	const s = await sessionAfterEngineLoss({
		recorded: OLD,
		serving: () => id(NEW),
		reply: () => "empty",
		...opts,
	});
	expect(await s.orchestrator.reconcile()).toBe("idle");
	return s;
}

describe("the witness's idle keeps the OTA guard until restoration resolves it", () => {
	test("the idle commit does not release protection; the page leaves LIVE", async () => {
		const s = await heldIdle();
		expect(s.ota.releases).toBe(0);
		expect(s.orchestrator.streamLiveness()).toBe("unknown");
	});

	test("restoration launched our session: protection carries over, never released", async () => {
		const s = await heldIdle();
		const started = await s.orchestrator.start({
			origin: "restoration",
			launch: async () => {},
		});
		expect(started.result).toBe("started");
		expect(await s.orchestrator.settleRestartHandoff()).toBe("streaming");
		expect(s.ota.releases).toBe(0);
		expect(s.orchestrator.streamLiveness()).toBe("streaming");
	});

	test("any other Start waits for the handoff and does not end it", async () => {
		const s = await heldIdle();
		const ui = await s.orchestrator.start({
			origin: "ui",
			launch: async () => {},
		});
		expect(ui.result).toBe("busy");
		// Restoration's own Start still takes the protection over.
		const restored = await s.orchestrator.start({
			origin: "restoration",
			launch: async () => {},
		});
		expect(restored.result).toBe("started");
		expect(s.ota.releases).toBe(0);
	});

	test("restoration's Start refused as already streaming keeps protection, reconciling", async () => {
		const s = await heldIdle();
		const started = await s.orchestrator.start({
			origin: "restoration",
			launch: async ({ attemptId }) => {
				throw new StreamStartFailure(
					typedStartFailure(
						attemptId,
						"start-rpc",
						"engine_internal",
						"already_streaming",
					),
					"unknown",
				);
			},
		});
		expect(started.result).toBe("failed");
		expect(await s.orchestrator.settleRestartHandoff()).toBe("reconciling");
		expect(s.ota.releases).toBe(0);
		// Nothing was stopped for it either.
		expect(s.census.stops).toBe(0);
	});

	test("restoration's Start failing with a confirmed idle releases protection once, as today", async () => {
		const s = await heldIdle();
		// The rollback Stop was acknowledged (an SRT connect that failed).
		const started = await s.orchestrator.start({
			origin: "restoration",
			launch: async ({ attemptId }) => {
				throw new StreamStartFailure(
					typedStartFailure(
						attemptId,
						"start-rpc",
						"engine_internal",
						"srt_connect_failed",
					),
					"idle",
				);
			},
		});
		expect(started.result).toBe("failed");
		expect(s.ota.releases).toBe(1);
		// The launch ended the handoff: settling asks nothing more.
		const queries = s.queries;
		expect(await s.orchestrator.settleRestartHandoff()).toBe("idle");
		expect(s.queries).toBe(queries);
	});

	test("restoration ended without a launch: a silent engine keeps protection for the operator's Stop", async () => {
		const s = await heldIdle();
		expect(await s.orchestrator.settleRestartHandoff()).toBe("reconciling");
		expect(s.ota.releases).toBe(0);
	});

	test("restoration ended without a launch: an engine that reports idle releases it", async () => {
		let replied = false;
		const s = await heldIdle({
			// The ordinary reconcile, witness off, hears an idle status.
			reply: () => (replied ? "idle" : "empty"),
		});
		replied = true;
		expect(await s.orchestrator.settleRestartHandoff()).toBe("idle");
		expect(s.ota.releases).toBe(1);
	});

	test("the operator's Stop resolves the handoff as today", async () => {
		const s = await heldIdle();
		s.stopReachesEngine();
		expect((await s.orchestrator.stop("operator")).result).toBe("stopped");
		expect(s.ota.releases).toBe(1);
		// The Stop ended the handoff: settling afterwards asks nothing.
		const queries = s.queries;
		expect(await s.orchestrator.settleRestartHandoff()).toBe("idle");
		expect(s.queries).toBe(queries);
		expect(s.ota.releases).toBe(1);
	});

	test("our own processes still running: the witness leaves them to an ordinary reconcile", async () => {
		const s = await sessionAfterEngineLoss({
			recorded: OLD,
			serving: () => id(NEW),
			reply: () => "empty",
			ownedSessionRemains: () => true,
		});
		expect(await s.orchestrator.reconcile()).not.toBe("idle");
		expect(s.census.stops).toBe(0);
		expect(s.ota.releases).toBe(0);
	});
});

describe("restoration settles the handoff", () => {
	test("an engine-restart run settles it at the end; a service-restart run does not", async () => {
		for (const [trigger, expected] of [
			["engine_restart", 1],
			["service_restart", 0],
		] as const) {
			let settles = 0;
			await runStreamRestoration(
				{
					marker: {
						markerPath: "memory",
						readBootId: () => "b",
						readMarker: () => undefined,
						writeMarker: () => {},
						removeMarker: () => {},
					},
					awaitRecovery: async () => {},
					runtimeState: async () => "idle",
					lifecycleState: () => "idle",
					launch: async () => ({ ok: true as const }),
					now: () => 0,
					wait: async () => {},
					pollIntervalMs: 1_000,
					logger: { info: () => {}, warn: () => {} },
					publish: () => {},
					settleRestartHandoff: async () => {
						settles += 1;
					},
				},
				trigger,
			);
			await settleStreamRestoration();
			expect(settles).toBe(expected);
		}
	});
});
