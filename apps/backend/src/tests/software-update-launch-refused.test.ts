import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusResponseSchema } from "@ceraui/rpc";
import { SpawnTimeoutError } from "../helpers/spawn-policy.ts";
import { buildAptAllInstallArgs } from "../modules/system/apt-all-packages.ts";
import { softwareUpdateOutputPaths } from "../modules/system/software-update-output.ts";
import * as transaction from "../modules/system/software-update-process.ts";
import {
	DetachedAptLaunchRefusedError,
	DetachedAptServiceAlreadyExistsError,
	type DetachedAptUpgradeDeps,
	runDetachedAptAll,
	runDetachedAptUpgrade,
} from "../modules/system/software-update-process.ts";
import {
	DetachedAptServiceCommandError,
	SOFTWARE_UPDATE_UNIT,
} from "../modules/system/software-update-service-contract.ts";
import {
	getUpdateState,
	startSoftwareUpdate,
	triggerManualUpdateCheck,
} from "../modules/system/software-updates.ts";
import { DownloadPausedLedger } from "../modules/system/update-orchestrator/download-paused-ledger.ts";
import { DownloadPausedNotices } from "../modules/system/update-orchestrator/download-paused-notices.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import * as notifications from "../modules/ui/notifications.ts";
import {
	fakeDeps,
	quarantineDirs,
	testQuarantine,
} from "./helpers/orchestrator-runtime-harness.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

/*
  A launch that ends before its unit is submitted to systemd never ran the
  install transaction: the unit-name probe (`systemctl show`) timed out or found
  the name taken, or the output files could not be prepared. That used to
  settle like apt's own failure: the wire said `failed`, the orchestrator
  recorded DOWNLOAD_FAILED, and the persisted `failed` phase waited for an
  operator reset, across reboots. Everything from `systemd-run` on can have
  created the unit, so it stays a failure. The refusal belongs to the launch
  the orchestrator started, never to whatever the wire shows when it looks.
*/

const realRunUpgrade = transaction.runDetachedAptUpgrade;
const fixtureDirs: string[] = [];
// Notices are not this suite's subject: none reach the process-wide store.
let notices: ReturnType<
	typeof spyOn<typeof notifications, "notificationBroadcast">
>;

beforeEach(() => {
	notices = spyOn(notifications, "notificationBroadcast").mockImplementation(
		() => {},
	);
});

afterEach(() => {
	notices.mockRestore();
	resetOrchestratorRuntimeForTest();
	for (const dir of [...quarantineDirs.splice(0), ...fixtureDirs.splice(0)])
		rmSync(dir, { recursive: true, force: true });
});

const failureNotices = () =>
	notices.mock.calls.filter(([id]) => id === "ceralive_update_failed");

const showTimeout = () =>
	new SpawnTimeoutError(
		`systemctl show ${SOFTWARE_UPDATE_UNIT} --property=Id,LoadState --no-pager`,
	);

/** A systemd with one unit name, and what it was asked to do. */
function fakeSystemd(options: { readonly aptExit?: number } = {}) {
	let unit: "absent" | "running" | "finished" = "absent";
	let inspectError: (() => Error) | null = null;
	let startError: (() => Error) | null = null;
	let outputError: Error | null = null;
	const submitted: (readonly string[])[] = [];
	const cleanups: string[] = [];
	const deps: DetachedAptUpgradeDeps = {
		outputPaths: softwareUpdateOutputPaths(),
		prepareOutput: async () => {
			if (outputError) throw outputError;
		},
		start: async (argv) => {
			submitted.push(argv);
			if (startError) throw startError();
			unit = "running";
		},
		inspect: async () => {
			if (inspectError) throw inspectError();
			if (unit === "absent") return { kind: "absent" };
			if (unit === "running") return { kind: "running" };
			return {
				kind: "finished",
				exitCode: options.aptExit ?? 100,
				cleanup: "reset-failed",
			};
		},
		cleanup: async (state) => {
			cleanups.push(state.cleanup);
			unit = "absent";
		},
		readOutput: async (_path, offset) => ({
			bytes: new Uint8Array(),
			nextOffset: offset,
		}),
		// apt finishes on the observer's first poll.
		sleep: async () => {
			if (unit === "running") unit = "finished";
		},
	};
	return {
		deps,
		submitted,
		cleanups,
		failInspect: (error: (() => Error) | null) => {
			inspectError = error;
		},
		failStart: (error: (() => Error) | null) => {
			startError = error;
		},
		failOutput: (error: Error | null) => {
			outputError = error;
		},
		/** A transaction someone else started under the name. */
		occupy: () => {
			unit = "running";
		},
		release: () => {
			unit = "absent";
		},
	};
}
type FakeSystemd = ReturnType<typeof fakeSystemd>;

