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
 * real package code and the real orchestrator over fakes that each park on a
 * sequencer (await-sequencer.ts). The tests that step it through its waits
 * share this fixture, the recording of those waits, and what may be observed
 * of an install at any moment.
 *
 * Only in-process fakes: the unit, apt, the probes, the routing rules and the
 * delayed start's timer are all objects in this file.
 */

import { afterEach, beforeEach, expect, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type UpdateCapabilities,
	updateCapabilityFileSchema,
} from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";
import * as events from "../../modules/events/emit.ts";
import { setup } from "../../modules/setup.ts";
import type { AptRoutingEntry } from "../../modules/system/apt-routing-journal.ts";
import { createAptRoutingOwnership } from "../../modules/system/apt-routing-ownership.ts";
import { defaultAptSpaceDeps } from "../../modules/system/apt-space-admission.ts";
import { abortAptTransferForStream } from "../../modules/system/apt-transfer-abort.ts";
import { setAptTransportDepsForTest } from "../../modules/system/apt-transport.ts";
import * as board from "../../modules/system/board-capabilities.ts";
import {
	IMAGE_APT_SOURCE_POLICY,
	setDpkgUpdatesDirForTest,
	setImageAptSourceReaderForTest,
	setImageClockGateFlagForTest,
} from "../../modules/system/image-apt-source.ts";
import { setImageOwnedPackagesReaderForTest } from "../../modules/system/image-owned-packages.ts";
import { softwareUpdateOutputPaths } from "../../modules/system/software-update-output.ts";
import {
	type DetachedAptServiceDeps,
	setDetachedAptServiceDepsForTest,
} from "../../modules/system/software-update-service.ts";
import {
	getAvailableUpdates,
	getUpdateState,
	packageFailedBeforeLaunch,
	packageInstallDraining,
	resetAptReachabilityProbeForTest,
	resetSoftwareUpdateCheckRunner,
	resetSoftwareUpdateState,
	runSoftwareUpdateCheck,
	setAptCommandRunnerForTest,
	setAptReachabilityProbeForTest,
	setDelayedStartTimerForTest,
	startSoftwareUpdate,
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
import {
	initialOrchestratorState,
	PACKAGE_INSTALL_REFUSED,
} from "../../modules/system/update-orchestrator/types.ts";
import { rankTransports } from "../../modules/system/update-transport/core.ts";
import { createUpdatePinController } from "../../modules/system/update-transport/pin.ts";
import { notificationRemove } from "../../modules/ui/notifications.ts";
import * as compat from "../../rpc/compat.ts";
import { armedMarkerFixture } from "../software-updates-marker-harness.ts";
import { sample } from "./apt-transport-fixture.ts";
import {
	type AwaitSequencer,
	createAwaitSequencer,
	settleEventLoop,
} from "./await-sequencer.ts";
import {
	fakeDeps,
	quarantineDirs,
	testQuarantine,
} from "./orchestrator-runtime-harness.ts";

const HOST = "updates.example.org";
const TOKEN = "k7Qm2xV9pL4sT8wZ";
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
const OK_REACH = {
	ipv4: "ok",
	ipv6: "ok",
	used: "any",
	verdict: "any",
	detail: [],
} as const;
const UNREACHABLE = {
	ipv4: "no_route",
	ipv6: "no_route",
	used: "none",
	verdict: "unreachable",
	detail: [],
} as const;

/** The pending package list an orchestrated install records. */
export const PENDING = [{ name: "modemmanager", version: FIX }];
/** The launcher's `systemd-run`: once it returned, the unit is submitted. */
export const SUBMIT = "unit: systemd-run";
/** What an uncertain `systemd-run` is followed by, inside the launch fence. */
export const REINSPECT = "unit: systemctl show";
export const DELAY = "delayed start: timer";
export const SPOOL = "unit: prepare its output files";
export const REFRESH_COMMAND = "apt-get update";
/**
 * Each test replays the install once per wait: far more than one test's usual
 * budget on a loaded machine.
 */
export const TIMEOUT_MS = 480_000;

/**
 * - `orchestrated`: Install now through the orchestrator, apt unbound.
 * - `pinned`: the same on an image that routes apt (the download runs under
 *   the pin before the unit exists).
 * - `start RPC`: the standalone start, which the orchestrator does not start
 *   and never records, beside an offer the orchestrator holds.
 * - `start RPC from the Packages card`: the same as the shipped dialog calls
 *   it. The card's own check found the offer, the orchestrator is idle.
 * - `delayed`: Install now while another check runs, so the start waits.
 */
export const VARIANTS = [
	"orchestrated",
	"pinned",
	"start RPC",
	"start RPC from the Packages card",
	"delayed",
] as const;
export type Variant = (typeof VARIANTS)[number];
/** The orchestrator's phase beside a standalone start: it never changes it. */
export const BESIDE_START_RPC: Partial<Record<Variant, "available" | "idle">> =
	{
		"start RPC": "available",
		"start RPC from the Packages card": "idle",
	};

const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
const aptFailed = () => ({ exitCode: 100, stdout: "", stderr: "E: failed\n" });

function aptLabel(argv: readonly string[]): string {
	if (argv[0] === "/usr/bin/apt-mark") return "apt-mark showhold";
	if (argv[0] === "/usr/bin/apt-cache")
		return argv.at(-1) === "policy"
			? "apt-cache policy"
			: "apt-cache policy <package>";
	if (argv[1] === "update" || argv.includes("update")) return REFRESH_COMMAND;
	if (argv.includes("-s") && argv.includes("install"))
		return "apt-get -s install (pinned recheck)";
	if (argv.includes("-s")) return "apt-get -s (discovery)";
	if (argv.includes("-d")) return "apt-get -d (download under the pin)";
	return `apt ${argv.slice(0, 2).join(" ")}`;
}

function aptAnswer(argv: readonly string[]) {
	if (argv[0] === "/usr/bin/apt-cache")
		return ok(argv.at(-1) === "policy" ? INVENTORY : POLICY);
	if (argv.includes("update")) return ok(REFRESH);
	if (argv.includes("-s")) return ok(OFFER);
	return ok();
}

// The detached unit, as an object: `systemd-run`, `systemctl show` and the
// stop are answers from here.
function fakeUnit(sequencer: AwaitSequencer) {
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
		wake: Promise.withResolvers<void>(),
	};
	const deps: DetachedAptServiceDeps = {
		outputPaths: softwareUpdateOutputPaths(),
		prepareOutput: async () => {
			if ((await sequencer.gate(SPOOL)) === "fail")
				throw new Error("the output files could not be created");
		},
		start: async () => {
			unit.submissions++;
			if ((await sequencer.gate(SUBMIT)) === "fail") {
				if (unit.createdDespiteClientError) unit.state = "running";
				throw new Error("systemd-run: Connection timed out");
			}
			unit.state = "running";
		},
		inspect: async () => {
			if ((await sequencer.gate(REINSPECT)) === "fail")
				throw new Error("systemctl show: Connection timed out");
			if (unit.ended === "finished")
				return { kind: "finished", exitCode: 100, cleanup: "stop" };
			return { kind: unit.ended ?? unit.state };
		},
		cleanup: async () => {
			// Nothing to clean up: the unit is an object.
		},
		readOutput: async (_file, offset) => ({
			bytes: new Uint8Array(),
			nextOffset: offset,
		}),
		// The unit runs until it is stopped or the test ends.
		sleep: async () => {
			await unit.wake.promise;
			await settleEventLoop(1);
		},
	};
	return {
		unit,
		deps,
		stop() {
			unit.stops++;
			unit.ended = "absent";
			unit.wake.resolve();
		},
		finish() {
			unit.ended ??= "finished";
			unit.wake.resolve();
		},
	};
}

