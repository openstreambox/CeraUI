/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * An install on an image with its own apt source, held at its first wait: the
 * real package code, its probes, the transport selection, the pin, the routing
 * lease, the launcher and the orchestrator, over fakes at the bottom only.
 *
 * The fakes stand where the code leaves the process:
 * - every command, at the two spawn primitives (`setSpawnOverrideForTest`);
 * - every file written for an install, at the owned-file backend
 *   (`setOwnedFileBackendForTest`), and every owned write to state, at its
 *   observer (`setOwnedWriteObserverForTest`);
 * - the few reads that are neither: the capability files, the routing
 *   journal's store, the unit's fragment, two `stat` calls, the delayed
 *   start's timer and the unit's output.
 *
 * Each parks on a sequencer (await-sequencer.ts), so a test stands at every
 * wait of the install in turn. Everything is kept in one ledger: once an
 * install has ended, any command, file step or owned write of its own that is
 * not on the teardown list of effect-owner.ts fails the test, and so does
 * anything it logs.
 *
 * Only in-process fakes: no command of this file ever reaches the system.
 */

import { afterEach, beforeEach, expect, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import {
	type UpdateCapabilities,
	updateCapabilityFileSchema,
} from "@ceraui/rpc/schemas";
import {
	isOwnerTeardownCommand,
	isOwnerTeardownWrite,
	type OwnedFileBackend,
	type OwnedWrite,
	type SpawnOverrideResult,
	setOwnedFileBackendForTest,
	setOwnedWriteObserverForTest,
	setSpawnOverrideForTest,
} from "../../helpers/effect-owner.ts";
import { logger } from "../../helpers/logger.ts";
import * as events from "../../modules/events/emit.ts";
import * as gateways from "../../modules/network/gateways.ts";
import { setup } from "../../modules/setup.ts";
import { resetAptReachabilityCacheForTest } from "../../modules/system/apt-reachability.ts";
import type { AptRoutingEntry } from "../../modules/system/apt-routing-journal.ts";
import {
	AptRoutingRefusal,
	createAptRoutingOwnership,
} from "../../modules/system/apt-routing-ownership.ts";
import { defaultAptSpaceDeps } from "../../modules/system/apt-space-admission.ts";
import { setAptTransportDepsForTest } from "../../modules/system/apt-transport.ts";
import * as board from "../../modules/system/board-capabilities.ts";
import {
	PRIVATE_CURL_DIRECTORY,
	PRIVATE_FILE_LEFT_BEHIND,
	setPrivateCurlDirectoryForTest,
} from "../../modules/system/curl-private-url.ts";
import {
	type DeviceDetectionDeps,
	defaultDeviceDetectionDeps,
} from "../../modules/system/device-detection.ts";
import {
	IMAGE_APT_SOURCE_POLICY,
	setDpkgUpdatesDirForTest,
	setImageAptSourceReaderForTest,
	setImageClockGateFlagForTest,
} from "../../modules/system/image-apt-source.ts";
import { setImageOwnedPackagesReaderForTest } from "../../modules/system/image-owned-packages.ts";
import { softwareUpdateOutputPaths } from "../../modules/system/software-update-output.ts";
import { setDetachedAptServiceDepsForTest } from "../../modules/system/software-update-service.ts";
import {
	SOFTWARE_UPDATE_DESCRIPTION,
	SOFTWARE_UPDATE_FRAGMENT_PATH,
	SOFTWARE_UPDATE_LOCK,
	SOFTWARE_UPDATE_UNIT,
} from "../../modules/system/software-update-service-contract.ts";
import {
	getAvailableUpdates,
	getUpdateState,
	installAttemptStateForTest,
	packageInstallDraining,
	resetAptReachabilityProbeForTest,
	resetSoftwareUpdateCheckRunner,
	resetSoftwareUpdateState,
	runSoftwareUpdateCheck,
	setAptCommandRunnerForTest,
	setDelayedStartTimerForTest,
	startSoftwareUpdate,
	takePackageAttemptEnd,
	triggerManualUpdateCheck,
} from "../../modules/system/software-updates.ts";
import { setStreamLivenessSourceForTest } from "../../modules/system/stream-liveness-source.ts";
import { setCeraliveSourcesFileForTest } from "../../modules/system/update-apt-channel.ts";
import * as capabilityFile from "../../modules/system/update-capabilities.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../../modules/system/update-orchestrator/runtime.ts";
import * as storedState from "../../modules/system/update-orchestrator/stored-state-file.ts";
import { stopPackageInstallUnitForStream } from "../../modules/system/update-orchestrator/stream-abort.ts";
import {
	initialOrchestratorState,
	PACKAGE_INSTALL_REFUSED,
} from "../../modules/system/update-orchestrator/types.ts";
import {
	defaultUpdateTransportDeps,
	selectUpdateTransport,
} from "../../modules/system/update-transport/executor.ts";
import { createUpdatePinController } from "../../modules/system/update-transport/pin.ts";
import { notificationRemove } from "../../modules/ui/notifications.ts";
import * as compat from "../../rpc/compat.ts";
import { armedMarkerFixture } from "../software-updates-marker-harness.ts";
import { PINNED_CAPABILITIES } from "./apt-transport-fixture.ts";
import {
	createAwaitSequencer,
	type GateAnswer,
	settleEventLoop,
} from "./await-sequencer.ts";
import {
	fakeDeps,
	quarantineDirs,
	testQuarantine,
} from "./orchestrator-runtime-harness.ts";

const HOST = "updates.example.org";
const TOKEN = "k7Qm2xV9pL4sT8wZb3Nc";
const URI = `https://${HOST}/${TOKEN}/apt`;
const SUITE = "rock-5b-plus-2026.11.6";
const EMERGENCY = `${SUITE}-emergency`;
const SOURCES_FILE = "/etc/apt/sources.list.d/openstreambox.sources";
const FILES: Record<string, string> = {
	[IMAGE_APT_SOURCE_POLICY]: `{"schema":1,"sourcesFile":"${SOURCES_FILE}","host":"${HOST}","origin":"OpenStreamBox","label":"OpenStreamBox","suites":["${SUITE}","${EMERGENCY}"]}`,
	[SOURCES_FILE]: `Types: deb\nURIs: ${URI}/\nSuites: ${SUITE} ${EMERGENCY}\nComponents: main\nSigned-By: /usr/share/keyrings/openstreambox-archive-keyring.pgp\n`,
};
const OUR_MAIN = `${URI} ${SUITE}/main arm64 Packages`;
const OUR_EMERGENCY = `${URI} ${EMERGENCY}/main arm64 Packages`;
const INVENTORY = `Package files:
 100 /var/lib/dpkg/status
     release a=now
 500 ${OUR_EMERGENCY}
     release o=OpenStreamBox,a=${EMERGENCY},n=${EMERGENCY},l=OpenStreamBox,c=main,b=arm64
     origin ${HOST}
 500 ${OUR_MAIN}
     release o=OpenStreamBox,a=${SUITE},n=${SUITE},l=OpenStreamBox,c=main,b=arm64
     origin ${HOST}
Pinned packages:
`;
const OLD = "1.24.2-2~ceralive.3+osb2";
const FIX = "1.24.2-2~ceralive.3+osb3";
const POLICY = `modemmanager:
  Installed: ${OLD}
  Candidate: ${FIX}
  Version table:
     ${FIX} 990
        500 ${OUR_EMERGENCY}
 *** ${OLD} 100
        500 ${OUR_MAIN}
        100 /var/lib/dpkg/status
`;
const OFFER = `Reading package lists...\nBuilding dependency tree...\nReading state information...\nCalculating upgrade...\n1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\nInst modemmanager [${OLD}] (${FIX} OpenStreamBox:${EMERGENCY} [arm64])\nConf modemmanager (${FIX} OpenStreamBox:${EMERGENCY} [arm64])\n`;
const REFRESH = `Hit:1 ${URI} ${SUITE} InRelease\nHit:2 ${URI} ${EMERGENCY} InRelease\nReading package lists...\n`;
/** The pending package list an orchestrated install records. */
export const PENDING = [{ name: "modemmanager", version: FIX }];
/** The launcher's `systemd-run`: once it returned, the unit is submitted. */
export const SUBMIT = "unit: systemd-run";
/** What an uncertain `systemd-run` is followed by, inside the launch fence. */
export const REINSPECT = "unit: systemctl show";
/** A unit that was found is then checked against its fragment. */
export const FRAGMENT = "unit: read its fragment";
export const DELAY = "delayed start: timer";
/** A probe's private curl config is removed by its exact path. */
export const CONFIG_REMOVAL = "file: private-file:remove (remove the file)";
/** A probe's first step: the service's private directory is there. */
export const CONFIG_DIRECTORY =
	"file: private-file:create (make the directory)";
/** Recorded when an install asked for the host's gateway election. */
export const ELECTION_REQUESTED = "asked for the host's gateway election";
/** The first step of the unit's output files. */
export const SPOOL = "file: spool:secure-directory (make the directory)";
export const REFRESH_COMMAND = "apt-get update";
export const DOWNLOAD = "apt-get -d (download under the pin)";
export const ARCHIVE_CLEANUP = "apt-get clean";
/**
 * Each test replays the install once per wait: far more than one test's usual
 * budget on a loaded machine.
 */
export const TIMEOUT_MS = 900_000;

/**
 * - `orchestrated`: Install now through the orchestrator, apt unbound.
 * - `pinned`: the same on an image that routes apt (the download runs under
 *   the pin before the unit exists).
 * - `start RPC`: the standalone start, which the orchestrator does not start
 *   and never records, beside an offer the orchestrator holds.
 * - `start RPC from the Packages card`: the same as the shipped dialog calls
 *   it. The card's own check found the offer, the orchestrator is idle.
 * - `delayed`: Install now while another check runs, so the start waits.
 * - `elected route`: Install now on a board whose default route the backend
 *   elects and whose image does not route apt. Its apt runs are unbound and
 *   go by a fresh probe of the route as it is. The election is the network
 *   module's: the install never asks for it.
 */
export const VARIANTS = [
	"orchestrated",
	"pinned",
	"start RPC",
	"start RPC from the Packages card",
	"delayed",
	"elected route",
] as const;
export type Variant = (typeof VARIANTS)[number];
/** The orchestrator's phase beside a standalone start: it never changes it. */
export const BESIDE_START_RPC: Partial<Record<Variant, "available" | "idle">> =
	{
		"start RPC": "available",
		"start RPC from the Packages card": "idle",
	};

const ok = (stdout = ""): SpawnOverrideResult => ({
	exitCode: 0,
	stdout,
	stderr: "",
});
const failed = (exitCode: number, stderr: string): SpawnOverrideResult => ({
	exitCode,
	stdout: "",
	stderr,
});

const bin = (argv: readonly string[]) => path.basename(argv[0] ?? "");

/** The name a command's wait goes by. */
function commandLabel(argv: readonly string[]): string {
	const args = argv.slice(1);
	switch (bin(argv)) {
		case "apt-mark":
			return "apt-mark showhold";
		case "apt-cache":
			return argv.at(-1) === "policy"
				? "apt-cache policy"
				: "apt-cache policy <package>";
		case "apt-config":
			return "apt-config shell";
		case "apt-get":
			if (args.includes("update")) return REFRESH_COMMAND;
			if (args.includes("clean")) return ARCHIVE_CLEANUP;
			if (args.includes("--print-uris")) return "apt-get --print-uris";
			if (args.includes("-s"))
				return args.includes("install")
					? "apt-get -s install (pinned recheck)"
					: "apt-get -s (discovery)";
			if (args.includes("-d")) return DOWNLOAD;
			return `apt-get ${args[0]}`;
		case "systemd-run":
			return SUBMIT;
		case "systemctl":
			return args[0] === "show" ? REINSPECT : `unit: systemctl ${args[0]}`;
		case "curl": {
			const device = args[args.indexOf("--interface") + 1];
			return `curl ${args.includes("-6") ? "-6" : "-4"}${
				args.includes("--interface") ? ` on ${device?.replace("if!", "")}` : ""
			}`;
		}
		case "resolvectl":
			return `resolvectl ${args.slice(0, 3).join(" ")} query`;
		case "nmcli":
			return "nmcli device show";
		case "gpgv":
			return "gpgv InRelease";
		default:
			// The routing commands, in full.
			return argv.join(" ");
	}
}

const SYSTEMCTL_ABSENT =
	"LoadState=not-found\nActiveState=inactive\nSubState=dead\n";
// One uplink, unmetered, as NetworkManager lists it.
const NMCLI =
	"GENERAL.DEVICE:eth0\nGENERAL.IP-IFACE:eth0\nGENERAL.TYPE:ethernet\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:no";
const IN_RELEASE = `Origin: OpenStreamBox\nLabel: OpenStreamBox\nSuite: ${SUITE}\n`;
/** What apt prints for the download under the pin. */
export const DOWNLOADED = `Get:1 ${URI} ${EMERGENCY}/main arm64 modemmanager arm64 ${FIX} [1234 kB]\nFetched 1234 kB in 1s (1234 kB/s)\n`;

// The detached unit, as systemd would know it: `systemd-run`, `systemctl
// show` and the stop are commands like any other, answered from here.
function fakeUnit() {
	const unit = {
		/** `systemd-run` calls made (the submission is in flight or done). */
		submissions: 0,
		stops: 0,
		state: "absent" as "absent" | "running",
		/**
		 * When `systemd-run`'s client fails: whether PID 1 created the unit all
		 * the same. The launcher finds out by looking again.
		 */
		createdDespiteClientError: false,
		// Stopped, or the test is over: whatever looks finds it gone or finished.
		ended: null as "absent" | "finished" | null,
		/** The script `systemd-run` was given. */
		script: "",
		wake: Promise.withResolvers<void>(),
	};
	// `systemctl show`, in the shape systemd prints it.
	const show = (): string => {
		const now = unit.ended ?? unit.state;
		if (now === "absent") return SYSTEMCTL_ABSENT;
		const states =
			now === "finished"
				? "LoadState=loaded\nActiveState=failed\nSubState=failed\nExecMainCode=1\nExecMainStatus=100\n"
				: "LoadState=loaded\nActiveState=active\nSubState=running\nExecMainCode=0\nExecMainStatus=0\n";
		return `Id=${SOFTWARE_UPDATE_UNIT}\nFragmentPath=${SOFTWARE_UPDATE_FRAGMENT_PATH}\nDescription=${SOFTWARE_UPDATE_DESCRIPTION}\n${states}Transient=yes\nType=exec\nRemainAfterExit=yes\nStandardOutput=append\nStandardError=append\nUser=\nExecStartPre=\nExecStartPost=\nExecStart={ path=/usr/bin/flock ; argv[]=/usr/bin/flock -x ${SOFTWARE_UPDATE_LOCK} /bin/sh -ec ${unit.script} ; ignore_errors=no ; start_time=[Thu 2026-11-26 09:00:00 UTC] ; stop_time=[n/a] ; pid=4242 ; code=(null) ; status=0/0 }\n`;
	};
	return {
		unit,
		show,
		/** `systemd-run` was asked for. */
		submitting(argv: readonly string[]) {
			unit.submissions++;
			unit.script = argv.at(-1) ?? "";
		},
		stop() {
			unit.stops++;
			unit.ended = "absent";
			unit.wake.resolve();
		},
		finish() {
			unit.ended ??= unit.state === "running" ? "finished" : "absent";
			unit.wake.resolve();
		},
	};
}

type Unit = ReturnType<typeof fakeUnit>;

/** What a command answers once its wait is released. */
function commandAnswer(
	argv: readonly string[],
	unit: Unit,
): SpawnOverrideResult {
	const args = argv.slice(1);
	const line = argv.join(" ");
	switch (bin(argv)) {
		case "apt-cache":
			return ok(argv.at(-1) === "policy" ? INVENTORY : POLICY);
		case "apt-config":
			return ok("ARCHIVES='/cache/archives/';");
		case "apt-get":
			if (args.includes("update")) return ok(REFRESH);
			if (args.includes("--print-uris"))
				return ok(
					"After this operation, 2 kB of additional disk space will be used.\n'https://updates.example.org/a.deb' a.deb 4000 SHA256:abc\n",
				);
			if (args.includes("-s")) return ok(OFFER);
			// The download says what it fetched, from the source's own URL.
			return ok(args.includes("-d") ? DOWNLOADED : "");
		case "systemd-run":
			unit.unit.state = "running";
			return ok();
		case "systemctl":
			if (args[0] === "show") return ok(unit.show());
			if (args[0] === "stop") unit.stop();
			return ok();
		case "nmcli":
			return ok(NMCLI);
		case "resolvectl":
			// One address family answers: the uplink is IPv4 only.
			return args.includes("-6")
				? failed(1, "")
				: ok(`${argv.at(-1)}: 192.0.2.10`);
		case "curl":
			// The per-uplink probe fetches the index; the unbound one asks for
			// the status only.
			return ok(
				args.includes("--resolve")
					? `${IN_RELEASE}\n<<<update-probe>>>200 0.05`
					: "200 ",
			);
		case "ip":
			return ok(
				line.endsWith("route show default")
					? "default dev eth0\ndefault dev wlan0"
					: "",
			);
		default:
			return ok();
	}
}

/** What a command answers when its wait is released as a failure. */
function commandFailure(
	argv: readonly string[],
	unit: Unit,
): SpawnOverrideResult {
	switch (bin(argv)) {
		case "apt-get":
		case "apt-cache":
		case "apt-mark":
		case "apt-config":
			return failed(100, "E: failed\n");
		case "systemd-run":
			if (unit.unit.createdDespiteClientError) unit.unit.state = "running";
			return failed(1, "systemd-run: Connection timed out");
		case "systemctl":
			return failed(1, `systemctl ${argv[1]}: Connection timed out`);
		case "curl":
			// Could not connect.
			return failed(7, "curl: (7) Failed to connect");
		default:
			return failed(1, `${bin(argv)}: failed`);
	}
}

const scratch: string[] = [];
let spies: ReturnType<typeof spyOn>[] = [];
// The spies of one install: restored with it, so each replay starts clean.
const installSpies: ReturnType<typeof spyOn>[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
const updatesEnabled = setup.apt_update_enabled;
const hasBoardCapability = board.hasCapability;
// What the real lookup reads on a host that is no board: none of its files
// is there. Answered here instead of by the host, so nothing outside the
// install waits on a real file read whose length no test can count on.
const absent = (): Promise<string> => Promise.reject(new Error("ENOENT"));
const NO_BOARD_FILES: DeviceDetectionDeps = {
	...defaultDeviceDetectionDeps,
	readDeviceTreeModel: absent,
	readDeviceTreeCompatible: absent,
	readCeraliveRelease: absent,
	readDmiProductName: absent,
	readDmiBoardName: absent,
};
const readStoredStateFile = storedState.readStoredStateFile;

/** A line the device logged, and who logged it. */
type Logged = {
	readonly level: "debug" | "info" | "warn" | "error";
	readonly message: string;
	/** What was logged with it, as it would be printed. */
	readonly detail: string;
	readonly by: "flow" | "beside" | "outside";
	/**
	 * It reports a teardown that failed: a routing rule or route was left, or
	 * a private curl config is still on disk.
	 */
	readonly teardownFailed: boolean;
};

// A pinned run whose teardown failed: the pin's aggregate, or the lease that
// could not be released clean.
const isTeardownFailure = (meta: unknown): boolean => {
	const error = (meta as { error?: unknown } | undefined)?.error;
	return (
		error instanceof AggregateError ||
		(error instanceof AptRoutingRefusal && error.reason === "cleanup-pending")
	);
};
const logged: Logged[] = [];
// Whose log lines are whose: the sequencer of the install in progress.
let logContext: (() => Logged["by"]) | undefined;

/**
 * What an install did after it had ended that is not on the teardown list:
 * collected as it happens, whatever the test looks at.
 */
const staleEffects: string[] = [];

/** The stale effects seen since the last call, and none left behind. */
export function takeStaleEffects(): string[] {
	return staleEffects.splice(0);
}

/** Puts updates back as the test file found them. */
export function restoreUpdatesSetting(): void {
	setup.apt_update_enabled = updatesEnabled;
}

/** Ends an install of this fixture and everything it set. */
export async function teardownInstall(): Promise<void> {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	restoreUpdatesSetting();
	resetOrchestratorRuntimeForTest();
	setImageAptSourceReaderForTest(null);
	setImageClockGateFlagForTest(null);
	setDpkgUpdatesDirForTest(null);
	setImageOwnedPackagesReaderForTest(null);
	setCeraliveSourcesFileForTest(null);
	setAptCommandRunnerForTest(null);
	setAptTransportDepsForTest(null);
	setDetachedAptServiceDepsForTest(null);
	setDelayedStartTimerForTest(null);
	setStreamLivenessSourceForTest(null);
	resetAptReachabilityProbeForTest();
	resetAptReachabilityCacheForTest();
	resetSoftwareUpdateCheckRunner();
	resetSoftwareUpdateState();
	setPrivateCurlDirectoryForTest(null);
	setSpawnOverrideForTest(null);
	setOwnedFileBackendForTest(null);
	setOwnedWriteObserverForTest(null);
	logContext = undefined;
	logged.length = 0;
	notificationRemove("ceralive_update_failed");
	for (const dir of quarantineDirs.splice(0))
		await rm(dir, { recursive: true, force: true });
	for (const dir of scratch.splice(0))
		await rm(dir, { recursive: true, force: true });
	for (const spy of installSpies.splice(0)) spy.mockRestore();
}

/**
 * Logs kept instead of printed for the file's tests, and the fixture torn
 * down after each.
 */
export function useInstallHarness(): void {
	beforeEach(() => {
		spies = (["debug", "info", "warn", "error"] as const).map((level) =>
			spyOn(logger, level).mockImplementation(
				(message: unknown, meta?: unknown) => {
					logged.push({
						level,
						message: String(message),
						detail: meta === undefined ? "" : inspect(meta, { depth: 6 }),
						by: logContext?.() ?? "outside",
						teardownFailed:
							isTeardownFailure(meta) || message === PRIVATE_FILE_LEFT_BEHIND,
					});
					return logger;
				},
			),
		);
	});
	afterEach(async () => {
		await teardownInstall();
		for (const spy of spies.splice(0)) spy.mockRestore();
		staleEffects.length = 0;
	});
}

/**
 * A box with the record and an offer of one emergency fix, the orchestrator
 * over the real package code, and an install just accepted: its first wait is
 * parked on the sequencer.
 */
export async function acceptedInstall(variant: Variant) {
	const dir = await mkdtemp(path.join(tmpdir(), "image-apt-fence-"));
	scratch.push(dir);
	// A launch notes a planned shutdown in the armed-stream marker.
	const marker = await armedMarkerFixture();
	cleanups.push(() => marker[Symbol.asyncDispose]());
	const flag = path.join(dir, "clock-gate-open");
	await writeFile(flag, "");
	const sequencer = createAwaitSequencer();
	logContext = sequencer.context;
	// The labels of what an ended install may still do (effect-owner.ts).
	const teardown = new Set<string>();
	// Every effect passes here before it happens.
	const effect = (label: string, isTeardown: boolean): void => {
		if (isTeardown) teardown.add(label);
		else if (
			sequencer.armed() &&
			sequencer.context() === "flow" &&
			installAttemptStateForTest() === "ended"
		)
			staleEffects.push(label);
	};
	// A fake's answer once its wait is released; `failure` when it is released
	// as a failure (by default the call throws).
	const wait = async <T>(
		label: string,
		answer: () => T,
		failure: () => T = () => {
			throw new Error(`${label}: failed`);
		},
	): Promise<T> => {
		effect(label, false);
		return (await sequencer.gate(label)) === "fail" ? failure() : answer();
	};
	const pinned = variant === "pinned";
	const routed = variant === "elected route";
	const unit = fakeUnit();
	// What kind of call a label stands for: something done, or a look.
	const effects = new Set<string>();
	/** Who asked for the host's gateway election, in order, and how. */
	const electionRequests: {
		by: "flow" | "beside" | "outside";
		args: unknown[];
	}[] = [];
	/** The private files that exist: written and not removed. */
	const privateFiles = new Set<string>();
	/** The routing journal of a pinned run, as its store holds it. */
	const journal = { entries: [] as readonly AptRoutingEntry[] };

	// Every command of both spawn primitives.
	setSpawnOverrideForTest(async (argv) => {
		const label = commandLabel(argv);
		effects.add(label);
		effect(label, isOwnerTeardownCommand(argv));
		if (bin(argv) === "systemd-run") unit.submitting(argv);
		return (await sequencer.gate(label)) === "fail"
			? commandFailure(argv, unit)
			: commandAnswer(argv, unit);
	});

	// Every file made or changed for an install. The write's kind is told to
	// the observer right before the file step it belongs to.
	let kind: OwnedWrite | undefined;
	const fileStep = async (step: string): Promise<GateAnswer> => {
		const label = `file: ${kind} (${step})`;
		effects.add(label);
		effect(label, kind !== undefined && isOwnerTeardownWrite(kind));
		return sequencer.gate(label);
	};
	const fileWrite = async (step: string): Promise<void> => {
		const label = `file: ${kind} (${step})`;
		effects.add(label);
		effect(label, kind !== undefined && isOwnerTeardownWrite(kind));
		if ((await sequencer.gate(label)) === "fail")
			throw new Error(`${label}: failed`);
	};
	let temporary = 0;
	const files: OwnedFileBackend = {
		makeDirectory: () => fileWrite("make the directory"),
		inspect: async () => {
			if ((await fileStep("look at it")) === "fail")
				throw new Error("the directory could not be read");
			return {
				isDirectory: () => true,
				isSymbolicLink: () => false,
				uid: 0,
				mode: 0o700,
			};
		},
		setMode: () => fileWrite("set its mode"),
		removeFile: async (file) => {
			await fileWrite("remove the file");
			privateFiles.delete(file);
		},
		removeTree: async (directory) => {
			await fileWrite("remove the directory");
			for (const file of privateFiles)
				if (path.dirname(file) === directory) privateFiles.delete(file);
		},
		createExclusive: async () => {
			await fileWrite("create the file");
			return {
				stat: async () => {
					if ((await fileStep("look at the file")) === "fail")
						throw new Error("the file could not be read");
					return { isFile: () => true, uid: 0, nlink: 1 };
				},
				chmod: () => fileWrite("set the file's mode"),
				close: async () => {
					// Nothing is open: the file is an object.
				},
			};
		},
		makeTempDirectory: async (prefix) => {
			await fileWrite("make a private directory");
			return `${prefix}${++temporary}`;
		},
		writeNew: async (file) => {
			await fileWrite("write the file");
			privateFiles.add(file);
		},
	};
	setOwnedFileBackendForTest(files);
	// The box's backend holds the single-instance lock: its probes' configs
	// go to the service's own directory.
	setPrivateCurlDirectoryForTest(PRIVATE_CURL_DIRECTORY);
	setOwnedWriteObserverForTest((next) => {
		kind = next;
		if (next.startsWith("spool:") || next.startsWith("private-file:")) return;
		// A write to state does not wait: it is kept in the ledger as it is.
		const label = `write: ${next}`;
		effects.add(label);
		effect(label, isOwnerTeardownWrite(next));
		sequencer.note(label);
	});

	setImageAptSourceReaderForTest((file) => FILES[file] ?? null);
	setImageClockGateFlagForTest(flag);
	setDpkgUpdatesDirForTest(path.join(dir, "updates"));
	setCeraliveSourcesFileForTest(path.join(dir, "ceralive.sources"));
	setImageOwnedPackagesReaderForTest(
		() => wait("read the image's own package list", () => null),
		path.join(dir, "no-pin"),
	);
	resetAptReachabilityCacheForTest();
	const capabilities: UpdateCapabilities = {
		mode: "capable",
		features: [
			"apt-all-packages",
			"rauc-verity-streaming",
			...(pinned ? (["transport-uidrange"] as const) : []),
		],
	};
	const frames: { kind: string; reason?: string }[] = [];
	const emitted: { code: string; params: unknown }[] = [];
	const outputs = softwareUpdateOutputPaths();
	installSpies.push(
		spyOn(capabilityFile, "readUpdateCapabilities").mockImplementation(() =>
			wait(
				"read the update capabilities",
				() => capabilities,
				() => {
					throw new capabilityFile.UpdateCapabilityReadError(
						new Error("unreadable"),
					);
				},
			),
		),
		// The pinned transport serves a board that routes apt itself. Anything
		// but the install (the orchestrator's own requests) asks the real one,
		// on a host that is no board.
		spyOn(board, "hasCapability").mockImplementation((capability, deps) =>
			sequencer.isOutside()
				? hasBoardCapability(capability, deps ?? NO_BOARD_FILES)
				: wait(
						`read the board capability ${capability}`,
						() => pinned || (routed && capability === "os-updates"),
					),
		),
		// The space preflight's commands are spawned; its two looks at the
		// archive directory are not.
		spyOn(defaultAptSpaceDeps, "stat").mockImplementation(() =>
			wait("space preflight: stat", () => ({ dev: 1n })),
		),
		spyOn(defaultAptSpaceDeps, "statfs").mockImplementation(() =>
			wait("space preflight: statfs", () => ({
				bavail: 10n ** 12n,
				bsize: 1n,
			})),
		),
		// A unit that was found is checked against the fragment systemd wrote.
		spyOn(storedState, "readStoredStateFile").mockImplementation(
			(file, maxBytes) =>
				file === SOFTWARE_UPDATE_FRAGMENT_PATH
					? wait(
							FRAGMENT,
							() =>
								`[Service]\nStandardOutput=append:${outputs.stdout}\nStandardError=append:${outputs.stderr}\n`,
							() => null,
						)
					: readStoredStateFile(file, maxBytes),
		),
		// Every status frame that carries the package state, in order.
		spyOn(compat, "broadcastMsg").mockImplementation((type, data) => {
			const state = (
				data as { update_state?: { kind: string; reason?: string } }
			).update_state;
			if (type === "status" && state)
				frames.push({
					kind: state.kind,
					...(state.reason === undefined ? {} : { reason: state.reason }),
				});
		}),
		// Every event the device would log, in order.
		spyOn(events, "emitEvent").mockImplementation((code, params) => {
			emitted.push({ code, params });
		}),
	);
	// The real launcher, but for the unit's output and its poll interval: the
	// unit runs until it is stopped or the test ends.
	setDetachedAptServiceDepsForTest((real) => ({
		...real,
		readOutput: async (_file, offset) => ({
			bytes: new Uint8Array(),
			nextOffset: offset,
		}),
		sleep: async () => {
			await unit.unit.wake.promise;
			await settleEventLoop(1);
		},
	}));
	cleanups.push(async () => {
		sequencer.disarm();
		unit.finish();
		await settleEventLoop(4);
	});

	// The delayed start's timer fires when the sequencer says so.
	const cancelled = new Set<object>();
	setDelayedStartTimerForTest({
		set: (run) => {
			const handle = {};
			void sequencer.gate(DELAY, { timer: true }).then(async () => {
				// Unarmed, it still must not fire before the check it waits for.
				if (!sequencer.armed()) await settleEventLoop(2);
				if (!cancelled.has(handle)) run();
			});
			return handle;
		},
		clear: (handle) => {
			cancelled.add(handle as object);
			sequencer.cancel(DELAY);
		},
	});

	if (pinned) {
		// The real selection, pin and routing lease. Underneath: the routing
		// journal's store, the pin's capability file and which uplinks exist.
		const ownership = createAptRoutingOwnership({
			read: () => wait("routing journal: read", () => journal.entries),
			save: (next) => {
				journal.entries = next;
			},
		});
		const pin = createUpdatePinController({
			readCapabilities: () =>
				wait(
					"pin: read the capability file",
					() => updateCapabilityFileSchema.parse(PINNED_CAPABILITIES),
					() => undefined,
				),
			now: () => 1000,
		});
		await pin.sweep();
		setAptTransportDepsForTest({
			select: (owner) =>
				selectUpdateTransport(
					{ profile: "apt", board: "apt", channel: "stable" },
					{
						...defaultUpdateTransportDeps,
						listIfnames: () => ["eth0"],
						mmIfnames: () => [],
						routerIfnames: () => [],
						dongleIfnames: () => [],
					},
					owner,
				),
			pin,
			ownership,
		});
	}

	// The host's gateway election is the network module's. Whoever asks for
	// it here is recorded; an install that does has failed the run. It
	// answers at once that the route is in order.
	installSpies.push(
		spyOn(gateways, "updateGwWrapper").mockImplementation((...args) => {
			const by = sequencer.context();
			electionRequests.push({ by, args });
			if (sequencer.armed() && by === "flow")
				staleEffects.push(ELECTION_REQUESTED);
			return Promise.resolve(true);
		}),
	);

	// `parkChecks`: the orchestrator's package check parks on the sequencer
	// like the install does (beside it), so a test can stand inside it.
	const counts = { osChecks: 0, parkChecks: false };
	const quarantine = testQuarantine();
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			quarantine,
			loadCapabilities: async () => ({
				mode: "capable",
				features: ["apt-all-packages", "rauc-verity-streaming"],
			}),
			loadSettings: async () => ({
				packagesAuto: true,
				systemAuto: true,
				schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
				channel: "stable",
				allowPackagesOverCellular: true,
				allowSystemOverCellular: true,
			}),
			runPackageCheck: () =>
				counts.parkChecks
					? sequencer.beside(() => runSoftwareUpdateCheck())
					: runSoftwareUpdateCheck(),
			startPackageInstall: () => {
				// Accepted: from here every wait of the install parks.
				const arming = !sequencer.armed();
				sequencer.arm();
				const outcome = sequencer.inside(() => startSoftwareUpdate());
				if (!outcome.started && arming) sequencer.disarm();
				return outcome;
			},
			getPackageInstallWireState: getUpdateState,
			takePackageAttemptEnd,
			// The real stop: its `systemctl stop` is answered by the unit above.
			stopPackageInstallUnit: stopPackageInstallUnitForStream,
			checkOsManifest: async () => {
				counts.osChecks++;
				return {
					available: false,
					rateLimited: false,
					failed: false,
					reason: "",
				};
			},
		}),
	);
	setOrchestratorStateForTest(initialOrchestratorState(0));

	// The offer, found by a check before anything is asked for.
	if (variant === "start RPC from the Packages card") {
		// The card's own check: the orchestrator takes no part and stays idle.
		expect(triggerManualUpdateCheck()).toBe(true);
		for (let turn = 0; turn < 200; turn++) {
			if (getUpdateState().kind === "available") break;
			await settleEventLoop(1);
		}
		// The offer shows before the check has quite ended: let it end, or the
		// start below would wait behind it.
		await settleEventLoop(3);
		expect(getOrchestratorState().phase).toBe("idle");
	} else {
		expect(await sequencer.outside(() => checkUpdatesNow())).toEqual({
			started: true,
		});
		expect(getOrchestratorState().phase).toBe("available");
	}
	expect(getUpdateState().kind).toBe("available");
	frames.length = 0;
	emitted.length = 0;

	if (BESIDE_START_RPC[variant] !== undefined) {
		sequencer.arm();
		expect(startSoftwareUpdate()).toEqual({ started: true });
	} else {
		if (variant === "delayed") {
			// A dialog's own check is running when the install is asked for. It
			// parks like the install, and its calls are its own.
			sequencer.arm();
			expect(sequencer.beside(() => triggerManualUpdateCheck())).toBe(true);
		}
		expect(
			await sequencer.outside(() => installUpdatesNow({ scope: "packages" })),
		).toEqual({ started: true });
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(await quarantine.readPending()).toEqual(PENDING);
	}

	/**
	 * What can be seen of the install right now. Two of these taken while
	 * nothing but an ended install runs must be equal: it writes nothing.
	 */
	const observe = () => {
		const orchestrator = getOrchestratorState();
		return {
			wire: getUpdateState(),
			inventory: getAvailableUpdates(),
			frames: frames.length,
			events: emitted.length,
			orchestrator: {
				phase: orchestrator.phase,
				failureReason: orchestrator.failureReason,
				// The next check's due time and failure count: the backoff.
				packageCheck: orchestrator.packageCheck,
			},
			unit: { submissions: unit.unit.submissions, stops: unit.unit.stops },
			// How often anybody asked for the host's gateway election.
			elections: electionRequests.length,
		};
	};
	const box = {
		variant,
		sequencer,
		unit,
		frames,
		emitted,
		counts,
		quarantine,
		flag,
		observe,
		/** A point in time to compare later calls, logs and state against. */
		mark: () => ({
			calls: sequencer.calls().length,
			logs: logged.length,
			seen: observe(),
		}),
		/**
		 * The install's own calls since `mark`: every command, file step, owned
		 * write and read it started. Only what effect-owner.ts lists as the
		 * teardown of an ended owner is left out.
		 */
		callsSince: (mark: { calls: number }) =>
			sequencer
				.calls()
				.slice(mark.calls)
				.filter(({ by, label }) => by === "flow" && !teardown.has(label))
				.map(({ label }) => label),
		/**
		 * Of those, what was done rather than looked at: commands, file steps
		 * and owned writes.
		 */
		effectsSince: (mark: { calls: number }) =>
			box.callsSince(mark).filter((label) => effects.has(label)),
		electionRequests,
		privateFiles,
		journal,
		/** Every line anybody logged since `mark`, with what was logged with it. */
		everyLogSince: (mark: { logs: number }) =>
			logged
				.slice(mark.logs)
				.map(({ message, detail }) =>
					detail ? `${message} ${detail}` : message,
				),
		/**
		 * What the install itself logged since `mark`. Left out is only what
		 * its teardown says: the line `run()` writes for a teardown command,
		 * and the warning that a teardown failed and left a rule behind.
		 */
		logsSince: (mark: { logs: number }) =>
			logged
				.slice(mark.logs)
				.filter(
					({ by, level, message, teardownFailed }) =>
						by === "flow" &&
						!teardownFailed &&
						!(
							level === "debug" &&
							message.startsWith("run: ") &&
							isOwnerTeardownCommand(message.slice(5).split(" "))
						),
				)
				.map(({ level, message }) => `${level}: ${message}`),
	};
	return box;
}

