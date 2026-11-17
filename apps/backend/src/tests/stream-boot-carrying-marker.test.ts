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
import { existsSync, rmSync, writeFileSync } from "node:fs";
import {
	clearOtaStreamingMarker,
	encoderOtaStreamLiveness,
	otaStreamingMarkerPath,
	setCarryingOtaProtection,
	setOtaStreamingMarker,
} from "../modules/streaming/ota-streaming-marker.ts";
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

const markerPresent = () => existsSync(otaStreamingMarkerPath());

function resetOwners() {
	setCarryingOtaProtection(false);
	clearOtaStreamingMarker();
	rmSync(otaStreamingMarkerPath(), { force: true });
}

beforeEach(resetOwners);
afterEach(resetOwners);

/** The production session with only the engine and status sinks replaced. */
function bootSession(runtime: EngineRuntimeState) {
	let stops = 0;
	const session = createStreamSessionOrchestrator({
		...streamSessionProductionDeps,
		createAttemptId: () => "boot",
		setStreamingStatus: () => undefined,
		getStreamingStatus: () => runtime === "streaming",
		seedLifecycleState: () => undefined,
		setLifecycleState: () => undefined,
		queryRuntime: async () => runtime,
		stopRuntime: async () => {
			stops++;
		},
		onStreamStopped: () => undefined,
	});
	return { session, stops: () => stops };
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
