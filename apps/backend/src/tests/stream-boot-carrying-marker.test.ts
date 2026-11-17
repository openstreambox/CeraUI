/**
 * Field regression (ROCK2, fork image): every boot stayed `reconciling`.
 *
 * Production startup takes the carrying startup hold (`initCarrying()`) before
 * the first stream reconciliation, and that hold writes the shared
 * `/run/ceralive/streaming` sentinel. The stream session read the same file as
 * "a marker survived from an earlier process", so it took encoder ownership of
 * the marker and the inhibitor. An idle engine pushes no status on subscribe,
 * the probe answered `unknown`, and nothing ever proved idle: disruptive
 * actions refused, the shutdown inhibitor stayed held and the image deferred
 * armed activations until an operator stop.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { currentRuntimeObservationSilence } from "../modules/streaming/engine-runtime-observation.ts";
import * as bootMarker from "../modules/streaming/ota-streaming-marker.ts";
import {
	clearOtaStreamingMarker,
	encoderOtaStreamLiveness,
	otaStreamingMarkerPath,
	setCarryingOtaProtection,
	setOtaStreamingMarker,
} from "../modules/streaming/ota-streaming-marker.ts";
import {
	createStreamSessionOrchestrator,
	SILENT_WITNESS_QUERIES,
} from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import type { EngineRuntimeState } from "../modules/streaming/streaming-backend.ts";
import { initShutdownProtection } from "../modules/system/shutdown-protection.ts";

let inhibitorHeld = false;
initShutdownProtection(() => {
	inhibitorHeld = true;
	return () => {
		inhibitorHeld = false;
	};
});

const markerPresent = () => existsSync(otaStreamingMarkerPath());

function resetOwners() {
	chmodSync(dirname(otaStreamingMarkerPath()), 0o700);
	setCarryingOtaProtection(false);
	clearOtaStreamingMarker();
	rmSync(otaStreamingMarkerPath(), { force: true });
}

beforeEach(resetOwners);
afterEach(resetOwners);

type MarkerModule = typeof bootMarker;

/**
 * What the engine answers a reconciliation: `unknown` is no answer at all
 * (unreachable, error), `silent` a reachable engine that sent no status
 * before the query gave up, which is how an idle engine behaves.
 */
type Engine = EngineRuntimeState | "silent";
const engineQuery =
	(engine: () => Engine, counted: () => void = () => undefined) =>
	async (): Promise<EngineRuntimeState> => {
		counted();
		const now = engine();
		if (now !== "silent") return now;
		currentRuntimeObservationSilence()();
		return "unknown";
	};
const markerDeps = (marker: MarkerModule) => ({
	initialLiveness: marker.encoderOtaStreamLiveness,
	markStreamingForOta: marker.setOtaStreamingMarker,
	unmarkStreamingForOta: marker.clearOtaStreamingMarker,
	confirmStreamingForOta: marker.adoptOtaStreamingMarker,
	awaitsIdleWitness: marker.otaMarkerAwaitsIdleWitness,
});

/** The production session with only the engine and status sinks replaced. */
function bootSession(
	runtime: Engine | (() => Engine),
	marker: MarkerModule = bootMarker,
) {
	let stops = 0;
	let queries = 0;
	const engine = typeof runtime === "function" ? runtime : () => runtime;
	const session = createStreamSessionOrchestrator({
		...streamSessionProductionDeps,
		...markerDeps(marker),
		createAttemptId: () => "boot",
		setStreamingStatus: () => undefined,
		getStreamingStatus: () => engine() === "streaming",
		seedLifecycleState: () => undefined,
		setLifecycleState: () => undefined,
		queryRuntime: engineQuery(engine, () => {
			queries++;
		}),
		stopRuntime: async () => {
			stops++;
		},
		onStreamStopped: () => undefined,
	});
	return { session, stops: () => stops, queries: () => queries };
}

test("a clean boot under the carrying startup hold reaches idle with a silent engine", async () => {
	expect(markerPresent()).toBe(false);
	const { session } = bootSession("unknown");
	// main.ts: initCarrying() publishes the startup hold before reconciliation.
	setCarryingOtaProtection(true);
	expect(markerPresent()).toBe(true);

	expect(await session.reconcile()).toBe("idle");
	expect(session.streamLiveness()).toBe("idle");
	expect(encoderOtaStreamLiveness()).toBe("idle");

	// The 120 s hold expires: nothing may keep the marker or the inhibitor.
	setCarryingOtaProtection(false);
	expect(markerPresent()).toBe(false);
	expect(inhibitorHeld).toBe(false);
	expect(session.snapshot().state).toBe("idle");
});