const handlers = { onStdout: () => {}, onStderr: () => {} };
const directArgs = [
	"-y",
	"-o",
	"Dpkg::Options::=--force-confdef",
	"-o",
	"Dpkg::Options::=--force-confold",
	"install",
	"srtla",
];
const allArgs = buildAptAllInstallArgs(
	[{ name: "ceralive-device", version: "2026.11.6" }],
	"any",
);
const launchers = [
	[
		"capable",
		(deps: DetachedAptUpgradeDeps) =>
			runDetachedAptAll(allArgs, "any", handlers, deps),
	],
	[
		"legacy",
		(deps: DetachedAptUpgradeDeps) =>
			runDetachedAptUpgrade(directArgs, handlers, deps),
	],
] as const;
const causes = [
	[
		"the unit-name probe times out",
		(s: FakeSystemd) => s.failInspect(showTimeout),
		SpawnTimeoutError,
	],
	[
		"a transaction already holds the name",
		(s: FakeSystemd) => s.occupy(),
		DetachedAptServiceAlreadyExistsError,
	],
	[
		"the output files cannot be prepared",
		(s: FakeSystemd) => s.failOutput(new Error("EROFS: read-only file system")),
		Error,
	],
] as const;

// ─── the launcher: what ends before the submission ────────────────────────

for (const [kind, launch] of launchers)
	test.each(causes)(
		`a ${kind} launch whose %s is refused before systemd-run`,
		async (_name, arrange, cause) => {
			// Given a launch preparation that cannot finish.
			const systemd = fakeSystemd();
			arrange(systemd);
			// When the unit is launched.
			const refusal = await launch(systemd.deps).catch(
				(error: unknown) => error,
			);
			// Then it is a refusal naming its cause, and nothing reached systemd.
			expect(refusal).toBeInstanceOf(DetachedAptLaunchRefusedError);
			expect((refusal as DetachedAptLaunchRefusedError).cause).toBeInstanceOf(
				cause,
			);
			expect(systemd.submitted).toEqual([]);
		},
	);

test.each([
	[
		"systemd refuses the submission",
		() =>
			new DetachedAptServiceCommandError(
				["systemd-run", `--unit=${SOFTWARE_UPDATE_UNIT}`],
				1,
				`Failed to start transient service unit: Unit ${SOFTWARE_UPDATE_UNIT} was already loaded or has a fragment file.`,
			),
	],
	["systemd-run times out", () => new SpawnTimeoutError("systemd-run")],
] as const)(
	"a launch that reached systemd-run is never a refusal: %s",
	async (_name, failure) => {
		// Given a submission that fails once it was made (the unit may exist).
		const systemd = fakeSystemd();
		const thrown = failure();
		systemd.failStart(() => thrown);
		// When the unit is launched.
		const outcome = runDetachedAptAll(allArgs, "any", handlers, systemd.deps);
		// Then it rejects with the submission's own error, as before.
		await expect(outcome).rejects.toBe(thrown);
		expect(systemd.submitted).toHaveLength(1);
	},
);

// ─── the orchestrator: back to the queue, nothing persisted as failed ─────

