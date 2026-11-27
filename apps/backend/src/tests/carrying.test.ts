import { expect, test } from "bun:test";
import { CarryingTracker } from "../modules/system/carrying.ts";
import { decideDisruptiveAction } from "../modules/system/disruptive-action-gate.ts";
import { deriveStreamLiveness } from "../modules/system/stream-liveness-source.ts";

const bootIdle = {
	reconciled: true,
	live: false,
	lifecycle: "idle",
	sentinel: "absent",
} as const;

test("engine-less boot idle cannot admit an update while a phone uploads", () => {
	const tracker = new CarryingTracker();
	for (let now = 0; now <= 25_000; now += 5_000)
		tracker.upload(now, { phone: now * 250 });
	const liveness = deriveStreamLiveness({
		...bootIdle,
		carrying: tracker.read(25_000),
	});
	expect(liveness).toBe("streaming");
	expect(
		decideDisruptiveAction({ streamLiveness: liveness, updateBusy: [] })
			.allowed,
	).toBe(false);
});

test("short bursts and exactly 1 Mbit/s do not count", () => {
	const tracker = new CarryingTracker();
	tracker.upload(0, { phone: 0 });
	tracker.upload(5_000, { phone: 2_000_000 });
	tracker.upload(10_000, { phone: 2_000_000 });
	expect(tracker.read(10_000)).toBe("unknown");
	for (let now = 15_000; now <= 60_000; now += 5_000)
		tracker.upload(now, { phone: 2_000_000 + (now - 10_000) * 125 });
	expect(tracker.read(60_000)).toBe("idle");
});

test("two minute hold survives reconnects; read errors never establish idle", () => {
	const tracker = new CarryingTracker();
	tracker.session("sender", true, 0);
	tracker.session("sender", false, 1000);
	expect(tracker.read(120_999)).toBe("streaming");
	expect(tracker.read(121_000)).toBe("idle");
	tracker.session("relay", null, 122_000);
	expect(tracker.read(122_000)).toBe("unknown");
	tracker.session("relay", false, 123_000);
	expect(tracker.read(123_000)).toBe("idle");
	const forward = new CarryingTracker();
	forward.session("srt-forward", true, 0);
	forward.session("srt-forward", null, 1000);
	expect(forward.read(120_999)).toBe("streaming");
	expect(forward.read(121_000)).toBe("unknown");
	forward.session("srt-forward", false, 122_000);
	expect(forward.read(122_000)).toBe("idle");
});

test("counter resets, disappearing clients and sample gaps cannot fake sustained upload", () => {
	const tracker = new CarryingTracker();
	tracker.upload(0, { phone: 0 });
	tracker.upload(5_000, { phone: 2_000_000 });
	tracker.upload(10_000, { phone: 0 });
	tracker.upload(15_000, {});
	tracker.upload(40_000, { phone: 10_000_000 });
	expect(tracker.read(40_000)).toBe("idle");
	tracker.upload(45_000, null);
	expect(tracker.read(45_000)).toBe("unknown");
});

test("all idle actions wait with calm reasons for carrying and unknown evidence", async () => {
	const { idleActionPolicy } = await import(
		"../modules/system/idle-action-policy.ts"
	);
	for (const action of [
		"update",
		"home-ap-pause",
		"home-cellular-exclusion",
		"heat-idle-rest",
	] as const) {
		for (const live of ["streaming", "unknown"] as const) {
			const decision = idleActionPolicy(action, live);
			expect(decision.allowed).toBe(false);
			if (!decision.allowed)
				expect(decision.message).not.toMatch(
					/not live|offline|stopped|back on air/i,
				);
		}
		expect(idleActionPolicy(action, "idle").allowed).toBe(true);
	}
});

test("shared OTA marker survives either owner's cleanup", async () => {
	const { existsSync } = await import("node:fs");
	const marker = await import("../modules/streaming/ota-streaming-marker.ts");
	marker.clearOtaStreamingMarker();
	marker.setCarryingOtaProtection(true);
	expect(existsSync(marker.otaStreamingMarkerPath())).toBe(true);
	marker.clearOtaStreamingMarker();
	expect(existsSync(marker.otaStreamingMarkerPath())).toBe(true);
	marker.setOtaStreamingMarker();
	marker.setCarryingOtaProtection(false);
	expect(existsSync(marker.otaStreamingMarkerPath())).toBe(true);
	marker.clearOtaStreamingMarker();
	expect(existsSync(marker.otaStreamingMarkerPath())).toBe(false);
});

test("reader uses only client-facing RX and refuses malformed or missing counters", async () => {
	const { readClientUploadCounters } = await import(
		"../modules/system/carrying-runtime.ts"
	);
	const paths: string[] = [];
	expect(
		await readClientUploadCounters(["ap0"], async (path) => {
			paths.push(path);
			return "123\n";
		}),
	).toEqual({ ap0: 123 });
	expect(paths).toEqual(["/sys/class/net/ap0/statistics/rx_bytes"]);
	await expect(
		readClientUploadCounters(["ap0"], async () => ""),
	).rejects.toThrow();
	await expect(readClientUploadCounters(["../bad"])).rejects.toThrow();
});

test("no-engine reconciliation reaches idle, but the production adapter protects a carried phone", async () => {
	const { createStreamSessionOrchestrator } = await import(
		"../modules/streaming/stream-session-orchestrator.ts"
	);
	const { bindStreamLiveness } = await import(
		"../modules/streaming/stream-liveness.ts"
	);
	const { updateStreamLifecycleState } = await import(
		"../modules/streaming/stream-lifecycle-status.ts"
	);
	const { getStreamLiveness } = await import(
		"../modules/system/stream-liveness-source.ts"
	);
	const { carryingTracker } = await import("../modules/system/carrying.ts");
	const owner = createStreamSessionOrchestrator({
		createAttemptId: () => "no-engine",
		stopRuntime: async () => {},
		queryRuntime: async () => "unknown",
		setStreamingStatus: () => {
			/* no encoder */
		},
	});
	await owner.reconcile();
	expect(owner.snapshot().state).toBe("idle");
	bindStreamLiveness(owner.streamLiveness);
	updateStreamLifecycleState("idle");
	carryingTracker.session("test-phone", true, performance.now());
	expect(getStreamLiveness()).toBe("streaming");
	const { getIdleStatus, setIdleStateFilePathForTest } = await import(
		"../modules/system/idle-activity.ts"
	);
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const directory = await mkdtemp(join(tmpdir(), "carrying-idle-"));
	try {
		setIdleStateFilePathForTest(join(directory, "idle.json"));
		const status = await getIdleStatus({
			now: Date.now() + 40 * 60_000,
			schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
		});
		expect(status.idle).toBe(false);
		expect(status.blockers).toContain("carrying");
	} finally {
		setIdleStateFilePathForTest(null);
		await rm(directory, { recursive: true, force: true });
	}

	// This file owns its isolated carrying singleton; leave no protection behind.
	carryingTracker.session("test-phone", false, performance.now() - 120_000);
});

test("an upload being qualified withholds idle permission before the carrying dwell completes", () => {
	const tracker = new CarryingTracker();
	tracker.upload(0, { phone: 0 });
	tracker.upload(5_000, { phone: 1_250_000 });
	expect(tracker.read(5_000)).toBe("unknown");
	tracker.upload(10_000, { phone: 1_250_000 });
	expect(tracker.read(10_000)).toBe("unknown");
	for (let now = 15_000; now <= 25_000; now += 5000)
		tracker.upload(now, { phone: 1_250_000 });
	expect(tracker.read(25_000)).toBe("idle");
});
