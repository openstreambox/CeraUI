/**
 * Field regression (two bench boards, image 6 CeraUI): after a backend restart
 * with the engine idle and no client traffic (a package install, a service
 * restart), `system.sshStart` and every power action answered
 * `stream_liveness_unknown` for two minutes. The restarted process took the
 * carrying startup hold on every restart within a boot, even when its
 * predecessor had nothing to protect, so the hold stood in for evidence that
 * never existed.
 *
 * The predecessor publishes every protection it holds in the OTA streaming
 * marker, which `/run/ceralive` keeps across a restart. These tests replay the
 * restart against that real file: a fresh marker module instance and a fresh
 * tracker are the restarted process, the boot claim tells it from the first
 * start, and the production gate decides.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { currentRuntimeObservationSilence } from "../modules/streaming/engine-runtime-observation.ts";
import * as bootMarker from "../modules/streaming/ota-streaming-marker.ts";
import {
	clearOtaStreamingMarker,
	initialOtaStreamLiveness,
	otaStreamingMarkerPath,
	setCarryingOtaProtection,
} from "../modules/streaming/ota-streaming-marker.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import type { EngineRuntimeState } from "../modules/streaming/streaming-backend.ts";
import { CarryingTracker } from "../modules/system/carrying.ts";
import {
	claimFirstStartThisBoot,
	restartNeedsCarryingHold,
} from "../modules/system/carrying-runtime.ts";
import { decideDisruptiveAction } from "../modules/system/disruptive-action-gate.ts";
import { initShutdownProtection } from "../modules/system/shutdown-protection.ts";
import { deriveStreamLiveness } from "../modules/system/stream-liveness-source.ts";

let inhibitorHeld = false;
initShutdownProtection(() => {
	inhibitorHeld = true;
	return () => {
		inhibitorHeld = false;
	};
});

type MarkerModule = typeof bootMarker;
/** `silent` is how an idle engine answers: reachable, no status pushed. */
type Engine = EngineRuntimeState | "silent";

let claimDir = "";
let claimPath = "";
const markerPresent = () => existsSync(otaStreamingMarkerPath());

function resetOwners() {
	chmodSync(dirname(otaStreamingMarkerPath()), 0o700);
	setCarryingOtaProtection(false);
	clearOtaStreamingMarker();
	rmSync(otaStreamingMarkerPath(), { force: true });
}
beforeEach(() => {
	resetOwners();
	claimDir = mkdtempSync(join(tmpdir(), "carrying-restart-hold-"));
	claimPath = join(claimDir, "carrying-boot-claim");
});
afterEach(() => {
	resetOwners();
	rmSync(claimDir, { recursive: true, force: true });
});

let restarts = 0;
const restartMarker = (): Promise<MarkerModule> =>
	import(`../modules/streaming/ota-streaming-marker.ts?hold=${++restarts}`);

/**
 * One backend process: its own marker owner, carrying tracker and session.
 * `initCarrying()` runs at import, before the first reconciliation, and reads
 * the claim and the marker before it publishes anything itself.
 */
function startProcess(marker: MarkerModule, engine: () => Engine) {
	const firstStartThisBoot = claimFirstStartThisBoot(claimPath);
	const markerAtStart = initialOtaStreamLiveness();
	const hold = restartNeedsCarryingHold(firstStartThisBoot, markerAtStart);
	const tracker = new CarryingTracker();
	// What `publishCarrying()` does with the tracker's state.
	const publish = (now: number) =>
		marker.setCarryingOtaProtection(tracker.read(now) !== "idle");
	if (hold) tracker.start(0);
	tracker.upload(0, null);
	publish(0);
	const session = createStreamSessionOrchestrator({
		...streamSessionProductionDeps,
		initialLiveness: marker.encoderOtaStreamLiveness,
		markStreamingForOta: marker.setOtaStreamingMarker,
		unmarkStreamingForOta: marker.clearOtaStreamingMarker,
		confirmStreamingForOta: marker.adoptOtaStreamingMarker,
		awaitsIdleWitness: marker.otaMarkerAwaitsIdleWitness,
		engineStopped: async () => false,
		createAttemptId: () => "restart",
		setStreamingStatus: () => undefined,
		getStreamingStatus: () => engine() === "streaming",
		seedLifecycleState: () => undefined,
		setLifecycleState: () => undefined,
		queryRuntime: async (): Promise<EngineRuntimeState> => {
			const now = engine();
			if (now !== "silent") return now;
			currentRuntimeObservationSilence()();
			return "unknown";
		},
		stopRuntime: async () => undefined,
		onStreamStopped: () => undefined,
	});
	/** A carrying sample, as `tickCarrying()` takes on the 5 s heartbeat. */
	const sample = (now: number, bytes: Readonly<Record<string, number>>) => {
		tracker.upload(now, bytes);
		publish(now);
	};
	/** The SSH switch and power actions: `getDisruptiveActionDecision()`. */
	const gate = (now: number) => {
		const leaf = session.streamLiveness();
		return decideDisruptiveAction({
			streamLiveness: deriveStreamLiveness({
				carrying: tracker.read(now),
				reconciled: true,
				live: leaf === "streaming",
				lifecycle: session.snapshot().state,
				sentinel: leaf === "idle" ? "absent" : "unknown",
			}),
			updateBusy: [],
		});
	};
	return { hold, tracker, session, sample, gate };
}

