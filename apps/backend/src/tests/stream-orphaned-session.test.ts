/**
 * Bench regression (stock image, ROCK 5B+): a backend restart mid-stream ended
 * the sender (the unit kills its control group) but not the engine session,
 * and the stream's OTA marker stayed. The new process stayed `reconciling`:
 * Start answered START_IN_PROGRESS while the engine still ran the orphaned
 * session, and again after the engine's watchdog restarted it, because an idle
 * engine sends no status. Only an operator Stop got the box out, and the
 * marker deferred OTA activation the whole time.
 *
 * A later process now settles that session only on the earlier process's own
 * record of it (stream-provenance.ts): the recorded session, in the recorded
 * engine process, with nothing left that could carry it. Without that proof
 * nothing is stopped and an operator Stop is still the way out.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs, { existsSync, rmSync } from "node:fs";
import { currentRuntimeObservationSilence } from "../modules/streaming/engine-runtime-observation.ts";
import {
	createOtaMarkerOwner,
	otaStreamingMarkerPath,
} from "../modules/streaming/ota-streaming-marker.ts";
import {
	type OrphanRetirementDeps,
	retireOrphanedSession,
	type StreamProvenance,
} from "../modules/streaming/stream-provenance.ts";
import {
	createStreamSessionOrchestrator,
	type StreamSessionOrchestratorDeps,
} from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import type { EngineRuntimeState } from "../modules/streaming/streaming-backend.ts";

const markerPresent = () => existsSync(otaStreamingMarkerPath());
beforeEach(() => rmSync(otaStreamingMarkerPath(), { force: true }));
afterEach(() => rmSync(otaStreamingMarkerPath(), { force: true }));

/**
 * A backend process: its own marker owner and its own view of the shutdown
 * inhibitor. Only `/run` (the marker file) is shared between processes.
 */
function backendProcess() {
	const held = { encoder: false, carrying: false };
	const marker = createOtaMarkerOwner({
		path: otaStreamingMarkerPath,
		fs,
		setShutdownProtection: (owner, active) => {
			held[owner] = active;
			return true;
		},
	});
	return { marker, inhibitorHeld: () => held.encoder || held.carrying };
}

/** The previous process was streaming when it died: the stream's marker. */
function killedMidStream() {
	backendProcess().marker.takeEncoder();
	expect(markerPresent()).toBe(true);
}

const RECORD: StreamProvenance = {
	version: 1,
	bootId: "boot-1",
	sessionId: "cs-3",
	engine: { pid: 700, startTime: "1000" },
	sender: { pid: 4242, startTime: "3960195" },
};

/**
 * `silent`: the engine answered, sent no status and its snapshot shows no
 * session (an idle engine). `unknown`: no answer at all.
 */
type Engine = EngineRuntimeState | "silent";

function restarted(options: {
	engine: () => Engine;
	record?: StreamProvenance | undefined;
	retirement?: Partial<OrphanRetirementDeps>;
	ports?: Partial<StreamSessionOrchestratorDeps>;
}) {
	const { marker, inhibitorHeld } = backendProcess();
	const stops: string[] = [];
	const engineStops: number[] = [];
	let launches = 0;
	let orphanEvents = 0;
	const deps: OrphanRetirementDeps = {
		readRecord: () => options.record,
		bootId: () => "boot-1",
		carrierAbsent: () => true,
		engineProcess: async () => RECORD.engine,
		stopRecordedSession: async (sessionId, beforeDispatch) => {
			if (!beforeDispatch()) return false;
			stops.push(sessionId);
			return true;
		},
		...options.retirement,
	};
	const session = createStreamSessionOrchestrator({
		...streamSessionProductionDeps,
		initialLiveness: marker.liveness,
		markStreamingForOta: marker.takeEncoder,
		unmarkStreamingForOta: marker.releaseEncoder,
		confirmStreamingForOta: marker.adoptStream,
		awaitsIdleWitness: marker.awaitsIdleWitness,
		claimLaunchMarker: marker.claimForLaunch,
		protectUnownedEngineSession: marker.claimForLaunch,
		engineStopped: async () => false,
		retireOrphanedSession: (engine) => retireOrphanedSession(engine, deps),
		onOrphanedSessionStopped: () => {
			orphanEvents++;
		},
		createAttemptId: () => "orphan",
		setStreamingStatus: () => undefined,
		getStreamingStatus: () => false,
		seedLifecycleState: () => undefined,
		setLifecycleState: () => undefined,
		queryRuntime: async () => {
			const now = options.engine();
			if (now !== "silent") return now;
			currentRuntimeObservationSilence()();
			return "unknown";
		},
		stopRuntime: async () => {
			engineStops.push(1);
		},
		onStreamStopped: () => undefined,
		onStreamCommitted: undefined,
		onStreamArmed: undefined,
		admitLifecycle: undefined,
		admitUpdate: undefined,
		awaitRecovery: undefined,
		recoveryPending: undefined,
		blockingMutation: undefined,
		pendingGateRemainingMs: () => 0,
		...options.ports,
	});
	return {
		marker,
		session,
		inhibitorHeld,
		stops,
		engineStops,
		launches: () => launches,
		orphanEvents: () => orphanEvents,
		start: () =>
			session.start({
				origin: "ui",
				launch: async () => {
					launches++;
				},
			}),
	};
}