export type Accepted = Awaited<ReturnType<typeof acceptedInstall>>;
export type Mark = ReturnType<Accepted["mark"]>;

/**
 * Nothing stale happened since `mark`: the ended install started no call
 * (no command, no file step, no owned write, no read) and logged nothing,
 * but for the teardown effect-owner.ts lists. And, unless
 * `stateToo` is off because something else is legitimately at work, nothing
 * that can be seen of the install changed: no write to the wire or the
 * inventory, no frame, no event, no backoff, no unit.
 */
export function expectNoStaleEffect(
	box: Accepted,
	mark: Mark,
	stateToo = true,
): void {
	expect(box.callsSince(mark)).toEqual([]);
	expect(box.logsSince(mark)).toEqual([]);
	if (stateToo) expect(box.observe()).toEqual(mark.seen);
}

export const failedFrames = (frames: Accepted["frames"]) =>
	frames.filter(
		({ kind }) => kind === "failed" || kind === "update_preflight_failed",
	);

/** The next Check now: the offer is back and an image check ran. */
export async function expectOfferAtNextCheck(box: Accepted): Promise<void> {
	const { sequencer, counts, quarantine } = box;
	sequencer.disarm();
	restoreUpdatesSetting();
	// The next check comes when the last probe's finding has aged out.
	resetAptReachabilityCacheForTest();
	const os = counts.osChecks;
	expect(await sequencer.outside(() => checkUpdatesNow())).toEqual({
		started: true,
	});
	expect(getUpdateState().kind).toBe("available");
	expect(getOrchestratorState().phase).toBe("available");
	expect(await quarantine.readPending()).toEqual([]);
	expect(counts.osChecks).toBe(os + 1);
}

