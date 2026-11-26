/// <reference types="bun" />

/**
 * The launch fence of an install on an image with its own apt source, tested
 * as a class: at every wait between "the start was accepted" and "the unit was
 * submitted", something else happens (a stream is admitted, updates are turned
 * off, a second start arrives) and exactly one outcome is allowed.
 *
 * The waits are not listed here. Every fake waits on a sequencer gate; a first
 * run records the gates the real code passes, in order, and proves that the
 * install waits on nothing else (helpers/await-sequencer.ts). The other runs
 * replay the install up to each recorded wait in turn. A new wait in the code
 * is therefore either a new step with all three events run at it, or a failed
 * recording.
 *
 * Only in-process fakes: the unit, apt, the probes, the routing rules and the
 * delayed start's timer are all objects in this file.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { updateCapabilityFileSchema } from "@ceraui/rpc/schemas";
import { logger } from "../helpers/logger.ts";
import { setup } from "../modules/setup.ts";
import type { AptRoutingEntry } from "../modules/system/apt-routing-journal.ts";
import { createAptRoutingOwnership } from "../modules/system/apt-routing-ownership.ts";
import { defaultAptSpaceDeps } from "../modules/system/apt-space-admission.ts";
import { abortAptTransferForStream } from "../modules/system/apt-transfer-abort.ts";
import { setAptTransportDepsForTest } from "../modules/system/apt-transport.ts";
import * as board from "../modules/system/board-capabilities.ts";
import {
	IMAGE_APT_SOURCE_POLICY,
	setDpkgUpdatesDirForTest,
	setImageAptSourceReaderForTest,
	setImageClockGateFlagForTest,
} from "../modules/system/image-apt-source.ts";
import { setImageOwnedPackagesReaderForTest } from "../modules/system/image-owned-packages.ts";
import { softwareUpdateOutputPaths } from "../modules/system/software-update-output.ts";
import {
	type DetachedAptServiceDeps,
	setDetachedAptServiceDepsForTest,
} from "../modules/system/software-update-service.ts";
import {
	getUpdateState,
	packageFailedBeforeLaunch,
	resetAptReachabilityProbeForTest,
	resetSoftwareUpdateCheckRunner,
	resetSoftwareUpdateState,
	runSoftwareUpdateCheck,
	setAptCommandRunnerForTest,
	setAptReachabilityProbeForTest,
	setDelayedStartTimerForTest,
	startSoftwareUpdate,
	triggerManualUpdateCheck,
} from "../modules/system/software-updates.ts";
import { setStreamLivenessSourceForTest } from "../modules/system/stream-liveness-source.ts";
import { setCeraliveSourcesFileForTest } from "../modules/system/update-apt-channel.ts";
import * as capabilityFile from "../modules/system/update-capabilities.ts";
import {
	admitAndPrepareStreamStart,
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	initialOrchestratorState,
	PACKAGE_INSTALL_REFUSED,
} from "../modules/system/update-orchestrator/types.ts";
import { rankTransports } from "../modules/system/update-transport/core.ts";
import { createUpdatePinController } from "../modules/system/update-transport/pin.ts";
import { notificationRemove } from "../modules/ui/notifications.ts";
import * as compat from "../rpc/compat.ts";
import { sample } from "./helpers/apt-transport-fixture.ts";
import {
	type AwaitSequencer,
	createAwaitSequencer,
	settleEventLoop,
	settleMicrotasks,
} from "./helpers/await-sequencer.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import {
	fakeDeps,
	quarantineDirs,
	testQuarantine,
} from "./helpers/orchestrator-runtime-harness.ts";
import { armedMarkerFixture } from "./software-updates-marker-harness.ts";

useSessionOwnerForFile();

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
const PENDING = [{ name: "modemmanager", version: FIX }];
// The launcher's `systemd-run`: once it returned, the unit is submitted.
const SUBMIT = "unit: systemd-run";
const DELAY = "delayed start: timer";
// Each test replays the install once per wait: far more than one test's usual
// budget on a loaded machine.
const TIMEOUT_MS = 240_000;

/**
 * - `orchestrated`: Install now through the orchestrator, apt unbound.
 * - `pinned`: the same on an image that routes apt (the download runs under
 *   the pin before the unit exists).
 * - `standalone`: the start RPC, which the orchestrator never sees.
 * - `delayed`: Install now while another check runs, so the start waits.
 */