const scratch: string[] = [];
let spies: ReturnType<typeof spyOn>[] = [];
// The spies of one install: restored with it, so each replay starts clean.
const installSpies: ReturnType<typeof spyOn>[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
const updatesEnabled = setup.apt_update_enabled;
const hasBoardCapability = board.hasCapability;

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
	resetSoftwareUpdateCheckRunner();
	resetSoftwareUpdateState();
	notificationRemove("ceralive_update_failed");
	for (const dir of quarantineDirs.splice(0))
		await rm(dir, { recursive: true, force: true });
	for (const dir of scratch.splice(0))
		await rm(dir, { recursive: true, force: true });
	for (const spy of installSpies.splice(0)) spy.mockRestore();
}

/** Quiet logs for the file's tests, and the fixture torn down after each. */
export function useInstallHarness(): void {
	beforeEach(() => {
		spies = [
			spyOn(logger, "info").mockImplementation(() => logger),
			spyOn(logger, "warn").mockImplementation(() => logger),
			spyOn(logger, "error").mockImplementation(() => logger),
		];
	});
	afterEach(async () => {
		await teardownInstall();
		for (const spy of spies.splice(0)) spy.mockRestore();
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
	// A fake's answer once its wait is released; `failure` when it is released
	// as a failure (by default the call throws).
	const wait = async <T>(
		label: string,
		answer: () => T,
		failure: () => T = () => {
			throw new Error(`${label}: failed`);
		},
	): Promise<T> =>
		(await sequencer.gate(label)) === "fail" ? failure() : answer();
	const pinned = variant === "pinned";

	setImageAptSourceReaderForTest((file) => FILES[file] ?? null);
	setImageClockGateFlagForTest(flag);
	setDpkgUpdatesDirForTest(path.join(dir, "updates"));
	setCeraliveSourcesFileForTest(path.join(dir, "ceralive.sources"));
	setImageOwnedPackagesReaderForTest(
		() => wait("read the image's own package list", () => null),
		path.join(dir, "no-pin"),
	);
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
		// but the install (the orchestrator's own requests) reads the real one.
		spyOn(board, "hasCapability").mockImplementation((capability, deps) =>
			sequencer.isOutside()
				? hasBoardCapability(capability, deps)
				: wait(`read the board capability ${capability}`, () => pinned),
		),
		spyOn(defaultAptSpaceDeps, "run").mockImplementation((argv) =>
			wait(
				argv.includes("clean")
					? "space preflight: apt-get clean"
					: argv[0] === "/usr/bin/apt-config"
						? "space preflight: apt-config"
						: "space preflight: apt-get --print-uris",
				() =>
					argv.includes("clean")
						? ok()
						: argv[0] === "/usr/bin/apt-config"
							? ok("ARCHIVES='/cache/archives/';")
							: ok(
									"After this operation, 2 kB of additional disk space will be used.\n'https://updates.example.org/a.deb' a.deb 4000 SHA256:abc\n",
								),
				aptFailed,
			),
		),
		spyOn(defaultAptSpaceDeps, "stat").mockImplementation(() =>
			wait("space preflight: stat", () => ({ dev: 1n })),
		),
		spyOn(defaultAptSpaceDeps, "statfs").mockImplementation(() =>
			wait("space preflight: statfs", () => ({
				bavail: 10n ** 12n,
				bsize: 1n,
			})),
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
	setAptReachabilityProbeForTest(() =>
		wait<typeof OK_REACH | typeof UNREACHABLE>(
			"reachability probe",
			() => OK_REACH,
			() => UNREACHABLE,
		),
	);
	setAptCommandRunnerForTest((argv) =>
		wait(aptLabel(argv), () => aptAnswer(argv), aptFailed),
	);
	const unit = fakeUnit(sequencer);
	setDetachedAptServiceDepsForTest(unit.deps);
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
		// The routing journal and the `ip` runner of the pin, as waits too.
		let entries: readonly AptRoutingEntry[] = [];
		const ownership = createAptRoutingOwnership({
			read: () => wait("routing journal: read", () => entries),
			save: (next) => {
				entries = next;
			},
		});
		const pin = createUpdatePinController({
			readCapabilities: () =>
				wait(
					"pin: read the capability file",
					() =>
						updateCapabilityFileSchema.parse({
							schema: 1,
							features: ["apt-all-packages", "transport-uidrange"],
							apt_uid: 42042,
							ota_uid: 42041,
						}),
					() => undefined,
				),
			now: () => 1000,
			run: (_bin, args) =>
				wait(`ip ${args.slice(0, 3).join(" ")}`, () =>
					args.join(" ").endsWith("route show default")
						? "default dev eth0\ndefault dev wlan0"
						: "",
				),
		});
		await pin.sweep();
		setAptTransportDepsForTest({
			select: () =>
				wait("select the update transport", () =>
					rankTransports([sample("eth0", "ethernet", 4)]),
				),
			pin,
			ownership,
		});
	}

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
			packageFailedBeforeLaunch,
			stopPackageInstallUnit: async () => {
				abortAptTransferForStream();
				unit.stop();
			},
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
		/** A point in time to compare later calls and state against. */
		mark: () => ({ calls: sequencer.calls().length, seen: observe() }),
		/**
		 * The install's own calls since `mark`. The teardown of a routing rule
		 * it had installed is not a new effect and is left out.
		 */
		callsSince: (mark: { calls: number }) =>
			sequencer
				.calls()
				.slice(mark.calls)
				.filter(({ by, label }) => by === "flow" && !ROUTING_TEARDOWN(label))
				.map(({ label }) => label),
	};
	return box;
}

// Removing the rule and routes a pinned run had set up: `ip … del`, and the
// table flush that reads what is left to delete.
const ROUTING_TEARDOWN = (label: string) =>
	label.startsWith("ip ") && (/ del\b/.test(label) || / show\b/.test(label));

export type Accepted = Awaited<ReturnType<typeof acceptedInstall>>;
export type Mark = ReturnType<Accepted["mark"]>;

/**
 * Nothing stale happened since `mark`: the ended install started no call
 * (no apt run, no probe, no spool setup, no routing rule) and, unless
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
		} catch (error) {
			failures.push(
				`at wait ${step} of ${steps.length} ("${steps[step]}"): ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		await teardownInstall();
	}
	expect(failures).toEqual([]);
	return runs;
}