/** The one outcome of an install that ended before its unit was submitted. */
export async function expectEndedBeforeLaunch(
	box: Accepted,
	reason: string,
	// Another check was running and has found the offer again since.
	superseded: boolean,
): Promise<void> {
	const { unit, frames, quarantine, variant } = box;
	// Nothing was submitted, and nothing is left that could still submit.
	expect(unit.unit.submissions).toBe(0);
	// `failed` went out once, with its reason, and no offer after it unless a
	// check that was already running rediscovered it.
	expect(failedFrames(frames)).toEqual([{ kind: "failed", reason }]);
	const after = frames.slice(frames.findIndex(({ kind }) => kind === "failed"));
	expect(after.some(({ kind }) => kind === "available")).toBe(superseded);
	expect(getUpdateState()).toMatchObject(
		superseded ? { kind: "available" } : { kind: "failed", reason },
	);
	const beside = BESIDE_START_RPC[variant];
	if (beside !== undefined) {
		// The orchestrator did not start this install: it records nothing and
		// keeps its phase. The wire says `failed` and the orchestrator does
		// not, until the next check below brings the two back in line.
		expect(getOrchestratorState()).toMatchObject({
			phase: beside,
			failureReason: null,
		});
		expect(await quarantine.readPending()).toEqual([]);
	} else {
		expect(getOrchestratorState()).toMatchObject({
			phase: "failed",
			failureReason: PACKAGE_INSTALL_REFUSED,
		});
		// The pending package list stays until the next check clears it.
		expect(await quarantine.readPending()).toEqual(PENDING);
	}
	await expectOfferAtNextCheck(box);
	expect(unit.unit.submissions).toBe(0);
}

