/**
 * Field regression (two bench boards, image 6 CeraUI): after a backend restart
 * with the engine idle and no client traffic (a package install, a service
 * restart), `system.sshStart` and every power action answered
 * `stream_liveness_unknown` for two minutes. The restarted process took the
 * carrying startup hold on every restart within a boot, even when its
 * predecessor had nothing to protect.
 *
 * A restart now skips the hold only on positive evidence: the process it
 * replaces exited cleanly while the whole box was idle (its generation in the
 * idle-exit record), and no OTA marker is left. These tests replay restarts
 * against the real files in a scratch `/run/ceralive`: a fresh marker module
 * instance, restart evidence and tracker are the restarted process, built in
 * production order (the session at import, then `initCarrying()`, then
 * reconciliation opening the latch) and judged by the production gate.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
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
	createCarryingRestartEvidence,
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

let dir = "";
const claimPath = () => join(dir, "carrying-boot-claim");
const generationPath = () => join(dir, "carrying-generation");
const idleExitPath = () => join(dir, "carrying-idle-exit");
const markerPresent = () => existsSync(otaStreamingMarkerPath());

function resetOwners() {
	chmodSync(dirname(otaStreamingMarkerPath()), 0o700);
	setCarryingOtaProtection(false);
	clearOtaStreamingMarker();
	rmSync(otaStreamingMarkerPath(), { force: true });
}
beforeEach(() => {
	resetOwners();
	dir = mkdtempSync(join(tmpdir(), "carrying-restart-hold-"));
});
afterEach(() => {
	resetOwners();
	rmSync(dir, { recursive: true, force: true });
});

let restarts = 0;
const restartMarker = (): Promise<MarkerModule> =>
	import(`../modules/streaming/ota-streaming-marker.ts?hold=${++restarts}`);

/**
 * One backend process: its own marker owner, restart evidence, carrying tracker
 * and session. The session is built at import; `initCarrying()` then reads the
 * claim, bumps the generation, reads the idle exit and the marker before it
 * publishes anything itself; the latch opens only once reconciliation returns.
 * `exit()` is the termination handler's first step; a crash never calls it.
 */
function startProcess(
	marker: MarkerModule,
	engine: () => Engine,
	options: { readOnlyRun?: boolean } = {},
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
	const evidence = createCarryingRestartEvidence(
		{ generation: generationPath, idleExit: idleExitPath },
		options.readOnlyRun
			? {
					...fs,
					writeFileSync: () => {
						throw Object.assign(new Error("read-only"), { code: "EROFS" });
					},
				}
			: fs,
	);
	const firstStartThisBoot = claimFirstStartThisBoot(claimPath());
	const hold = restartNeedsCarryingHold(firstStartThisBoot, {
		idleExit: evidence.start(),
		marker: initialOtaStreamLiveness(),
	});
	const tracker = new CarryingTracker();
	// What `publishCarrying()` does with the tracker's state.
	const publish = (now: number) =>
		marker.setCarryingOtaProtection(tracker.read(now) !== "idle");
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
	/** `getStreamLiveness()`: what admission and the exit record both read. */
	const liveness = (now: number) => {
		const leaf = session.streamLiveness();
		return deriveStreamLiveness({
			carrying: tracker.read(now),
			reconciled,
			live: leaf === "streaming",
			lifecycle: session.snapshot().state,
			sentinel: leaf === "idle" ? "absent" : "unknown",
		});
	};
	/** The SSH switch and power actions: `getDisruptiveActionDecision()`. */
	const gate = (now: number) =>
		decideDisruptiveAction({ streamLiveness: liveness(now), updateBusy: [] });
	/** SIGTERM: the handler records first, before teardown changes anything. */
	const exit = (now: number) => evidence.recordExit(liveness(now));
	return { hold, tracker, session, reconcile, sample, gate, exit };
}

const quiet = { eth1: 10 };
const refusedUnknown = {
	allowed: false,
	reason: "stream_liveness_unknown",
} as const;

/** An idle process that ran past its first samples. */
async function idleProcess(marker: MarkerModule = bootMarker) {
	const process = startProcess(marker, () => "silent");
	expect(await process.reconcile()).toBe("idle");
	process.sample(5_000, quiet);
	expect(process.gate(5_000)).toEqual({ allowed: true });
	expect(markerPresent()).toBe(false);
	return process;
}

test("a restart after an idle clean exit admits SSH on its first quiet sample", async () => {
	const first = await idleProcess();
	expect(first.hold).toBe(false);
	expect(first.exit(5_000)).toBe(true);

	// The package's postinst restarts the backend: same boot.
	const restarted = startProcess(await restartMarker(), () => "silent");
	expect(restarted.hold).toBe(false);
	expect(await restarted.reconcile()).toBe("idle");
	restarted.sample(5_000, quiet);
	expect(restarted.gate(5_000)).toEqual({ allowed: true });
	expect(markerPresent()).toBe(false);
	expect(inhibitorHeld).toBe(false);
});

test("a restart after an idle clean exit whose engine reports idle is admitted too", async () => {
	(await idleProcess()).exit(5_000);
	const restarted = startProcess(await restartMarker(), () => "idle");
	expect(restarted.hold).toBe(false);
	expect(await restarted.reconcile()).toBe("idle");
	restarted.sample(5_000, quiet);
	expect(restarted.gate(5_000)).toEqual({ allowed: true });
});

test("a restarted process says unknown until its first sample and its reconciliation", async () => {
	(await idleProcess()).exit(5_000);
	const restarted = startProcess(await restartMarker(), () => "silent");
	expect(restarted.gate(0)).toEqual(refusedUnknown);
	restarted.sample(5_000, quiet);
	expect(restarted.gate(5_000)).toEqual(refusedUnknown);
	await restarted.reconcile();
	expect(restarted.gate(5_000)).toEqual({ allowed: true });
});