test("a clean boot whose engine reports idle also clears everything after the hold", async () => {
	const { session } = bootSession("idle");
	setCarryingOtaProtection(true);
	expect(await session.reconcile()).toBe("idle");
	expect(session.streamLiveness()).toBe("idle");
	setCarryingOtaProtection(false);
	expect(markerPresent()).toBe(false);
	expect(inhibitorHeld).toBe(false);
});

test("a boot that adopts a running engine session stays protected after the hold", async () => {
	const { session } = bootSession("streaming");
	setCarryingOtaProtection(true);
	expect(await session.reconcile()).toBe("streaming");
	expect(session.streamLiveness()).toBe("streaming");

	setCarryingOtaProtection(false);
	expect(markerPresent()).toBe(true);
	expect(inhibitorHeld).toBe(true);
	expect(encoderOtaStreamLiveness()).toBe("unknown");

	expect(await session.stop("operator")).toEqual({ result: "stopped" });
	expect(markerPresent()).toBe(false);
	expect(inhibitorHeld).toBe(false);
});

test("a marker inherited from an earlier process still fails safe", async () => {
	// A backend restart: /run kept the previous process's marker.
	writeFileSync(otaStreamingMarkerPath(), "");
	const { session, stops } = bootSession("unknown");
	setCarryingOtaProtection(true);
	expect(encoderOtaStreamLiveness()).toBe("unknown");

	expect(await session.reconcile()).toBe("reconciling");
	expect(session.streamLiveness()).toBe("unknown");
	setCarryingOtaProtection(false);
	expect(markerPresent()).toBe(true);
	expect(inhibitorHeld).toBe(true);

	// Only an explicit stop proves idle, exactly as before.
	expect(await session.stop("operator")).toEqual({ result: "stopped" });
	expect(stops()).toBe(1);
	expect(session.snapshot().state).toBe("idle");
	expect(markerPresent()).toBe(false);
	expect(inhibitorHeld).toBe(false);
});

test("client traffic after a confirmed idle does not make the encoder unknown", () => {
	setCarryingOtaProtection(true);
	expect(encoderOtaStreamLiveness()).toBe("idle");
	setOtaStreamingMarker();
	expect(encoderOtaStreamLiveness()).toBe("unknown");
	clearOtaStreamingMarker();
	expect(markerPresent()).toBe(true);
	expect(encoderOtaStreamLiveness()).toBe("idle");
	setCarryingOtaProtection(false);
	expect(markerPresent()).toBe(false);
	expect(encoderOtaStreamLiveness()).toBe("idle");
});

test("a carrying hold over an existing marker never claims it", () => {
	writeFileSync(otaStreamingMarkerPath(), "");
	setCarryingOtaProtection(true);
	expect(encoderOtaStreamLiveness()).toBe("unknown");
});

/**
 * Field regression (second box on the same network): the image restarted the
 * backend a few seconds into the boot, inside the startup hold. `/run` kept the
 * first process's carrying-only marker, the new process read it as a possible
 * stream and stayed `reconciling` until an operator stop.
 *
 * A fresh module instance is the restarted process: it has none of the first
 * process's memory, only the file.
 */
let restarts = 0;
const restartBackend = (): Promise<MarkerModule> =>
	import(`../modules/streaming/ota-streaming-marker.ts?restart=${++restarts}`);

test("a backend restart inside the startup hold reaches idle without a stop", async () => {
	setCarryingOtaProtection(true);
	expect(markerPresent()).toBe(true);

	const restarted = await restartBackend();
	const { session, stops, queries } = bootSession("silent", restarted);
	restarted.setCarryingOtaProtection(true);
	// The line alone is not idle: it waits, unchanged, for the engine.
	expect(restarted.encoderOtaStreamLiveness()).toBe("unknown");
	expect(markerLine()).toBe("carrying\n");

	expect(await session.reconcile()).toBe("idle");
	expect(queries()).toBe(SILENT_WITNESS_QUERIES);
	expect(session.streamLiveness()).toBe("idle");
	expect(restarted.encoderOtaStreamLiveness()).toBe("idle");
	expect(stops()).toBe(0);

	restarted.setCarryingOtaProtection(false);
	expect(markerPresent()).toBe(false);
	expect(inhibitorHeld).toBe(false);
});

