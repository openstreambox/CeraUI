/**
 * Bench regression (stock image, ROCK 5B+): a hostname change restarted the
 * backend mid-stream. The old process stopped its sender on SIGTERM, but the
 * engine kept the session and the empty stream marker stayed in `/run`. The
 * new process could only reach `reconciling`: first because the engine still
 * reported a session it did not own, then, after the engine's watchdog
 * restarted it, because an idle engine sends no status at all. Every Start
 * answered START_IN_PROGRESS through further engine and backend restarts until
 * an operator Stop, and the marker deferred OTA activation the whole time.
 *
 * Every session this backend launches sends to a local `srtla_send`. With no
 * sender anywhere, a session left by an earlier process carries nothing, so
 * reconciliation stops it the way that operator Stop did and only then reads
 * idle. With a sender still running, nothing changes.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentRuntimeObservationSilence } from "../modules/streaming/engine-runtime-observation.ts";
import type * as markerModule from "../modules/streaming/ota-streaming-marker.ts";
import { otaStreamingMarkerPath } from "../modules/streaming/ota-streaming-marker.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
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

type MarkerModule = typeof markerModule;
let processes = 0;
/** A fresh module instance is a new backend process: only `/run` survives. */
const backendProcess = (): Promise<MarkerModule> =>
	import(
		`../modules/streaming/ota-streaming-marker.ts?senderless=${++processes}`
	);

const markerPresent = () => existsSync(otaStreamingMarkerPath());
const senderPid = () =>
	join(process.env.CERALIVE_SENDER_CENSUS_PROC_ROOT ?? "", "4242");
/** A `srtla_send` this backend did not start, as the census reads it. */
function startForeignSender() {
	mkdirSync(senderPid(), { recursive: true });
	writeFileSync(join(senderPid(), "comm"), "srtla_send\n");
}

const owners: MarkerModule[] = [];
function reset() {
	rmSync(senderPid(), { recursive: true, force: true });
	for (const owner of owners.splice(0)) {
		owner.setCarryingOtaProtection(false);
		owner.clearOtaStreamingMarker();
	}
	rmSync(otaStreamingMarkerPath(), { force: true });
}
beforeEach(reset);
afterEach(reset);

/** The previous process was streaming when it died: the stream's empty marker. */
async function killedMidStream(): Promise<void> {
	const previous = await backendProcess();
	owners.push(previous);
	previous.setOtaStreamingMarker();
	expect(markerPresent()).toBe(true);
}

/**
 * What the engine answers: `silent` is a reachable engine that sent no status
 * and reported no session (an idle engine), `unknown` no answer at all.
 */
type Engine = EngineRuntimeState | "silent";