/**
 * The one outcome of an install whose unit was submitted, left alone.
 * `quietWire` is off when another check ran beside it and may have said
 * `failed` for itself.
 */
export async function expectLaunched(
	box: Accepted,
	quietWire = true,
): Promise<void> {
	const { unit, frames, quarantine, variant } = box;
	expect(unit.unit.submissions).toBe(1);
	expect(unit.unit.state).toBe("running");
	if (quietWire) expect(failedFrames(frames)).toEqual([]);
	expect(getUpdateState().kind).toBe("downloading");
	// Beside a standalone start the orchestrator's phase is its own business.
	if (BESIDE_START_RPC[variant] !== undefined) return;
	expect(getOrchestratorState().phase).toBe("downloading");
	expect(await quarantine.readPending()).toEqual(PENDING);
}

const recorded = new Map<Variant, string[]>();

/**
 * The waits of each install, recorded once per test file from the real code:
 * every label from the accepted start to `systemd-run`, in order.
 */
export async function recordWaits(variant: Variant): Promise<string[]> {
	const known = recorded.get(variant);
	if (known) return known;
	const box = await acceptedInstall(variant);
	const steps = await box.sequencer
		.record((label) => label === SUBMIT)
		.catch((error: unknown) => {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)} (wire: ${JSON.stringify(getUpdateState())})`,
			);
		});
	await box.sequencer.drain();
	await expectLaunched(box);
	expect(takeStaleEffects()).toEqual([]);
	await teardownInstall();
	recorded.set(variant, steps);
	return steps;
}

/** Whether an install that ended still has a wait in flight. */
export const installDraining = packageInstallDraining;

/**
 * Runs `each` at every wait in `steps` it is asked for, tearing the install
 * down in between, and fails with every wait whose run failed.
 */
export async function atEveryWait(
	steps: readonly string[],
	each: (step: number) => Promise<void>,
	only: (label: string, step: number) => boolean = () => true,
): Promise<number> {
	const failures: string[] = [];
	let runs = 0;
	for (let step = 0; step < steps.length; step++) {
		if (!only(steps[step] as string, step)) continue;
		runs++;
		try {
			await each(step);
			// Whatever the test looked at: an ended install did nothing more.
			expect(takeStaleEffects()).toEqual([]);
		} catch (error) {
			takeStaleEffects();
			failures.push(
				`at wait ${step} of ${steps.length} ("${steps[step]}"): ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		await teardownInstall();
	}
	expect(failures).toEqual([]);
	return runs;
}
