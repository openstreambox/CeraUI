import { afterEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
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
} from "../modules/system/software-updates.ts";
import {
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
  A launch that ends before its unit is submitted to systemd never ran apt:
  the unit-name probe (`systemctl show`) timed out or found the name taken, or
  the output files could not be prepared. That used to settle like apt's own
  failure: the wire said `failed`, the orchestrator recorded DOWNLOAD_FAILED,
  and the persisted `failed` phase waited for an operator reset, across
  reboots. Everything from `systemd-run` on can have created the unit, so it
  stays a failure.
*/

const realRunUpgrade = transaction.runDetachedAptUpgrade;

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	for (const dir of quarantineDirs.splice(0)) rmSync(dir, { recursive: true });
});

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

// ─── the launcher: what ends before the submission ────────────────────────

test.each([
	[
		"the unit-name probe times out",
		(s: ReturnType<typeof fakeSystemd>) => s.failInspect(showTimeout),
		SpawnTimeoutError,
	],
	[
		"a transaction already holds the name",
		(s: ReturnType<typeof fakeSystemd>) => s.occupy(),
		DetachedAptServiceAlreadyExistsError,
	],
	[
		"the output files cannot be prepared",
		(s: ReturnType<typeof fakeSystemd>) =>
			s.failOutput(new Error("EROFS: read-only file system")),
		Error,
	],
] as const)(
	"a capable launch whose %s is refused before systemd-run",
	async (_name, arrange, cause) => {
		// Given a launch preparation that cannot finish.
		const systemd = fakeSystemd();
		arrange(systemd);
		// When the capable two-stage unit is launched.
		const refusal = await runDetachedAptAll(
			allArgs,
			"any",
			handlers,
			systemd.deps,
		).catch((error: unknown) => error);
		// Then it is a refusal naming its cause, and nothing reached systemd.
		expect(refusal).toBeInstanceOf(DetachedAptLaunchRefusedError);
		expect((refusal as DetachedAptLaunchRefusedError).cause).toBeInstanceOf(
			cause,
		);
		expect(systemd.submitted).toEqual([]);
	},
);

test("a legacy launch whose unit-name probe times out is refused the same way", async () => {
	const systemd = fakeSystemd();
	systemd.failInspect(showTimeout);
	const refusal = await runDetachedAptUpgrade(
		directArgs,
		handlers,
		systemd.deps,
	).catch((error: unknown) => error);
	expect(refusal).toBeInstanceOf(DetachedAptLaunchRefusedError);
	expect(systemd.submitted).toEqual([]);
});

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
		systemd.failStart(failure);
		// When the unit is launched.
		const error = await runDetachedAptAll(
			allArgs,
			"any",
			handlers,
			systemd.deps,
		).catch((caught: unknown) => caught);
		// Then the error is the submission's own, as before.
		expect(systemd.submitted).toHaveLength(1);
		expect(error).not.toBeInstanceOf(DetachedAptLaunchRefusedError);
	},
);

// ─── the package wire: retryable, not a failed download ───────────────────

test("a refused launch puts a retryable failure on the wire and notifies no failed update", async () => {
	// Given an install whose unit-name probe times out during preparation.
	await using h = await updateHarness();
	const systemd = fakeSystemd();
	systemd.failInspect(showTimeout);
	spyOn(transaction, "runDetachedAptUpgrade").mockImplementation(
		(args, watched) => realRunUpgrade(args, watched, systemd.deps),
	);
	const notices = spyOn(notifications, "notificationBroadcast");
	try {
		// When the accepted start runs its continuation.
		expect(startSoftwareUpdate()).toEqual({ started: true });
		await h.check();
		// Then the wire says nothing ran and the device tries again.
		const state = getUpdateState();
		expect(state).toMatchObject({ kind: "failed", retryable: true });
		expect(state.kind === "failed" && state.reason).toContain(
			"The software update did not start",
		);
		expect(systemd.submitted).toEqual([]);
		expect(
			notices.mock.calls.filter(([id]) => id === "ceralive_update_failed"),
		).toEqual([]);
	} finally {
		notices.mockRestore();
	}
});

test("a failure after systemd-run stays a plain failure with its notification", async () => {
	// Given an install whose apt-get exits 100 in its unit.
	await using h = await updateHarness();
	const systemd = fakeSystemd({ aptExit: 100 });
	spyOn(transaction, "runDetachedAptUpgrade").mockImplementation(
		(args, watched) => realRunUpgrade(args, watched, systemd.deps),
	);
	const notices = spyOn(notifications, "notificationBroadcast");
	try {
		startSoftwareUpdate();
		await h.check();
		// Then the failure is the transaction's, as before.
		const state = getUpdateState();
		expect(state.kind).toBe("failed");
		expect(state).not.toHaveProperty("retryable");
		expect(systemd.submitted).toHaveLength(1);
		expect(
			notices.mock.calls.filter(([id]) => id === "ceralive_update_failed"),
		).toHaveLength(1);
	} finally {
		notices.mockRestore();
	}
});

// ─── the orchestrator: back to the queue, nothing persisted as failed ─────

async function orchestratedInstall(systemd: ReturnType<typeof fakeSystemd>) {
	const h = await updateHarness();
	spyOn(transaction, "runDetachedAptUpgrade").mockImplementation(
		(args, watched) => realRunUpgrade(args, watched, systemd.deps),
	);
	const persisted: string[] = [];
	const quarantine = testQuarantine();
	const deps = fakeDeps({
		quarantine,
		startPackageInstall: () => startSoftwareUpdate(),
		getPackageInstallWireState: getUpdateState,
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
		phase: "available",
	});
	return { h, persisted, quarantine };
}

test("a systemctl show timeout during preparation leaves the install queued, not failed", async () => {
	// Given an install whose unit-name probe times out after it was accepted.
	const systemd = fakeSystemd();
	systemd.failInspect(showTimeout);
	const { h, persisted } = await orchestratedInstall(systemd);
	await using _h = h;
	// When the owner installs and the orchestrator observes the outcome.
	expect(await installUpdatesNow()).toEqual({ started: true });
	expect(getOrchestratorState().phase).toBe("downloading");
	await h.check();
	await runOrchestratorTick();
	// Then the install waits in the queue again, and no failure was persisted.
	expect(getOrchestratorState().phase).toBe("awaiting-idle");
	expect(getOrchestratorState().failureReason).toBeNull();
	expect(getOrchestratorState().packageAttempt).toBeUndefined();
	expect(persisted).not.toContain("failed");
	expect(systemd.submitted).toEqual([]);
	// And once systemd answers, the retry from the queue launches the unit.
	systemd.failInspect(null);
	h.next();
	expect(await installUpdatesNow()).toEqual({ started: true });
	await h.check();
	expect(systemd.submitted).toHaveLength(1);
});

test("a name taken by a real start after admission refuses retryably, and the retry never launches over it", async () => {
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
	// Then it is recorded as before.
	expect(getOrchestratorState().phase).toBe("failed");
	expect(persisted).toContain("failed");
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