test("a second restart inside the same hold still reaches idle", async () => {
	setCarryingOtaProtection(true);
	const first = await restartBackend();
	first.setCarryingOtaProtection(true);
	const second = await restartBackend();
	const { session } = bootSession("silent", second);
	second.setCarryingOtaProtection(true);
	expect(await session.reconcile()).toBe("idle");
	second.setCarryingOtaProtection(false);
	expect(markerPresent()).toBe(false);
});

test("a restart before the new process takes its own hold waits for the engine, not a stop", async () => {
	setCarryingOtaProtection(true);
	const restarted = await restartBackend();
	// The session is built at import, before initCarrying().
	const { session } = bootSession("silent", restarted);
	expect(session.snapshot().state).toBe("reconciling");
	restarted.setCarryingOtaProtection(true);
	expect(await session.reconcile()).toBe("idle");
	restarted.setCarryingOtaProtection(false);
	expect(markerPresent()).toBe(false);
});

test("a restart while a stream is up adopts it and keeps it protected", async () => {
	setCarryingOtaProtection(true);
	setOtaStreamingMarker();

	const restarted = await restartBackend();
	const { session } = bootSession("streaming", restarted);
	restarted.setCarryingOtaProtection(true);
	expect(restarted.encoderOtaStreamLiveness()).toBe("unknown");
	expect(await session.reconcile()).toBe("streaming");
	expect(session.streamLiveness()).toBe("streaming");

	restarted.setCarryingOtaProtection(false);
	expect(markerPresent()).toBe(true);
	expect(inhibitorHeld).toBe(true);
	expect(await session.stop("operator")).toEqual({ result: "stopped" });
	expect(markerPresent()).toBe(false);
	expect(inhibitorHeld).toBe(false);
});

test("a restart with a stream marker and a silent engine refuses a second start", async () => {
	// The stream began inside the hold, so the file was carrying's first.
	setCarryingOtaProtection(true);
	setOtaStreamingMarker();

	const restarted = await restartBackend();
	const { session, stops } = bootSession("unknown", restarted);
	restarted.setCarryingOtaProtection(true);
	expect(await session.reconcile()).toBe("reconciling");
	expect(session.streamLiveness()).toBe("unknown");
	restarted.setCarryingOtaProtection(false);
	expect(markerPresent()).toBe(true);
	expect(inhibitorHeld).toBe(true);

	expect(await session.stop("operator")).toEqual({ result: "stopped" });
	expect(stops()).toBe(1);
	expect(markerPresent()).toBe(false);
});

test("a restart after a confirmed stop under carrying reaches idle", async () => {
	setCarryingOtaProtection(true);
	setOtaStreamingMarker();
	clearOtaStreamingMarker();
	expect(markerPresent()).toBe(true);

	const restarted = await restartBackend();
	const { session } = bootSession("silent", restarted);
	restarted.setCarryingOtaProtection(true);
	expect(await session.reconcile()).toBe("idle");
	restarted.setCarryingOtaProtection(false);
	expect(markerPresent()).toBe(false);
});

test("a stream started after a restart inside the hold is protected like any other", async () => {
	setCarryingOtaProtection(true);
	const restarted = await restartBackend();
	restarted.setCarryingOtaProtection(true);
	restarted.setOtaStreamingMarker();
	expect(restarted.encoderOtaStreamLiveness()).toBe("unknown");
	restarted.setCarryingOtaProtection(false);
	expect(markerPresent()).toBe(true);

	// The process dies with the stream up: the next one must not call it idle.
	const next = await restartBackend();
	next.setCarryingOtaProtection(true);
	expect(next.encoderOtaStreamLiveness()).toBe("unknown");
	next.clearOtaStreamingMarker();
	next.setCarryingOtaProtection(false);
});

test("a marker of unknown origin is never claimed by a restart", async () => {
	writeFileSync(otaStreamingMarkerPath(), "");
	const restarted = await restartBackend();
	restarted.setCarryingOtaProtection(true);
	expect(restarted.encoderOtaStreamLiveness()).toBe("unknown");
	writeFileSync(otaStreamingMarkerPath(), "something else\n");
	const other = await restartBackend();
	other.setCarryingOtaProtection(true);
	expect(other.encoderOtaStreamLiveness()).toBe("unknown");
	other.clearOtaStreamingMarker();
	other.setCarryingOtaProtection(false);
	restarted.clearOtaStreamingMarker();
	restarted.setCarryingOtaProtection(false);
});

