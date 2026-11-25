/**
 * Field regression (two bench boards, image 6 CeraUI): after a backend restart
 * with the engine idle and no client traffic (a package install, a service
 * restart), `system.sshStart` and every power action answered
 * `stream_liveness_unknown` for two minutes. The restarted process took the
 * carrying startup hold on every restart within a boot, even when its
 * predecessor had nothing to protect, so the hold stood in for evidence that
 * never existed.
 *
 * A restart now skips the hold only on positive evidence: the predecessor's
 * idle record, written after it published confirmed idle, and no OTA marker.
 * These tests replay the restart against the real files in a scratch
 * `/run/ceralive`: a fresh marker module instance, idle record and tracker are
 * the restarted process, built in production order (the session at import,
 * then `initCarrying()`, then reconciliation opening the latch), with the
 * production publication order and the production gate.
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
	createCarryingIdleRecord,
	persistCarryingProtection,
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
let idlePath = "";
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
	idlePath = join(claimDir, "carrying-idle");
});
afterEach(() => {
	resetOwners();
	rmSync(claimDir, { recursive: true, force: true });
});

let restarts = 0;
const restartMarker = (): Promise<MarkerModule> =>
	import(`../modules/streaming/ota-streaming-marker.ts?hold=${++restarts}`);

/**
 * One backend process: its own marker owner, idle record, carrying tracker and
 * session. The session is built at import; `initCarrying()` then reads the
 * claim, the idle record and the marker before it publishes anything itself;
 * the latch opens only once reconciliation returns. `markerWrites` false makes
 * every carrying marker write fail, as on a full or unwritable `/run`.
 */
function startProcess(
	marker: MarkerModule,
	engine: () => Engine,
	options: { markerWrites?: boolean } = {},
) {
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
	const idleRecord = createCarryingIdleRecord(() => idlePath);
	const firstStartThisBoot = claimFirstStartThisBoot(claimPath);
	const hold = restartNeedsCarryingHold(firstStartThisBoot, {
		idleRecord: idleRecord.present(),
		marker: initialOtaStreamLiveness(),
	});
	const tracker = new CarryingTracker();
	let markerProtected: boolean | undefined;
	// What `publishCarrying()` persists for the tracker's state.
	const publish = (now: number) => {
		markerProtected = persistCarryingProtection(
			tracker.read(now) !== "idle",
			markerProtected,
			{
				setMarker: (protect) =>
					options.markerWrites === false
						? false
						: marker.setCarryingOtaProtection(protect),
				idleRecord,
			},
		);
	};
	if (hold) tracker.start(0);
	tracker.upload(0, null);
	publish(0);
	let reconciled = false;
	const reconcile = async () => {
		const state = await session.reconcile();
		reconciled = true;
		return state;
	};
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
				reconciled,
				live: leaf === "streaming",
				lifecycle: session.snapshot().state,
				sentinel: leaf === "idle" ? "absent" : "unknown",
			}),
			updateBusy: [],
		});
	};
	return { hold, tracker, session, reconcile, sample, gate, idleRecord };
}

const quiet = { eth1: 10 };

/** An idle first process that ran past its first samples, then went away. */
async function idleFirstProcess() {
	const first = startProcess(bootMarker, () => "silent");
	expect(first.hold).toBe(false);
	expect(await first.reconcile()).toBe("idle");
	first.sample(5_000, quiet);
	expect(first.gate(5_000)).toEqual({ allowed: true });
	expect(markerPresent()).toBe(false);
	expect(existsSync(idlePath)).toBe(true);
	return first;
}

test("a restart after an idle process admits SSH on its first quiet sample", async () => {
	await idleFirstProcess();

	// The package's postinst restarts the backend: same boot, empty marker dir.
	const restarted = startProcess(await restartMarker(), () => "silent");
	expect(restarted.hold).toBe(false);
	expect(await restarted.reconcile()).toBe("idle");
	restarted.sample(5_000, quiet);
	expect(restarted.gate(5_000)).toEqual({ allowed: true });
	expect(markerPresent()).toBe(false);
	expect(inhibitorHeld).toBe(false);
});