/** The restarted process's production session; engine and stop are fakes. */
async function restarted(
	engine: () => Engine,
	stop: (confirmUnknown: boolean | undefined) => Promise<void> = async () =>
		undefined,
) {
	const marker = await backendProcess();
	owners.push(marker);
	const stops: Array<boolean | undefined> = [];
	let launches = 0;
	const session = createStreamSessionOrchestrator({
		...streamSessionProductionDeps,
		initialLiveness: marker.encoderOtaStreamLiveness,
		markStreamingForOta: marker.setOtaStreamingMarker,
		unmarkStreamingForOta: marker.clearOtaStreamingMarker,
		confirmStreamingForOta: marker.adoptOtaStreamingMarker,
		awaitsIdleWitness: marker.otaMarkerAwaitsIdleWitness,
		claimLaunchMarker: marker.claimOtaMarkerForLaunch,
		protectUnownedEngineSession: marker.claimOtaMarkerForLaunch,
		engineStopped: async () => false,
		createAttemptId: () => "senderless",
		setStreamingStatus: () => undefined,
		getStreamingStatus: () => false,
		seedLifecycleState: () => undefined,
		setLifecycleState: () => undefined,
		queryRuntime: async () => {
			const now = engine();
			if (now !== "silent") return now;
			currentRuntimeObservationSilence()();
			return "unknown";
		},
		stopRuntime: async (_generation, confirmUnknown) => {
			stops.push(confirmUnknown);
			await stop(confirmUnknown);
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
	});
	return {
		marker,
		session,
		stops,
		launches: () => launches,
		start: () =>
			session.start({
				origin: "ui",
				launch: async () => {
					launches++;
				},
			}),
	};
}

test("a stream marker from a killed backend beside an idle engine is stopped, and Start works", async () => {
	await killedMidStream();
	const next = await restarted(() => "silent");
	expect(next.marker.encoderOtaStreamLiveness()).toBe("unknown");

	expect(await next.session.reconcile()).toBe("idle");
	// One stop, on the operator Stop's path that accepts an unanswered engine.
	expect(next.stops).toEqual([true]);
	expect(next.session.streamLiveness()).toBe("idle");
	expect(markerPresent()).toBe(false);
	expect(inhibitorHeld).toBe(false);

	expect(await next.start()).toMatchObject({ result: "started" });
	expect(next.launches()).toBe(1);
	expect(markerPresent()).toBe(true);
	expect(await next.session.stop("operator")).toEqual({ result: "stopped" });
	expect(markerPresent()).toBe(false);
});

test("an engine session whose sender died with the backend is stopped before Start", async () => {
	await killedMidStream();
	let engine: Engine = "streaming";
	const next = await restarted(
		() => engine,
		async () => {
			engine = "silent";
		},
	);

	expect(await next.session.reconcile()).toBe("idle");
	expect(next.stops).toHaveLength(1);
	expect(engine).toBe("silent");
	expect(markerPresent()).toBe(false);
	expect(inhibitorHeld).toBe(false);
	expect(await next.start()).toMatchObject({ result: "started" });
	expect(next.launches()).toBe(1);
	await next.session.stop("operator");
});

test("a sender still running keeps an unowned session protected until an operator Stop", async () => {
	await killedMidStream();
	startForeignSender();
	const next = await restarted(() => "streaming");

	expect(await next.session.reconcile()).toBe("reconciling");
	expect(next.stops).toEqual([]);
	expect(await next.start()).toMatchObject({ result: "busy" });
	expect(next.launches()).toBe(0);
	expect(markerPresent()).toBe(true);
	expect(inhibitorHeld).toBe(true);
});

test("a sender still running keeps a silent engine's stream marker protected", async () => {
	await killedMidStream();
	startForeignSender();
	const next = await restarted(() => "silent");
	expect(await next.session.reconcile()).toBe("reconciling");
	expect(next.stops).toEqual([]);
	expect(markerPresent()).toBe(true);
});

test("an engine that cannot be reached is not stopped and stays protected", async () => {
	await killedMidStream();
	const next = await restarted(() => "unknown");
	expect(await next.session.reconcile()).toBe("reconciling");
	expect(next.stops).toEqual([]);
	expect(await next.start()).toMatchObject({ result: "busy" });
	expect(markerPresent()).toBe(true);
	expect(inhibitorHeld).toBe(true);
});

test("a stop the engine does not acknowledge keeps protection, and Start retries it", async () => {
	await killedMidStream();
	// The engine died under the orphaned session; its restart answers silently.
	let acknowledged = false;
	const next = await restarted(
		() => "silent",
		async () => {
			if (!acknowledged) throw new Error("engine control socket unavailable");
		},
	);

	expect(await next.session.reconcile()).toBe("reconciling");
	expect(markerPresent()).toBe(true);
	expect(inhibitorHeld).toBe(true);
	expect(next.session.streamLiveness()).toBe("unknown");

	// The engine is back: the next Start retries the stop instead of refusing.
	acknowledged = true;
	expect(await next.start()).toMatchObject({ result: "started" });
	expect(next.stops).toEqual([true, true]);
	expect(next.launches()).toBe(1);
	await next.session.stop("operator");
	expect(markerPresent()).toBe(false);
});

test("a session this process launched is never stopped by reconciliation", async () => {
	let engine: Engine = "silent";
	const own = await restarted(() => engine);
	expect(await own.start()).toMatchObject({ result: "started" });

	// The engine reports streaming, and this process has no live sender child:
	// its own sender died. That keeps the old answer, an operator Stop.
	engine = "streaming";
	expect(await own.session.reconcile()).toBe("reconciling");
	expect(own.stops).toEqual([]);
	expect(markerPresent()).toBe(true);
	expect(await own.session.stop("operator")).toEqual({ result: "stopped" });
});

test("after the stop the marker says only what carrying holds", async () => {
	await killedMidStream();
	let engine: Engine = "streaming";
	const next = await restarted(
		() => engine,
		async () => {
			engine = "silent";
		},
	);
	// The restarted process takes its carrying hold before reconciling.
	next.marker.setCarryingOtaProtection(true);
	expect(await next.session.reconcile()).toBe("idle");
	expect(next.marker.encoderOtaStreamLiveness()).toBe("idle");
	expect(markerPresent()).toBe(true);

	// The hold ends: nothing is left that could defer an activation.
	next.marker.setCarryingOtaProtection(false);
	expect(markerPresent()).toBe(false);
	expect(inhibitorHeld).toBe(false);
});