const VARIANTS = ["orchestrated", "pinned", "standalone", "delayed"] as const;
type Variant = (typeof VARIANTS)[number];
const EVENTS = ["stream admission", "updates off", "second start"] as const;
type Event = (typeof EVENTS)[number];

const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });

function aptLabel(argv: readonly string[]): string {
	if (argv[0] === "/usr/bin/apt-mark") return "apt-mark showhold";
	if (argv[0] === "/usr/bin/apt-cache")
		return argv.at(-1) === "policy"
			? "apt-cache policy"
			: "apt-cache policy <package>";
	if (argv[1] === "update" || argv.includes("update")) return "apt-get update";
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
		// Stopped, or the test is over: whatever looks finds it gone or finished.
		ended: null as "absent" | "finished" | null,
		wake: Promise.withResolvers<void>(),
	};
	const deps: DetachedAptServiceDeps = {
		outputPaths: softwareUpdateOutputPaths(),
		prepareOutput: () => sequencer.gate("unit: prepare its output files"),
		start: async () => {
			unit.submissions++;
			await sequencer.gate(SUBMIT);
			unit.state = "running";
		},
		inspect: async () => {
			await sequencer.gate("unit: systemctl show");
			if (unit.ended === "finished")
				return { kind: "finished", exitCode: 100, cleanup: "stop" };
			return { kind: unit.ended ?? unit.state };
		},
		cleanup: async () => {},
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
const cleanups: (() => void | Promise<void>)[] = [];
const updatesEnabled = setup.apt_update_enabled;
const hasBoardCapability = board.hasCapability;

beforeEach(() => {
	spies = [
		spyOn(logger, "info").mockImplementation(() => logger),
		spyOn(logger, "warn").mockImplementation(() => logger),
		spyOn(logger, "error").mockImplementation(() => logger),
	];
});

async function teardown() {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	setup.apt_update_enabled = updatesEnabled;
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
}

afterEach(async () => {
	await teardown();
	for (const spy of spies.splice(0)) spy.mockRestore();
});

/**
 * A box with the record and an offer of one emergency fix, the orchestrator
 * over the real package code, and an install just accepted: its first wait is
 * parked on the sequencer.
 */
async function acceptedInstall(variant: Variant) {
	const dir = await mkdtemp(path.join(tmpdir(), "image-apt-fence-"));
	scratch.push(dir);
	const flag = path.join(dir, "clock-gate-open");
	await writeFile(flag, "");
	const sequencer = createAwaitSequencer();
	const wait = async <T>(label: string, answer: () => T): Promise<T> => {
		await sequencer.gate(label);
		return answer();
	};
	const pinned = variant === "pinned";

	setImageAptSourceReaderForTest((file) => FILES[file] ?? null);
	setImageClockGateFlagForTest(flag);
	setDpkgUpdatesDirForTest(path.join(dir, "updates"));
	setCeraliveSourcesFileForTest(path.join(dir, "ceralive.sources"));
	setImageOwnedPackagesReaderForTest(
		() => wait("read the image's own package list", () => null),
		path.join(dir, "no-pin"),
	);
	const capabilities = {
		mode: "capable" as const,
		features: [
			"apt-all-packages",
			"rauc-verity-streaming",
			...(pinned ? ["transport-uidrange"] : []),
		],
	};
	const frames: { kind: string; reason?: string }[] = [];
	spies.push(
		spyOn(capabilityFile, "readUpdateCapabilities").mockImplementation(() =>
			wait("read the update capabilities", () => capabilities),
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
	);
	setAptReachabilityProbeForTest(() =>
		wait("reachability probe", () => OK_REACH),
	);
	setAptCommandRunnerForTest((argv) =>
		wait(aptLabel(argv), () => aptAnswer(argv)),
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
				wait("pin: read the capability file", () =>
					updateCapabilityFileSchema.parse({
						schema: 1,
						features: ["apt-all-packages", "transport-uidrange"],
						apt_uid: 42042,
						ota_uid: 42041,
					}),
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

	const counts = { osChecks: 0 };
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
			runPackageCheck: runSoftwareUpdateCheck,
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
	expect(await sequencer.outside(() => checkUpdatesNow())).toEqual({
		started: true,
	});
	expect(getOrchestratorState().phase).toBe("available");
	expect(getUpdateState().kind).toBe("available");
	frames.length = 0;

	if (variant === "standalone") {
		sequencer.arm();
		expect(startSoftwareUpdate()).toEqual({ started: true });
	} else {
		if (variant === "delayed") {
			// A dialog's own check is running when the install is asked for.
			sequencer.arm();
			expect(triggerManualUpdateCheck()).toBe(true);
		}
		expect(
			await sequencer.outside(() => installUpdatesNow({ scope: "packages" })),
		).toEqual({ started: true });
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(await quarantine.readPending()).toEqual(PENDING);
	}
	return { sequencer, unit, frames, counts, quarantine, flag };
}

type Accepted = Awaited<ReturnType<typeof acceptedInstall>>;

const failedFrames = (frames: Accepted["frames"]) =>
	frames.filter(
		({ kind }) => kind === "failed" || kind === "update_preflight_failed",
	);

/** The one outcome of an install that ended before its unit was submitted. */
async function expectEndedBeforeLaunch(
	variant: Variant,
	box: Accepted,
	reason: string,
	// Another check was running and has found the offer again since.
	superseded: boolean,
) {
	const { unit, frames, quarantine, counts } = box;
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
	if (variant === "standalone") {
		// The orchestrator never started this install: it keeps its offer.
		expect(getOrchestratorState().phase).toBe("available");
		expect(await quarantine.readPending()).toEqual([]);
	} else {
		expect(getOrchestratorState()).toMatchObject({
			phase: "failed",
			failureReason: PACKAGE_INSTALL_REFUSED,
		});
		// The pending package list stays until the next check clears it.
		expect(await quarantine.readPending()).toEqual(PENDING);
	}
	// The next check finds the offer again and an image check runs.
	box.sequencer.disarm();
	setup.apt_update_enabled = updatesEnabled;
	const os = counts.osChecks;
	expect(await box.sequencer.outside(() => checkUpdatesNow())).toEqual({
		started: true,
	});
	expect(getUpdateState().kind).toBe("available");
	expect(getOrchestratorState().phase).toBe("available");
	expect(await quarantine.readPending()).toEqual([]);
	expect(counts.osChecks).toBe(os + 1);
	expect(unit.unit.submissions).toBe(0);
}

/** The one outcome of an install whose unit was submitted, left alone. */
async function expectLaunched(variant: Variant, box: Accepted) {
	const { unit, frames, quarantine } = box;
	expect(unit.unit.submissions).toBe(1);
	expect(unit.unit.state).toBe("running");
	expect(failedFrames(frames)).toEqual([]);
	expect(getUpdateState().kind).toBe("downloading");
	if (variant === "standalone") return;
	expect(getOrchestratorState().phase).toBe("downloading");
	expect(await quarantine.readPending()).toEqual(PENDING);
}

async function run(
	variant: Variant,
	event: Event,
	step: number,
	steps: readonly string[],
) {
	await using _marker = await armedMarkerFixture();
	const box = await acceptedInstall(variant);
	const { sequencer, unit, quarantine } = box;
	await sequencer.advance(step);
	// The wait the install stands at now, and the event that happens there.
	expect(sequencer.next()).toBe(steps[step] as string);
	// At its last wait `systemd-run` is in flight: the unit is submitted.
	const submitting = steps[step] === SUBMIT;
	// The delayed start has not run yet: the other check is still in flight.
	const delayedAt = steps.indexOf(DELAY);
	const waiting = variant === "delayed" && step <= delayedAt;

	if (event === "stream admission") {
		// Admitted, and never seen live: only the fence can stop the launch.
		const admission = sequencer.outside(() => admitAndPrepareStreamStart());
		if (!submitting) {
			expect(await admission).toEqual({ allowed: true });
			// Refused at once, before the install resumes.
			expect(getUpdateState()).toMatchObject({
				kind: "failed",
				reason: "streaming",
			});
			if (variant !== "standalone")
				expect(getOrchestratorState()).toMatchObject({
					phase: "failed",
					failureReason: PACKAGE_INSTALL_REFUSED,
				});
			await sequencer.drain();
			await expectEndedBeforeLaunch(
				variant,
				box,
				"streaming",
				variant === "delayed" && step < delayedAt,
			);
			return;
		}
		// The submission is decided first; the stream then meets a launched unit.
		await settleMicrotasks();
		expect(getUpdateState().kind).toBe("downloading");
		expect(unit.unit.state).toBe("absent");
		sequencer.step();
		expect(await admission).toEqual({ allowed: true });
		expect(unit.unit.submissions).toBe(1);
		if (variant === "standalone") {
			// The orchestrator did not start it: the unit runs on, as today.
			expect(unit.unit.stops).toBe(0);
			expect(getUpdateState().kind).toBe("downloading");
			return;
		}
		// Today's path: the unit is stopped and the plan returns to the offer.
		expect(unit.unit.stops).toBe(1);
		expect(getOrchestratorState()).toMatchObject({
			phase: "available",
			failureReason: null,
		});
		expect(await quarantine.readPending()).toEqual(PENDING);
		return;
	}

	if (event === "updates off") {
		setup.apt_update_enabled = false;
		await sequencer.drain();
		if (submitting) {
			setup.apt_update_enabled = updatesEnabled;
			await expectLaunched(variant, box);
			return;
		}
		expect(getUpdateState()).toMatchObject({
			kind: "failed",
			reason: "discovery_failed",
		});
		// The orchestrator learns of it when it next looks.
		if (variant !== "standalone")
			await sequencer.outside(() => runOrchestratorTick());
		await expectEndedBeforeLaunch(variant, box, "discovery_failed", false);
		return;
	}

	// A second start, through the orchestrator and through the start RPC.
	const before = getOrchestratorState().phase;
	expect(
		await sequencer.outside(() => installUpdatesNow({ scope: "packages" })),
	).toEqual({ started: false, reason: "busy" });
	// Through the orchestrator it changes nothing; beside the start RPC's
	// install the request stays queued, as any request that cannot start yet.
	expect(getOrchestratorState().phase).toBe(
		variant === "standalone" ? "awaiting-idle" : before,
	);
	// While the start still waits behind the other check, a second start is
	// that same install; afterwards it is refused. Never a second install.
	expect(sequencer.outside(() => startSoftwareUpdate())).toEqual(
		waiting
			? { started: true }
			: { started: false, reason: "already_updating" },
	);
	await sequencer.drain();
	await expectLaunched(variant, box);
}

describe("the launch fence: every wait before the unit is submitted", () => {
	const recorded = new Map<Variant, string[]>();

	// The waits of each install, recorded from the real code.
	async function record(variant: Variant): Promise<string[]> {
		const known = recorded.get(variant);
		if (known) return known;
		await using _marker = await armedMarkerFixture();
		const box = await acceptedInstall(variant);
		const steps = await box.sequencer
			.record((label) => label === SUBMIT)
			.catch((error: unknown) => {
				throw new Error(
					`${error instanceof Error ? error.message : String(error)} (wire: ${JSON.stringify(getUpdateState())})`,
				);
			});
		await box.sequencer.drain();
		await expectLaunched(variant, box);
		await teardown();
		recorded.set(variant, steps);
		return steps;
	}

	it.each(VARIANTS)(
		"%s: the install waits only where a fake stands, and its last wait is systemd-run",
		async (variant) => {
			const steps = await record(variant);
			expect(steps.at(-1)).toBe(SUBMIT);
			expect(steps.filter((label) => label === SUBMIT)).toHaveLength(1);
			// Its own check, its preparation and the launcher are all in there.
			expect(steps).toContain("apt-get update");
			expect(steps).toContain("apt-get -s (discovery)");
			expect(steps).toContain("space preflight: apt-get clean");
			expect(steps).toContain("unit: systemctl show");
			expect(steps).toContain("unit: prepare its output files");
			if (variant === "pinned")
				expect(steps).toContain("apt-get -d (download under the pin)");
			if (variant === "delayed") expect(steps).toContain(DELAY);
		},
		TIMEOUT_MS,
	);

	describe.each(VARIANTS)("%s", (variant) => {
		it.each(EVENTS)(
			"%s at every wait",
			async (event) => {
				const steps = await record(variant);
				const outcomes: string[] = [];
				for (let step = 0; step < steps.length; step++) {
					try {
						await run(variant, event, step, steps);
					} catch (error) {
						outcomes.push(
							`at wait ${step} of ${steps.length} ("${steps[step]}"): ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					await teardown();
				}
				expect(outcomes).toEqual([]);
			},
			TIMEOUT_MS,
		);
	});
});