async function orchestratedInstall(systemd: FakeSystemd) {
	const h = await updateHarness();
	spyOn(transaction, "runDetachedAptUpgrade").mockImplementation(
		(args, watched) => realRunUpgrade(args, watched, systemd.deps),
	);
	const persisted: string[] = [];
	const quarantine = testQuarantine();
	const root = mkdtempSync(join(tmpdir(), "launch-refused-notices-"));
	fixtureDirs.push(root);
	let stops = 0;
	const deps = fakeDeps({
		quarantine,
		startPackageInstall: (ticket) => startSoftwareUpdate(undefined, ticket),
		getPackageInstallWireState: getUpdateState,
		// The launch records where it ran; a refusal must not keep that.
		readPackageAttempt: async () => ({ bootId: "boot-1", slot: "a" }),
		isIdle: async () => false,
		stopPackageInstallUnit: async () => {
			stops++;
		},
		downloadNotices: new DownloadPausedNotices({
			ledger: new DownloadPausedLedger(join(root, "download-notices.json")),
			publish: () => {},
			clear: () => {},
			report: () => undefined,
		}),
	});
	const persist = deps.persist;
	setOrchestratorRuntimeDepsForTest({
		...deps,
		persist: (state) => {
			persisted.push(state.phase);
			persist(state);
		},
	});
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "awaiting-idle",
	});
	// Queued outside the idle window: the tick loads the boot provenance and
	// launches nothing; the owner's Install now does.
	await runOrchestratorTick();
	return {
		h,
		persisted,
		quarantine,
		stops: () => stops,
		wireFrames: () =>
			h.frames
				.map((frame) => statusResponseSchema.parse(frame).update_state)
				.filter((state) => state !== undefined),
	};
}

test("a systemctl show timeout during preparation leaves the install queued, not failed", async () => {
	// Given an install whose unit-name probe times out after it was accepted.
	const systemd = fakeSystemd();
	systemd.failInspect(showTimeout);
	const { h, persisted, quarantine, wireFrames } =
		await orchestratedInstall(systemd);
	await using _h = h;
	// When the owner installs and the orchestrator observes the outcome.
	expect(await installUpdatesNow()).toEqual({ started: true });
	expect(getOrchestratorState().phase).toBe("downloading");
	expect(getOrchestratorState().packageAttempt).toEqual({
		bootId: "boot-1",
		slot: "a",
	});
	const plan = await quarantine.readPending();
	await h.check();
	// Then the device reported it as retryable, with no failure notice.
	expect(wireFrames()).toContainEqual(
		expect.objectContaining({ kind: "failed", retryable: true }),
	);
	expect(failureNotices()).toEqual([]);
	await runOrchestratorTick();
	// And the install waits in the queue again, with nothing persisted as
	// failed, no provenance kept, and the offer back on the wire.
	expect(getOrchestratorState().phase).toBe("awaiting-idle");
	expect(getOrchestratorState().failureReason).toBeNull();
	expect(getOrchestratorState().packageAttempt).toBeUndefined();
	expect(persisted).not.toContain("failed");
	expect(getUpdateState().kind).toBe("available");
	expect(systemd.submitted).toEqual([]);
	// And once systemd answers, the retry launches the unit with the plan it
	// recorded from the offer.
	systemd.failInspect(null);
	h.next();
	expect(await installUpdatesNow()).toEqual({ started: true });
	expect(await quarantine.readPending()).toEqual(plan);
	expect(plan.length).toBeGreaterThan(0);
	await h.check();
	expect(systemd.submitted).toHaveLength(1);
});

test("a name taken by another start after admission refuses retryably, and the retry never launches over it", async () => {
	// Given a transaction that takes the unit name after the install was admitted.
	const systemd = fakeSystemd();
	const { h, persisted } = await orchestratedInstall(systemd);
	await using _h = h;
	expect(await installUpdatesNow()).toEqual({ started: true });
	systemd.occupy();
	// When the launch meets it.
	await h.check();
	await runOrchestratorTick();
	// Then nothing was submitted or cleaned up under its name, nothing failed,
	// and the install is queued again.
	expect(getOrchestratorState().phase).toBe("awaiting-idle");
	expect(persisted).not.toContain("failed");
	expect(systemd.submitted).toEqual([]);
	expect(systemd.cleanups).toEqual([]);
	// And a retry while it still runs is refused the same way.
	h.next();
	expect(await installUpdatesNow()).toEqual({ started: true });
	await h.check();
	await runOrchestratorTick();
	expect(getOrchestratorState().phase).toBe("awaiting-idle");
	expect(systemd.submitted).toEqual([]);
	// Once that unit is gone, the retry launches.
	systemd.release();
	h.next();
	expect(await installUpdatesNow()).toEqual({ started: true });
	await h.check();
	expect(systemd.submitted).toHaveLength(1);
});