/**
 * Review regression: Start could not rewrite the carrying-only marker, launched
 * anyway and left the line on disk under a live stream. The next process read
 * the line and called the box idle.
 */
function launchSession(
	marker: MarkerModule,
	shutdownAdmission?: () => Promise<boolean>,
	engine: () => Engine = () => "silent",
) {
	let launches = 0;
	const session = createStreamSessionOrchestrator({
		...streamSessionProductionDeps,
		...markerDeps(marker),
		...(shutdownAdmission === undefined
			? {}
			: { ensureShutdownProtection: shutdownAdmission }),
		claimLaunchMarker: marker.claimOtaMarkerForLaunch,
		createAttemptId: () => "launch",
		setStreamingStatus: () => undefined,
		getStreamingStatus: () => launches > 0,
		seedLifecycleState: () => undefined,
		setLifecycleState: () => undefined,
		// Silent by default: an idle engine says nothing, and launches here
		// dispatch nothing real.
		queryRuntime: engineQuery(engine),
		stopRuntime: async () => undefined,
		onStreamStopped: () => undefined,
		onStreamCommitted: undefined,
		onStreamArmed: undefined,
		admitLifecycle: undefined,
		admitUpdate: undefined,
		awaitRecovery: undefined,
		recoveryPending: undefined,
		blockingMutation: undefined,
		pendingGateRemainingMs: () => 0,
	});
	const start = () =>
		session.start({
			origin: "ui",
			launch: async () => {
				launches++;
			},
		});
	return { session, start, launches: () => launches };
}
const markerLine = () => readFileSync(otaStreamingMarkerPath(), "utf8");
const unprivileged = process.getuid?.() !== 0;

test.if(unprivileged)(
	"a Start that cannot rewrite the carrying marker replaces it before launching",
	async () => {
		setCarryingOtaProtection(true);
		expect(markerLine()).toBe("carrying\n");
		chmodSync(otaStreamingMarkerPath(), 0o444);

		const live = launchSession(bootMarker);
		expect(await live.start()).toMatchObject({ result: "started" });
		expect(live.launches()).toBe(1);
		expect(markerLine()).toBe("");

		// The backend dies with the stream up and the engine stays silent.
		const restarted = await restartBackend();
		const next = launchSession(restarted);
		restarted.setCarryingOtaProtection(true);
		expect(await next.session.reconcile()).toBe("reconciling");
		expect(await next.start()).toMatchObject({ result: "busy" });
		expect(next.launches()).toBe(0);
		restarted.setCarryingOtaProtection(false);
		expect(markerPresent()).toBe(true);
		expect(inhibitorHeld).toBe(true);

		expect(await next.session.stop("operator")).toEqual({ result: "stopped" });
		await live.session.stop("operator");
	},
);

test.if(unprivileged)(
	"a Start that cannot take the carrying marker at all is refused before launch",
	async () => {
		setCarryingOtaProtection(true);
		chmodSync(otaStreamingMarkerPath(), 0o444);
		chmodSync(dirname(otaStreamingMarkerPath()), 0o500);

		const live = launchSession(bootMarker);
		expect(await live.start()).toMatchObject({ result: "failed" });
		expect(live.launches()).toBe(0);
		expect(live.session.snapshot().state).toBe("idle");
		expect(markerLine()).toBe("carrying\n");

		// Nothing was launched, so the line is still true for the next process.
		chmodSync(dirname(otaStreamingMarkerPath()), 0o700);
		const restarted = await restartBackend();
		const next = launchSession(restarted);
		restarted.setCarryingOtaProtection(true);
		expect(await next.session.reconcile()).toBe("idle");
		expect(await next.start()).toMatchObject({ result: "started" });
		expect(markerLine()).toBe("");
		expect(await next.session.stop("operator")).toEqual({ result: "stopped" });
		restarted.setCarryingOtaProtection(false);
		expect(markerPresent()).toBe(false);
	},
);

/** A Start parked in shutdown admission, as while logind answers. */
async function pendingStart() {
	const reached = Promise.withResolvers<void>();
	const admission = Promise.withResolvers<boolean>();
	const live = launchSession(bootMarker, () => {
		reached.resolve();
		return admission.promise;
	});
	const starting = live.start();
	await reached.promise;
	return { ...live, starting, admit: () => admission.resolve(true) };
}