test("a recorded session whose sender died is stopped by its id, and Start launches", async () => {
	killedMidStream();
	let engine: Engine = "streaming";
	const next = restarted({
		engine: () => engine,
		record: RECORD,
		retirement: {
			stopRecordedSession: async (sessionId, beforeDispatch) => {
				if (!beforeDispatch()) return false;
				next.stops.push(sessionId);
				engine = "silent";
				return true;
			},
		},
	});

	expect(await next.session.reconcile()).toBe("idle");
	expect(next.stops).toEqual(["cs-3"]);
	// No blind engine stop: only the recorded session's.
	expect(next.engineStops).toEqual([]);
	expect(next.orphanEvents()).toBe(1);
	expect(markerPresent()).toBe(false);
	expect(next.inhibitorHeld()).toBe(false);
	expect(await next.start()).toMatchObject({ result: "started" });
	expect(next.launches()).toBe(1);
});

test("after the engine restarted, a recorded marker beside a silent engine settles without a stop", async () => {
	killedMidStream();
	const next = restarted({ engine: () => "silent", record: RECORD });
	expect(await next.session.reconcile()).toBe("idle");
	expect(next.stops).toEqual([]);
	expect(next.engineStops).toEqual([]);
	expect(next.orphanEvents()).toBe(0);
	expect(markerPresent()).toBe(false);
	expect(next.inhibitorHeld()).toBe(false);
	expect(await next.start()).toMatchObject({ result: "started" });
});

test("a clean boot beside a silent engine stops nothing", async () => {
	const next = restarted({ engine: () => "silent", record: RECORD });
	expect(await next.session.reconcile()).toBe("idle");
	expect(next.stops).toEqual([]);
	expect(next.engineStops).toEqual([]);
	expect(markerPresent()).toBe(false);
});

/** Review probe: a direct session with no marker and no record. */
test("an engine session with no record of this boot is never stopped", async () => {
	const direct = restarted({ engine: () => "streaming", record: undefined });
	expect(await direct.session.reconcile()).toBe("reconciling");
	expect(direct.stops).toEqual([]);
	expect(direct.engineStops).toEqual([]);
	expect(await direct.start()).toMatchObject({ result: "busy" });

	killedMidStream();
	const marked = restarted({ engine: () => "silent", record: undefined });
	expect(await marked.session.reconcile()).toBe("reconciling");
	expect(marked.stops).toEqual([]);
	expect(markerPresent()).toBe(true);
	expect(marked.inhibitorHeld()).toBe(true);
});

/** Review probe: a sender under another name; the port check covers it. */
test("a session something may still carry keeps today's protection", async () => {
	killedMidStream();
	const next = restarted({
		engine: () => "streaming",
		record: RECORD,
		retirement: { carrierAbsent: () => false },
	});
	expect(await next.session.reconcile()).toBe("reconciling");
	expect(next.stops).toEqual([]);
	expect(await next.start()).toMatchObject({ result: "busy" });
	expect(markerPresent()).toBe(true);
	expect(next.inhibitorHeld()).toBe(true);
});

