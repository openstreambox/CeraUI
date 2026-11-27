import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { parseOsStageGuardObservation } from "../modules/system/update-orchestrator/os-stage-guard-observation.ts";
import type { OsStageJobRecord } from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { guardTest, guardUnit } from "./helpers/os-guard-harness.ts";

/*
  On an image whose shutdown drain names the guard in After=, systemd keeps the
  stopped transient guard loaded. A successful install then reached the receipt
  commit, stopped the guard, saw it still loaded (inactive, same invocation) and
  settled unsafe with rauc_recovery_unproven, leaving the job directory behind
  (25 Nov, ROCK 5B+, systemd 257.13). These replay that sequence.
*/

const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const released = "a".repeat(32);
const baseline = {
	instance: "659:10",
	active: true,
	operation: "idle",
	processes: ["659:10"],
	resources: [],
	bootId: "boot-B",
	bootPrimary: "rootfs.1",
	bootedSlot: "rootfs.1",
	bootedDevice: "179:5",
	bootedHealthy: true,
	targetSlot: "rootfs.0",
	targetDevice: "179:4",
	targetInactive: true,
	activationArmed: false,
};
const record: OsStageJobRecord = {
	schema: 1,
	attemptId: token,
	candidateKey: "candidate-sha",
	bundleUrl:
		"https://images.ceralive.tv/releases/rock-5b-plus/2026.10.51/bundle.raucb",
	baseline,
	processes: baseline.processes,
	resources: [],
	launched: false,
	cliSettled: true,
	requireNewInstance: false,
};

guardTest(
	"a successful release finishes when systemd keeps the stopped guard loaded",
	record,
	async (h) => {
		// Given an acquired guard whose unit stays loaded after its stop.
		await h.owner.acquire();
		h.owner.beginAttempt(baseline, "eth0/6");
		h.owner.remember(baseline, true, true, false);
		let committed = false;
		// When the settled install commits its receipt and releases the guard.
		await h.owner.release(baseline, true, () => {
			committed = true;
		});
		// Then the release completes: lock free, job directory retired.
		expect(committed).toBe(true);
		expect(await h.contender()).toBe(0);
		expect(existsSync(h.directory)).toBe(false);
		const stops = h.commands.filter((argv) => argv[0] === "systemctl");
		expect(stops.map((argv) => argv[1])).toEqual([
			"show",
			"stop",
			"reset-failed",
		]);
	},
	{ stopLeavesUnitLoaded: { invocationId: released } },
);

guardTest(
	"a loaded guard from another invocation after the stop is still refused",
	record,
	async (h) => {
		await h.owner.acquire();
		h.owner.beginAttempt(baseline, "eth0/6");
		h.owner.remember(baseline, true, true, false);
		const release = h.owner.release(baseline, true);
		await expect(release).rejects.toBeInstanceOf(OsStageError);
		const error = await release.catch((cause: unknown) => cause);
		expect(error).toMatchObject({ reason: "rauc_recovery_unproven" });
		expect((error as OsStageError).diagnostics).toMatchObject({
			refusal: "guard-not-retired",
		});
		// The job record stays for recovery to settle.
		expect(existsSync(h.directory)).toBe(true);
	},
	{ stopLeavesUnitLoaded: { invocationId: "b".repeat(32) } },
);

guardTest(
	"a loaded guard with a queued job after the stop is still refused",
	record,
	async (h) => {
		await h.owner.acquire();
		h.owner.beginAttempt(baseline, "eth0/6");
		h.owner.remember(baseline, true, true, false);
		const error = await h.owner
			.release(baseline, true)
			.catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(OsStageError);
		expect((error as OsStageError).diagnostics).toMatchObject({
			refusal: "guard-not-retired",
		});
		expect(existsSync(h.directory)).toBe(true);
	},
	{ stopLeavesUnitLoaded: { invocationId: released, jobQueued: true } },
);

guardTest(
	"the guard orders itself before the image's shutdown drain",
	record,
	async (h) => {
		await h.owner.acquire();
		const submit = h.commands.find((argv) => argv[0] === "systemd-run");
		// Ordering from the guard's side never pins its stopped unit.
		expect(submit).toContain("--property=Before=ceralive-write-drain.service");
		expect(submit).toContain("--property=RemainAfterExit=yes");
		h.owner.remember(baseline, true, true, false);
		await h.owner.release(baseline, true);
	},
);

function observation(active: "active" | "inactive"): string {
	return guardUnit(token, false, 0)
		.replace(/ActiveState=\w+/, `ActiveState=${active}`)
		.replace("code=(null) ; status=0 }", "code=exited ; status=0/SUCCESS }")
		.concat(
			`\nLoadState=loaded\nControlPID=0\nRestart=no\nExecMainCode=1\nInvocationID=${released}\nControlGroup=`,
		);
}

test("a stopped but still loaded guard reads as stopped, an exited one does not", () => {
	expect(parseOsStageGuardObservation(observation("inactive"), token)).toEqual({
		kind: "terminal",
		cleanExit: true,
		invocationId: released,
		exitStatus: 0,
		stopped: true,
	});
	expect(parseOsStageGuardObservation(observation("active"), token)).toEqual({
		kind: "terminal",
		cleanExit: true,
		invocationId: released,
		exitStatus: 0,
	});
});