test("carrying may come and go while a Start waits for shutdown protection", async () => {
	setCarryingOtaProtection(true);
	const live = await pendingStart();
	// Nothing is taken before the launch, so the line is still true here.
	expect(markerLine()).toBe("carrying\n");
	setCarryingOtaProtection(false);
	expect(markerPresent()).toBe(false);
	setCarryingOtaProtection(true);
	expect(markerLine()).toBe("carrying\n");

	live.admit();
	expect(await live.starting).toMatchObject({ result: "started" });
	expect(markerLine()).toBe("");
	const restarted = await restartBackend();
	restarted.setCarryingOtaProtection(true);
	expect(restarted.encoderOtaStreamLiveness()).toBe("unknown");
	expect(await live.session.stop("operator")).toEqual({ result: "stopped" });
	restarted.clearOtaStreamingMarker();
	restarted.setCarryingOtaProtection(false);
});

test.if(unprivileged)(
	"a line restored while a Start waits cannot ride along with the launch",
	async () => {
		setCarryingOtaProtection(true);
		const live = await pendingStart();
		setCarryingOtaProtection(false);
		setCarryingOtaProtection(true);
		chmodSync(otaStreamingMarkerPath(), 0o444);
		chmodSync(dirname(otaStreamingMarkerPath()), 0o500);

		live.admit();
		expect(await live.starting).toMatchObject({ result: "failed" });
		expect(live.launches()).toBe(0);
		expect(live.session.snapshot().state).toBe("idle");
		expect(markerLine()).toBe("carrying\n");

		// Nothing was launched: the next process is right to call the box idle.
		chmodSync(dirname(otaStreamingMarkerPath()), 0o700);
		chmodSync(otaStreamingMarkerPath(), 0o600);
		const restarted = await restartBackend();
		const next = launchSession(restarted);
		restarted.setCarryingOtaProtection(true);
		expect(await next.session.reconcile()).toBe("idle");
		expect(await next.start()).toMatchObject({ result: "started" });
		expect(markerLine()).toBe("");
		expect(await next.session.stop("operator")).toEqual({ result: "stopped" });
		restarted.setCarryingOtaProtection(false);
		expect(markerPresent()).toBe(false);
	},
);

test("a Start cancelled in admission leaves the marker to carrying", async () => {
	setCarryingOtaProtection(true);
	const live = await pendingStart();
	expect(await live.session.stop("operator")).toEqual({ result: "stopped" });
	live.admit();
	expect(await live.starting).toMatchObject({ result: "cancelled" });
	expect(live.launches()).toBe(0);
	expect(markerLine()).toBe("carrying\n");

	// A restart before the hold ends must not be stuck behind an empty marker.
	const restarted = await restartBackend();
	const next = launchSession(restarted);
	restarted.setCarryingOtaProtection(true);
	expect(await next.session.reconcile()).toBe("idle");
	restarted.setCarryingOtaProtection(false);
	expect(markerPresent()).toBe(false);
	expect(inhibitorHeld).toBe(false);
	expect(await next.start()).toMatchObject({ result: "started" });
	expect(await next.session.stop("operator")).toEqual({ result: "stopped" });
	expect(markerPresent()).toBe(false);
});

test("a failed launch under carrying hands the marker back", async () => {
	setCarryingOtaProtection(true);
	const session = createStreamSessionOrchestrator({
		...streamSessionProductionDeps,
		createAttemptId: () => "failing",
		setStreamingStatus: () => undefined,
		getStreamingStatus: () => false,
		seedLifecycleState: () => undefined,
		setLifecycleState: () => undefined,
		queryRuntime: async () => "idle",
		stopRuntime: async () => undefined,
		onStreamStopped: () => undefined,
		onStreamCommitted: undefined,
		onStreamArmed: undefined,
		admitLifecycle: undefined,
		admitUpdate: undefined,
		awaitRecovery: undefined,
		recoveryPending: undefined,
		blockingMutation: undefined,
		pendingGateRemainingMs: () => 0,
		reportRetry: () => undefined,
		reportTerminalFailure: () => undefined,
	});
	const result = await session.start({
		origin: "ui",
		launch: async () => {
			throw new Error("no encoder");
		},
	});
	expect(result.result).not.toBe("started");
	if (session.snapshot().state !== "idle") await session.stop("operator");
	expect(session.snapshot().state).toBe("idle");
	expect(markerLine()).toBe("carrying\n");
	const restarted = await restartBackend();
	expect(restarted.encoderOtaStreamLiveness()).toBe("unknown");
	expect(restarted.otaMarkerAwaitsIdleWitness()).toBe(true);
	restarted.setCarryingOtaProtection(true);
	restarted.setCarryingOtaProtection(false);
	// Unwitnessed, the line outlasts the hold.
	expect(markerLine()).toBe("carrying\n");
	restarted.clearOtaStreamingMarker();
	expect(markerPresent()).toBe(false);
});

