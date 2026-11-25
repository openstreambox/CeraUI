import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCarryingOtaProtection } from "../modules/streaming/ota-streaming-marker.ts";
import {
	CarryingTracker,
	carryingTracker,
} from "../modules/system/carrying.ts";
import {
	carryingBootClaimPath,
	claimFirstStartThisBoot,
	initCarrying,
} from "../modules/system/carrying-runtime.ts";

const dirs: string[] = [];
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), "carrying-boot-claim-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

test("the claim path is boot-scoped by default and overridable for tests", () => {
	const saved = process.env.CERALIVE_CARRYING_BOOT_CLAIM;
	try {
		delete process.env.CERALIVE_CARRYING_BOOT_CLAIM;
		expect(carryingBootClaimPath()).toBe("/run/ceralive/carrying-boot-claim");
	} finally {
		process.env.CERALIVE_CARRYING_BOOT_CLAIM = saved;
	}
});

test("only the first start in a boot creates the claim; later starts are restarts", () => {
	const path = join(scratch(), "claim");
	expect(claimFirstStartThisBoot(path)).toBe(true);
	expect(claimFirstStartThisBoot(path)).toBe(false);
	expect(claimFirstStartThisBoot(path)).toBe(false);
});

test("a claim that cannot be written counts as a restart and keeps the hold", () => {
	const missingParent = join(scratch(), "absent", "claim");
	expect(claimFirstStartThisBoot(missingParent)).toBe(false);
});

test("the first start of a boot takes no startup hold; a restart takes the two-minute hold unless the predecessor exited idle", () => {
	// Observed, not run: the shared tracker must not keep a hold for later files.
	const start = spyOn(carryingTracker, "start").mockImplementation(() => {});
	try {
		initCarrying(true, { idleExit: false, marker: "unknown" });
		expect(start).not.toHaveBeenCalled();
		// The predecessor exited idle and left no marker: nothing was lost.
		initCarrying(false, { idleExit: true, marker: "idle" });
		expect(start).not.toHaveBeenCalled();
		// No idle exit (a crash, a stream, a failed write, an older backend) keeps the hold.
		initCarrying(false, { idleExit: false, marker: "idle" });
		expect(start).toHaveBeenCalledTimes(1);
		initCarrying(false, { idleExit: true, marker: "unknown" });
		expect(start).toHaveBeenCalledTimes(2);
	} finally {
		start.mockRestore();
		setCarryingOtaProtection(false);
	}
});

test("without the hold, one quiet counter sample confirms idle", () => {
	const tracker = new CarryingTracker();
	tracker.upload(0, null);
	expect(tracker.read(0)).toBe("unknown");
	tracker.upload(1_000, { wlan0: 10 });
	expect(tracker.read(1_000)).toBe("idle");
	expect(tracker.startupChecking(1_000)).toBe(false);
});

test("without the hold, client traffic after boot is still caught by the sampler", () => {
	const tracker = new CarryingTracker();
	tracker.upload(0, null);
	tracker.upload(1_000, { wlan0: 0 });
	// 2 Mbit/s of client upload: unknown while it dwells, then carrying.
	let bytes = 0;
	for (let at = 2_000; at <= 25_000; at += 1_000) {
		bytes += 250_000;
		tracker.upload(at, { wlan0: bytes });
		expect(tracker.read(at)).not.toBe("idle");
	}
	expect(tracker.read(25_000)).toBe("streaming");
});

test("a restarted tracker stays unknown for the hold even when quiet", () => {
	const tracker = new CarryingTracker();
	tracker.start(0);
	tracker.upload(0, null);
	tracker.upload(1_000, { wlan0: 10 });
	expect(tracker.read(1_000)).toBe("unknown");
	expect(tracker.startupChecking(1_000)).toBe(true);
	tracker.upload(120_000, { wlan0: 10 });
	tracker.upload(121_000, { wlan0: 10 });
	expect(tracker.read(121_000)).toBe("idle");
});