/** Review probe: a sender that comes back while the stop is being prepared. */
test("a carrier that appears before the stop is written leaves the session running", async () => {
	killedMidStream();
	let checks = 0;
	const next = restarted({
		engine: () => "streaming",
		record: RECORD,
		retirement: { carrierAbsent: () => ++checks === 1 },
	});
	expect(await next.session.reconcile()).toBe("reconciling");
	expect(checks).toBe(2);
	expect(next.stops).toEqual([]);
	expect(markerPresent()).toBe(true);
});

test("another session, or another engine process, is never stopped", async () => {
	killedMidStream();
	const otherSession = restarted({
		engine: () => "streaming",
		record: RECORD,
		retirement: {
			stopRecordedSession: async () => false, // the snapshot names cs-4
		},
	});
	expect(await otherSession.session.reconcile()).toBe("reconciling");
	expect(otherSession.engineStops).toEqual([]);

	const otherEngine = restarted({
		engine: () => "streaming",
		record: RECORD,
		retirement: { engineProcess: async () => ({ pid: 700, startTime: "2" }) },
	});
	expect(await otherEngine.session.reconcile()).toBe("reconciling");
	expect(otherEngine.stops).toEqual([]);
	expect(markerPresent()).toBe(true);
});

test("an engine that cannot be reached is not asked to stop anything", async () => {
	killedMidStream();
	const next = restarted({ engine: () => "unknown", record: RECORD });
	expect(await next.session.reconcile()).toBe("reconciling");
	expect(next.stops).toEqual([]);
	expect(await next.start()).toMatchObject({ result: "busy" });
	expect(markerPresent()).toBe(true);
});

/** Review probe: the retry must not depend on generation zero. */
test("after a Start refused for an update, a later Start still retries the leftover session", async () => {
	let updating = true;
	let engine: Engine = "silent";
	let stopWorks = false;
	let admissions = 0;
	const next = restarted({
		engine: () => engine,
		record: RECORD,
		retirement: {
			stopRecordedSession: async (sessionId, beforeDispatch) => {
				if (!stopWorks) throw new Error("engine control socket unavailable");
				if (!beforeDispatch()) return false;
				next.stops.push(sessionId);
				engine = "silent";
				return true;
			},
		},
		ports: {
			admitUpdate: async () => {
				admissions++;
				return updating
					? {
							allowed: false,
							reason: "update_in_progress",
							phase: "committing",
							percent: 0,
							etaSeconds: 0,
						}
					: { allowed: true };
			},
		},
	});
	// Idle boot; a Start is refused by the update orchestrator (generation 1).
	expect(await next.start()).toMatchObject({ result: "failed" });
	expect(admissions).toBe(1);
	expect(next.session.snapshot().generation).toBeGreaterThan(0);
	// The recorded session turns up and the first stop fails.
	engine = "streaming";
	expect(await next.session.reconcile()).toBe("reconciling");
	expect(next.stops).toEqual([]);
	// The engine answers again and the update finished: Start settles and launches.
	updating = false;
	stopWorks = true;
	expect(await next.start()).toMatchObject({ result: "started" });
	expect(next.stops).toEqual(["cs-3"]);
	expect(next.launches()).toBe(1);
});

test("after the stop the marker says only what carrying still holds", async () => {
	killedMidStream();
	let engine: Engine = "streaming";
	const next = restarted({
		engine: () => engine,
		record: RECORD,
		retirement: {
			stopRecordedSession: async (_id, beforeDispatch) => {
				if (!beforeDispatch()) return false;
				engine = "silent";
				return true;
			},
		},
	});
	next.marker.setCarrying(true);
	expect(await next.session.reconcile()).toBe("idle");
	expect(markerPresent()).toBe(true);
	expect(next.marker.liveness()).toBe("idle");
	next.marker.setCarrying(false);
	expect(markerPresent()).toBe(false);
	expect(next.inhibitorHeld()).toBe(false);
});

test("a session this process launched is never settled as an earlier process's", async () => {
	let engine: Engine = "silent";
	const own = restarted({ engine: () => engine, record: RECORD });
	expect(await own.start()).toMatchObject({ result: "started" });
	// Its own sender died: the engine streams and nothing carries it.
	engine = "streaming";
	expect(await own.session.reconcile()).toBe("reconciling");
	expect(own.stops).toEqual([]);
	expect(markerPresent()).toBe(true);
	expect(await own.session.stop("operator")).toEqual({ result: "stopped" });
});