test("every later restart needs its own predecessor's idle exit", async () => {
	(await idleProcess()).exit(5_000);
	(await idleProcess(await restartMarker())).exit(5_000);
	const third = startProcess(await restartMarker(), () => "silent");
	expect(third.hold).toBe(false);
});

test("a crash keeps the hold even after an earlier idle exit", async () => {
	(await idleProcess()).exit(5_000);
	// The second process carries a phone; it cannot write its marker (a
	// read-only or full /run) and is killed. Its predecessor's record remains.
	const second = startProcess(await restartMarker(), () => "silent");
	expect(second.hold).toBe(false);
	await second.reconcile();
	expect(existsSync(idleExitPath())).toBe(true);

	const restarted = startProcess(await restartMarker(), () => "silent");
	expect(restarted.hold).toBe(true);
	await restarted.reconcile();
	restarted.sample(5_000, quiet);
	expect(restarted.gate(5_000)).toEqual(refusedUnknown);
});

test("an exit while a phone is carried keeps the hold", async () => {
	const first = startProcess(bootMarker, () => "silent");
	await first.reconcile();
	// 2 Mbit/s of client upload long enough to count as carrying.
	let bytes = 0;
	for (let at = 1_000; at <= 30_000; at += 1_000) {
		bytes += 250_000;
		first.sample(at, { eth1: bytes });
	}
	expect(first.gate(30_000)).toEqual({ allowed: false, reason: "streaming" });
	expect(first.exit(30_000)).toBe(false);

	const restarted = startProcess(await restartMarker(), () => "silent");
	expect(restarted.hold).toBe(true);
	expect(await restarted.reconcile()).toBe("idle");
	// Quiet counters do not end the hold: the earlier process's evidence is lost.
	restarted.sample(5_000, quiet);
	restarted.sample(119_000, quiet);
	expect(restarted.gate(119_000)).toEqual(refusedUnknown);
	restarted.sample(121_000, quiet);
	restarted.sample(122_000, quiet);
	expect(restarted.gate(122_000)).toEqual({ allowed: true });
	expect(markerPresent()).toBe(false);
});

test("an exit beside a running engine session keeps the hold, whatever the marker says", async () => {
	// A stream whose marker writes failed: no marker, but the session knows.
	const first = startProcess(bootMarker, () => "streaming");
	await first.reconcile();
	first.sample(5_000, quiet);
	expect(first.gate(5_000)).toEqual(refusedUnknown);
	expect(first.exit(5_000)).toBe(false);
	rmSync(otaStreamingMarkerPath(), { force: true });

	const restarted = startProcess(await restartMarker(), () => "silent");
	expect(restarted.hold).toBe(true);
});

test("an exit during the process's own first sample keeps the hold", async () => {
	const first = startProcess(bootMarker, () => "silent");
	await first.reconcile();
	expect(first.exit(0)).toBe(false);
	expect(startProcess(await restartMarker(), () => "silent").hold).toBe(true);
});

test("a restart beside a stream's marker with an unreachable engine stays unknown after the hold", async () => {
	(await idleProcess()).exit(5_000);
	// Something left the empty stream marker after that exit.
	writeFileSync(otaStreamingMarkerPath(), "");

	const restarted = startProcess(await restartMarker(), () => "unknown");
	expect(restarted.hold).toBe(true);
	expect(await restarted.reconcile()).toBe("reconciling");
	restarted.sample(121_000, quiet);
	restarted.sample(122_000, quiet);
	expect(restarted.tracker.read(122_000)).toBe("idle");
	expect(restarted.gate(122_000)).toEqual(refusedUnknown);
	expect(markerPresent()).toBe(true);
	expect(inhibitorHeld).toBe(true);
});

test("a generation that cannot be advanced keeps the hold", async () => {
	(await idleProcess()).exit(5_000);
	// A read-only runtime directory: the restart cannot tell exits apart.
	const restarted = startProcess(await restartMarker(), () => "silent", {
		readOnlyRun: true,
	});
	expect(restarted.hold).toBe(true);
	expect(restarted.exit(0)).toBe(false);
});

test("a damaged generation or idle-exit record keeps the hold", async () => {
	(await idleProcess()).exit(5_000);
	writeFileSync(idleExitPath(), `${readFileSync(generationPath(), "utf8")}x`);
	expect(startProcess(await restartMarker(), () => "silent").hold).toBe(true);
});

test("a lost generation never lets an old idle exit name a later process", async () => {
	(await idleProcess()).exit(5_000);
	rmSync(generationPath(), { force: true });
	// The next process starts past the record, then crashes.
	const lost = startProcess(await restartMarker(), () => "silent");
	expect(lost.hold).toBe(true);
	expect(startProcess(await restartMarker(), () => "silent").hold).toBe(true);
});

test("a marker that cannot be examined keeps the hold", () => {
	const notADirectory = join(dir, "file");
	writeFileSync(notADirectory, "");
	const unreadable = initialOtaStreamLiveness(join(notADirectory, "streaming"));
	expect(unreadable).toBe("unknown");
	expect(
		restartNeedsCarryingHold(false, { idleExit: true, marker: unreadable }),
	).toBe(true);
});

test("only a restart after an idle exit and without a marker skips the hold", () => {
	for (const idleExit of [true, false])
		for (const marker of ["idle", "unknown"] as const) {
			expect(restartNeedsCarryingHold(true, { idleExit, marker })).toBe(false);
			expect(restartNeedsCarryingHold(false, { idleExit, marker })).toBe(
				!(idleExit && marker === "idle"),
			);
		}
});