const quiet = { eth1: 10 };

/** An idle first process that ran past its first samples, then went away. */
async function idleFirstProcess() {
	const first = startProcess(bootMarker, () => "silent");
	expect(first.hold).toBe(false);
	expect(await first.session.reconcile()).toBe("idle");
	first.sample(5_000, quiet);
	expect(first.gate(5_000)).toEqual({ allowed: true });
	expect(markerPresent()).toBe(false);
	return first;
}

test("a restart after an idle process admits SSH on its first quiet sample", async () => {
	await idleFirstProcess();

	// The package's postinst restarts the backend: same boot, empty marker dir.
	const restarted = startProcess(await restartMarker(), () => "silent");
	expect(restarted.hold).toBe(false);
	expect(await restarted.session.reconcile()).toBe("idle");
	restarted.sample(5_000, quiet);
	expect(restarted.gate(5_000)).toEqual({ allowed: true });
	expect(markerPresent()).toBe(false);
	expect(inhibitorHeld).toBe(false);
});

test("a restart after an idle process whose engine reports idle is admitted too", async () => {
	await idleFirstProcess();
	const restarted = startProcess(await restartMarker(), () => "idle");
	expect(restarted.hold).toBe(false);
	expect(await restarted.session.reconcile()).toBe("idle");
	restarted.sample(5_000, quiet);
	expect(restarted.gate(5_000)).toEqual({ allowed: true });
});

test("before the first counter sample a restarted process still says unknown", async () => {
	await idleFirstProcess();
	const restarted = startProcess(await restartMarker(), () => "silent");
	await restarted.session.reconcile();
	// The sampler has not read the client counters yet: no evidence, no idle.
	expect(restarted.gate(0)).toEqual({
		allowed: false,
		reason: "stream_liveness_unknown",
	});
});

test("a restart while a phone was carried keeps the two-minute hold", async () => {
	const first = startProcess(bootMarker, () => "silent");
	await first.session.reconcile();
	// 2 Mbit/s of client upload long enough to count as carrying.
	let bytes = 0;
	for (let at = 1_000; at <= 30_000; at += 1_000) {
		bytes += 250_000;
		first.sample(at, { eth1: bytes });
	}
	expect(first.gate(30_000)).toEqual({ allowed: false, reason: "streaming" });
	expect(markerPresent()).toBe(true);

	const restarted = startProcess(await restartMarker(), () => "silent");
	expect(restarted.hold).toBe(true);
	expect(await restarted.session.reconcile()).toBe("idle");
	// Quiet counters do not end the hold: the earlier process's evidence is lost.
	restarted.sample(5_000, quiet);
	restarted.sample(119_000, quiet);
	expect(restarted.gate(119_000)).toEqual({
		allowed: false,
		reason: "stream_liveness_unknown",
	});
	restarted.sample(121_000, quiet);
	restarted.sample(122_000, quiet);
	expect(restarted.gate(122_000)).toEqual({ allowed: true });
	expect(markerPresent()).toBe(false);
});

test("a restart beside a stream with an unreachable engine stays unknown after the hold", async () => {
	// The earlier process's stream left the empty marker.
	writeFileSync(otaStreamingMarkerPath(), "");
	claimFirstStartThisBoot(claimPath);

	const restarted = startProcess(await restartMarker(), () => "unknown");
	expect(restarted.hold).toBe(true);
	expect(await restarted.session.reconcile()).toBe("reconciling");
	restarted.sample(121_000, quiet);
	restarted.sample(122_000, quiet);
	expect(restarted.tracker.read(122_000)).toBe("idle");
	expect(restarted.gate(122_000)).toEqual({
		allowed: false,
		reason: "stream_liveness_unknown",
	});
	expect(markerPresent()).toBe(true);
	expect(inhibitorHeld).toBe(true);
});

test("a marker that cannot be examined keeps the hold", () => {
	const notADirectory = join(claimDir, "file");
	writeFileSync(notADirectory, "");
	const unreadable = initialOtaStreamLiveness(join(notADirectory, "streaming"));
	expect(unreadable).toBe("unknown");
	expect(restartNeedsCarryingHold(false, unreadable)).toBe(true);
});

test("the first start of a boot never takes the hold, whatever the marker says", () => {
	expect(restartNeedsCarryingHold(true, "idle")).toBe(false);
	expect(restartNeedsCarryingHold(true, "unknown")).toBe(false);
	expect(restartNeedsCarryingHold(false, "idle")).toBe(false);
	expect(restartNeedsCarryingHold(false, "unknown")).toBe(true);
});