test("a restart after an idle process whose engine reports idle is admitted too", async () => {
	await idleFirstProcess();
	const restarted = startProcess(await restartMarker(), () => "idle");
	expect(restarted.hold).toBe(false);
	expect(await restarted.reconcile()).toBe("idle");
	restarted.sample(5_000, quiet);
	expect(restarted.gate(5_000)).toEqual({ allowed: true });
});

test("before the first counter sample a restarted process still says unknown", async () => {
	await idleFirstProcess();
	const restarted = startProcess(await restartMarker(), () => "silent");
	await restarted.reconcile();
	// The sampler has not read the client counters yet: no evidence, no idle.
	expect(restarted.gate(0)).toEqual({
		allowed: false,
		reason: "stream_liveness_unknown",
	});
});

test("a restart while a phone was carried keeps the two-minute hold", async () => {
	const first = startProcess(bootMarker, () => "silent");
	await first.reconcile();
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
	expect(await restarted.reconcile()).toBe("idle");
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
	expect(await restarted.reconcile()).toBe("reconciling");
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

test("before reconciliation returns a restarted process says unknown", async () => {
	await idleFirstProcess();
	const restarted = startProcess(await restartMarker(), () => "silent");
	restarted.sample(5_000, quiet);
	expect(restarted.gate(5_000)).toEqual({
		allowed: false,
		reason: "stream_liveness_unknown",
	});
	await restarted.reconcile();
	expect(restarted.gate(5_000)).toEqual({ allowed: true });
});

test("a carrying marker write that failed keeps the hold for the next process", async () => {
	await idleFirstProcess();
	// The second process carries a phone but cannot write its marker.
	const failing = startProcess(await restartMarker(), () => "silent", {
		markerWrites: false,
	});
	expect(failing.hold).toBe(false);
	await failing.reconcile();
	let bytes = 0;
	for (let at = 1_000; at <= 30_000; at += 1_000) {
		bytes += 250_000;
		failing.sample(at, { eth1: bytes });
	}
	expect(failing.gate(30_000)).toEqual({ allowed: false, reason: "streaming" });
	// No marker on disk, but no idle record either.
	expect(markerPresent()).toBe(false);
	expect(existsSync(idlePath)).toBe(false);

	const restarted = startProcess(await restartMarker(), () => "silent");
	expect(restarted.hold).toBe(true);
	await restarted.reconcile();
	restarted.sample(5_000, quiet);
	expect(restarted.gate(5_000)).toEqual({
		allowed: false,
		reason: "stream_liveness_unknown",
	});
});

test("a crash between withdrawing the idle record and writing the marker keeps the hold", async () => {
	const first = await idleFirstProcess();
	// Protection begins: the record goes first, then the process dies.
	expect(first.idleRecord.withdraw()).toBe(true);
	expect(existsSync(idlePath)).toBe(false);
	expect(markerPresent()).toBe(false);

	const restarted = startProcess(await restartMarker(), () => "silent");
	expect(restarted.hold).toBe(true);
});

test("a restart before the first process recorded idle keeps the hold", async () => {
	// Killed during its own first sample: unknown, so nothing recorded.
	const first = startProcess(bootMarker, () => "silent");
	expect(existsSync(idlePath)).toBe(false);
	expect(first.gate(0)).toEqual({
		allowed: false,
		reason: "stream_liveness_unknown",
	});
	const restarted = startProcess(await restartMarker(), () => "silent");
	expect(restarted.hold).toBe(true);
});

test("an idle record that cannot be examined counts as absent", () => {
	const notADirectory = join(claimDir, "file");
	writeFileSync(notADirectory, "");
	const record = createCarryingIdleRecord(() =>
		join(notADirectory, "carrying-idle"),
	);
	expect(record.present()).toBe(false);
	const unreadable = initialOtaStreamLiveness(join(notADirectory, "streaming"));
	expect(unreadable).toBe("unknown");
	expect(
		restartNeedsCarryingHold(false, { idleRecord: true, marker: unreadable }),
	).toBe(true);
});

test("only a restart with an idle record and no marker skips the hold", () => {
	for (const idleRecord of [true, false])
		for (const marker of ["idle", "unknown"] as const) {
			expect(restartNeedsCarryingHold(true, { idleRecord, marker })).toBe(
				false,
			);
			expect(restartNeedsCarryingHold(false, { idleRecord, marker })).toBe(
				!(idleRecord && marker === "idle"),
			);
		}
});