/**
 * Review regression (third pass on the carrying line): the line is only what
 * the previous process knew at its last write. Another control client started
 * the engine while the marker could be neither rewritten nor replaced, the
 * line stayed beside the stream, and the next process called it idle. A
 * restart now needs the engine to agree before the line counts.
 */
const lockMarker = () => {
	chmodSync(otaStreamingMarkerPath(), 0o444);
	chmodSync(dirname(otaStreamingMarkerPath()), 0o500);
};
const unlockMarker = () => {
	chmodSync(dirname(otaStreamingMarkerPath()), 0o700);
	chmodSync(otaStreamingMarkerPath(), 0o600);
};

test("a restart during a stream this backend launched adopts it and refuses a second start", async () => {
	setCarryingOtaProtection(true);
	const live = launchSession(bootMarker);
	expect(await live.start()).toMatchObject({ result: "started" });
	expect(markerLine()).toBe("");

	const restarted = await restartBackend();
	const next = launchSession(restarted, undefined, () => "streaming");
	restarted.setCarryingOtaProtection(true);
	expect(await next.session.reconcile()).toBe("streaming");
	expect(await next.start()).toMatchObject({ result: "busy" });
	expect(next.launches()).toBe(0);
	restarted.setCarryingOtaProtection(false);
	expect(markerLine()).toBe("");
	expect(inhibitorHeld).toBe(true);
	expect(await next.session.stop("operator")).toEqual({ result: "stopped" });
	expect(markerPresent()).toBe(false);
	expect(inhibitorHeld).toBe(false);
	await live.session.stop("operator");
});

test.if(unprivileged)(
	"a stream another client started beside an unwritable line is adopted again after a restart",
	async () => {
		setCarryingOtaProtection(true);
		// The engine runs a session this backend did not launch.
		const first = launchSession(bootMarker, undefined, () => "streaming");
		lockMarker();
		expect(await first.session.reconcile()).toBe("streaming");
		// Neither the rewrite nor the replacement could take the file.
		expect(markerLine()).toBe("carrying\n");

		// Storage recovers, the backend restarts, the stream is still up.
		unlockMarker();
		const restarted = await restartBackend();
		const next = launchSession(restarted, undefined, () => "streaming");
		restarted.setCarryingOtaProtection(true);
		expect(restarted.encoderOtaStreamLiveness()).toBe("unknown");
		expect(await next.session.reconcile()).toBe("streaming");
		expect(markerLine()).toBe("");
		expect(await next.start()).toMatchObject({ result: "busy" });
		expect(next.launches()).toBe(0);
		restarted.setCarryingOtaProtection(false);
		expect(markerPresent()).toBe(true);
		expect(inhibitorHeld).toBe(true);
		expect(await next.session.stop("operator")).toEqual({ result: "stopped" });
		expect(markerPresent()).toBe(false);
	},
);

test.if(unprivileged)(
	"the same stream behind an unreachable engine keeps the restart protected",
	async () => {
		setCarryingOtaProtection(true);
		const first = launchSession(bootMarker, undefined, () => "streaming");
		lockMarker();
		expect(await first.session.reconcile()).toBe("streaming");
		unlockMarker();
		expect(markerLine()).toBe("carrying\n");

		let engine: Engine = "unknown";
		const restarted = await restartBackend();
		const next = launchSession(restarted, undefined, () => engine);
		restarted.setCarryingOtaProtection(true);
		expect(await next.session.reconcile()).toBe("reconciling");
		expect(next.session.streamLiveness()).toBe("unknown");
		expect(await next.start()).toMatchObject({ result: "busy" });
		restarted.setCarryingOtaProtection(false);
		// The line stays, and so does the inhibitor: nothing has been witnessed.
		expect(markerLine()).toBe("carrying\n");
		expect(inhibitorHeld).toBe(true);

		// The engine is back (the reconnect loop reconciles again).
		engine = "streaming";
		expect(await next.session.reconcile()).toBe("streaming");
		expect(markerLine()).toBe("");
		expect(await next.session.stop("operator")).toEqual({ result: "stopped" });
		expect(markerPresent()).toBe(false);
		expect(inhibitorHeld).toBe(false);
	},
);