test("a stream start after a settled refusal stops nothing under the name", async () => {
	// Given a refused launch whose name another transaction holds, not yet polled.
	const systemd = fakeSystemd();
	const { h, stops } = await orchestratedInstall(systemd);
	await using _h = h;
	expect(await installUpdatesNow()).toEqual({ started: true });
	systemd.occupy();
	await h.check();
	expect(getOrchestratorState().phase).toBe("downloading");
	// When a stream starts.
	const admission = await admitAndPrepareStreamStart();
	// Then the refusal settles first: the stream goes ahead, and the unit that
	// holds the name is not this install's to stop.
	expect(admission).toEqual({ allowed: true });
	expect(stops()).toBe(0);
	expect(getOrchestratorState().phase).toBe("awaiting-idle");
});

test("a check that clears the wire first does not strand the refused launch", async () => {
	// Given a refused launch, not yet polled.
	const systemd = fakeSystemd();
	systemd.failInspect(showTimeout);
	const { h, persisted } = await orchestratedInstall(systemd);
	await using _h = h;
	expect(await installUpdatesNow()).toEqual({ started: true });
	await h.check();
	// When the Packages card's check clears the failure off the wire.
	expect(triggerManualUpdateCheck()).toBe(true);
	expect(getUpdateState().kind).not.toBe("failed");
	await runOrchestratorTick();
	// Then the refusal is still this launch's, and it is queued again.
	expect(getOrchestratorState().phase).toBe("awaiting-idle");
	expect(persisted).not.toContain("failed");
});

test("a refusal of a Packages card start is not the orchestrator's launch", async () => {
	// Given an install the orchestrator launched whose apt fails in its unit.
	const systemd = fakeSystemd({ aptExit: 100 });
	const { h } = await orchestratedInstall(systemd);
	await using _h = h;
	expect(await installUpdatesNow()).toEqual({ started: true });
	await h.check();
	expect(getOrchestratorState().phase).toBe("downloading");
	// When, before the orchestrator looks, the Packages card starts one of its
	// own that is refused before systemd-run.
	systemd.failInspect(showTimeout);
	h.next();
	expect(startSoftwareUpdate()).toEqual({ started: true });
	await h.check();
	// Then that start keeps today's failure, with its notice and no retry flag.
	expect(getUpdateState()).toMatchObject({ kind: "failed" });
	expect(getUpdateState()).not.toHaveProperty("retryable");
	expect(failureNotices()).toHaveLength(2);
	await runOrchestratorTick();
	// And the orchestrator's launch, whose apt ran, is recorded as failed.
	expect(getOrchestratorState().phase).toBe("failed");
});

test("a submission systemd refused is still a failed download", async () => {
	// Given a launch whose systemd-run call fails (the unit may exist).
	const systemd = fakeSystemd();
	systemd.failStart(
		() =>
			new DetachedAptServiceCommandError(
				["systemd-run"],
				1,
				"Failed to start transient service unit",
			),
	);
	const { h, persisted } = await orchestratedInstall(systemd);
	await using _h = h;
	expect(await installUpdatesNow()).toEqual({ started: true });
	await h.check();
	await runOrchestratorTick();
	// Then it is recorded as before, with its notice.
	expect(getOrchestratorState().phase).toBe("failed");
	expect(persisted).toContain("failed");
	expect(getUpdateState()).not.toHaveProperty("retryable");
	expect(failureNotices()).toHaveLength(1);
	expect(systemd.submitted).toHaveLength(1);
});

test("a retryable failure seen once the install committed is not a refusal", async () => {
	// Given an install the orchestrator already tracks as committing.
	const quarantine = testQuarantine();
	const recorded: string[] = [];
	quarantine.recordPackageFailure = async (_packages, _attempt, reason) => {
		recorded.push(reason);
	};
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			quarantine,
			takePackageLaunchRefusal: () => true,
			getPackageInstallWireState: () => ({
				kind: "failed",
				reason: "The software update did not start: probe",
				retryable: true,
			}),
		}),
	);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "committing",
	});
	// When the wire reports a failure.
	await runOrchestratorTick();
	// Then the committed transaction's failure handling is unchanged.
	expect(getOrchestratorState().phase).toBe("quarantined");
	expect(recorded).toHaveLength(1);
});