test("a restart during carrying only waits for a reachable engine before it is idle", async () => {
	setCarryingOtaProtection(true);
	let engine: Engine = "unknown";
	const restarted = await restartBackend();
	const next = launchSession(restarted, undefined, () => engine);
	restarted.setCarryingOtaProtection(true);
	expect(await next.session.reconcile()).toBe("reconciling");
	expect(await next.start()).toMatchObject({ result: "busy" });
	restarted.setCarryingOtaProtection(false);
	expect(markerLine()).toBe("carrying\n");
	expect(inhibitorHeld).toBe(true);

	// A third process in this state still finds the line, not an empty file.
	const third = await restartBackend();
	expect(third.otaMarkerAwaitsIdleWitness()).toBe(true);

	engine = "silent";
	expect(await next.session.reconcile()).toBe("idle");
	expect(markerPresent()).toBe(false);
	expect(inhibitorHeld).toBe(false);
	expect(await next.start()).toMatchObject({ result: "started" });
	expect(await next.session.stop("operator")).toEqual({ result: "stopped" });
	third.clearOtaStreamingMarker();
});

test("one silent answer is not enough when the next one hears a stream", async () => {
	setCarryingOtaProtection(true);
	const answers: Engine[] = ["silent", "streaming"];
	const restarted = await restartBackend();
	const { session } = bootSession(
		() => answers.shift() ?? "streaming",
		restarted,
	);
	restarted.setCarryingOtaProtection(true);
	expect(await session.reconcile()).toBe("streaming");
	expect(markerLine()).toBe("");
	expect(await session.stop("operator")).toEqual({ result: "stopped" });
	restarted.setCarryingOtaProtection(false);
});

test("one silent answer and then none keeps the line waiting", async () => {
	setCarryingOtaProtection(true);
	const answers: Engine[] = ["silent", "unknown"];
	const restarted = await restartBackend();
	const { session } = bootSession(
		() => answers.shift() ?? "unknown",
		restarted,
	);
	restarted.setCarryingOtaProtection(true);
	expect(await session.reconcile()).toBe("reconciling");
	restarted.setCarryingOtaProtection(false);
	expect(markerLine()).toBe("carrying\n");
	expect(inhibitorHeld).toBe(true);
	restarted.clearOtaStreamingMarker();
});

test("a line left by the previous release is confirmed like this release's own", async () => {
	// The marker format is unchanged: a backend with only the plain line wrote it.
	writeFileSync(otaStreamingMarkerPath(), "carrying\n");
	const restarted = await restartBackend();
	const { session } = bootSession("silent", restarted);
	restarted.setCarryingOtaProtection(true);
	expect(await session.reconcile()).toBe("idle");
	restarted.setCarryingOtaProtection(false);
	expect(markerPresent()).toBe(false);
	expect(inhibitorHeld).toBe(false);
});

test("a marker from a backend without the carrying line stays protected on a silent engine", async () => {
	// Older backends wrote an empty marker for carrying too: it is a stream's.
	writeFileSync(otaStreamingMarkerPath(), "");
	const restarted = await restartBackend();
	const { session, queries } = bootSession("silent", restarted);
	restarted.setCarryingOtaProtection(true);
	expect(await session.reconcile()).toBe("reconciling");
	expect(queries()).toBe(1);
	restarted.setCarryingOtaProtection(false);
	expect(markerLine()).toBe("");
	expect(inhibitorHeld).toBe(true);
	expect(await session.stop("operator")).toEqual({ result: "stopped" });
	expect(markerPresent()).toBe(false);
});

test("a torn line is not a line, even to a silent engine", async () => {
	writeFileSync(otaStreamingMarkerPath(), "carr");
	const restarted = await restartBackend();
	const next = launchSession(restarted);
	restarted.setCarryingOtaProtection(true);
	expect(await next.session.reconcile()).toBe("reconciling");
	expect(await next.start()).toMatchObject({ result: "busy" });
	expect(next.launches()).toBe(0);
	expect(await next.session.stop("operator")).toEqual({ result: "stopped" });
	restarted.setCarryingOtaProtection(false);
	expect(markerPresent()).toBe(false);
});
