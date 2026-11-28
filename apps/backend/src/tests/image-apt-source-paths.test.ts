/// <reference types="bun" />

/**
 * Every way an install on an image with its own apt source can end before its
 * unit launches, one test per row of the table in
 * docs/agents/the-device-update-system.md. Each drives the real package code
 * and the real orchestrator, and checks the wire, the orchestrator, and that
 * the next package check and an image check run.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UpdateState } from "@ceraui/rpc/schemas";
import { logger } from "../helpers/logger.ts";
import { SpawnTimeoutError } from "../helpers/spawn-policy.ts";
import * as events from "../modules/events/emit.ts";
import { setup } from "../modules/setup.ts";
import { defaultAptSpaceDeps } from "../modules/system/apt-space-admission.ts";
import { abortAptTransferForStream } from "../modules/system/apt-transfer-abort.ts";
import { setAptTransportDepsForTest } from "../modules/system/apt-transport.ts";
import {
	IMAGE_APT_SOURCE_POLICY,
	setDpkgUpdatesDirForTest,
	setImageAptSourceReaderForTest,
	setImageClockGateFlagForTest,
} from "../modules/system/image-apt-source.ts";
import { setImageOwnedPackagesReaderForTest } from "../modules/system/image-owned-packages.ts";
import { softwareUpdateOutputPaths } from "../modules/system/software-update-output.ts";
import * as transaction from "../modules/system/software-update-process.ts";
import {
	getUpdateState,
	packageFailedBeforeLaunch,
	resetAptReachabilityProbeForTest,
	resetSoftwareUpdateCheckRunner,
	resetSoftwareUpdateState,
	runSoftwareUpdateCheck,
	setAptCommandRunnerForTest,
	setAptReachabilityProbeForTest,
	startSoftwareUpdate,
	takePackageAttemptEnd,
	takePackageLaunchRefusal,
	triggerManualUpdateCheck,
} from "../modules/system/software-updates.ts";
import { setStreamLivenessSourceForTest } from "../modules/system/stream-liveness-source.ts";
import { setCeraliveSourcesFileForTest } from "../modules/system/update-apt-channel.ts";
import {
	setUpdateCapabilityPathForTest,
	UpdateCapabilityReadError,
} from "../modules/system/update-capabilities.ts";
import type { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
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
import { notificationRemove } from "../modules/ui/notifications.ts";
import * as compat from "../rpc/compat.ts";
import { pinFixture, sample } from "./helpers/apt-transport-fixture.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import {
	fakeDeps,
	quarantineDirs,
	testQuarantine,
} from "./helpers/orchestrator-runtime-harness.ts";
import { armedMarkerFixture } from "./software-updates-marker-harness.ts";

useSessionOwnerForFile();

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
const POLICY_MM = `modemmanager:
  Installed: ${OLD}
  Candidate: ${FIX}
  Version table:
     ${FIX} 990
        500 ${OUR_EMERGENCY}
 *** ${OLD} 100
        500 ${OUR_MAIN}
        100 /var/lib/dpkg/status
`;
const POLICY_ZSTD = `zstd:
  Installed: 1.5.6+dfsg-2
  Candidate: 1.5.7+dfsg-1
  Version table:
     1.5.7+dfsg-1 500
        500 https://deb.debian.org/debian trixie/main arm64 Packages
 *** 1.5.6+dfsg-2 100
        100 /var/lib/dpkg/status
`;
const plan = (rows: string) =>
	`Reading package lists...\nBuilding dependency tree...\nReading state information...\nCalculating upgrade...\n1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n${rows}`;
const OFFER = plan(
	`Inst modemmanager [${OLD}] (${FIX} OpenStreamBox:${EMERGENCY} [arm64])\nConf modemmanager (${FIX} OpenStreamBox:${EMERGENCY} [arm64])\n`,
);
const NOTHING_ACTIONABLE = plan(
	"Inst zstd [1.5.6+dfsg-2] (1.5.7+dfsg-1 Debian:13.7/stable [arm64])\nConf zstd (1.5.7+dfsg-1 Debian:13.7/stable [arm64])\n",
);
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

type Path =
	| "none"
	| "install-refresh"
	| "install-reachability"
	| "simulation"
	| "hold"
	| "policy"
	| "nothing-actionable"
	| "pinned-recheck"
	| "pinned-removals"
	| "space-preflight"
	| "download"
	| "download-liveness"
	| "download-admission"
	| "preflight-admission"
	| "start-rejected"
	| "launcher-setup"
	| "launcher-probe-timeout"
	| "launcher-pinned"
	| "unit-refused"
	| "throw"
	| "launched"
	| "launched-running";

const launcher = transaction.runDetachedAptAll;
const scratch: string[] = [];
let launchCount = 0;
const launches = () => launchCount;
let unitRunning = Promise.withResolvers<number>();
const stops = { count: 0 };
let spies: ReturnType<typeof spyOn>[] = [];
beforeEach(() => {
	spies = [
		spyOn(logger, "info").mockImplementation(() => logger),
		spyOn(logger, "warn").mockImplementation(() => logger),
		spyOn(logger, "error").mockImplementation(() => logger),
	];
});
afterEach(async () => {
	unitRunning.resolve(100);
	await Bun.sleep(10);
	unitRunning = Promise.withResolvers<number>();
	launchCount = 0;
	stops.count = 0;
	for (const spy of spies.splice(0)) spy.mockRestore();
	resetOrchestratorRuntimeForTest();
	setImageAptSourceReaderForTest(null);
	setImageClockGateFlagForTest(null);
	setDpkgUpdatesDirForTest(null);
	setImageOwnedPackagesReaderForTest(null);
	setUpdateCapabilityPathForTest(null);
	setCeraliveSourcesFileForTest(null);
	setAptCommandRunnerForTest(null);
	setAptTransportDepsForTest(null);
	setStreamLivenessSourceForTest(null);
	resetAptReachabilityProbeForTest();
	resetSoftwareUpdateCheckRunner();
	resetSoftwareUpdateState();
	notificationRemove("ceralive_update_failed");
	for (const dir of quarantineDirs.splice(0))
		await rm(dir, { recursive: true, force: true });
	for (const dir of scratch.splice(0))
		await rm(dir, { recursive: true, force: true });
});

// A box with the record and an offer of one emergency fix. `failing` fails
// once, during the install; every later check finds the offer again.
async function box(failing: Path) {
	const dir = await mkdtemp(path.join(tmpdir(), "image-apt-paths-"));
	scratch.push(dir);
	const pinned = failing.startsWith("download");
	await writeFile(
		path.join(dir, "capabilities.json"),
		JSON.stringify({
			schema: 1,
			features: [
				"apt-all-packages",
				"rauc-verity-streaming",
				...(pinned ? ["transport-uidrange"] : []),
			],
			ota_uid: 42041,
			apt_uid: 42042,
		}),
	);
	const flag = path.join(dir, "clock-gate-open");
	await writeFile(flag, "");
	setImageAptSourceReaderForTest((file) => FILES[file] ?? null);
	setImageClockGateFlagForTest(flag);
	setDpkgUpdatesDirForTest(path.join(dir, "updates"));
	setUpdateCapabilityPathForTest(path.join(dir, "capabilities.json"));
	setCeraliveSourcesFileForTest(path.join(dir, "ceralive.sources"));
	setImageOwnedPackagesReaderForTest(null, path.join(dir, "no-pin"));

	const seen = { refresh: 0, simulation: 0, probes: 0, holds: 0 };
	// The first check: refresh (1), simulation (1). The install's own check:
	// refresh (2), then preparation's discovery: simulation (2).
	const installing = () => seen.simulation === 2 || seen.holds === 2;
	setAptReachabilityProbeForTest(async () => {
		seen.probes++;
		// Probes: the check (1, 2), the install's own check (3), preparation (4).
		if (failing === "install-refresh" && seen.probes === 3) return UNREACHABLE;
		if (failing === "install-reachability" && seen.probes === 4)
			return UNREACHABLE;
		if (failing === "throw" && seen.probes === 4)
			throw new Error("probe crashed");
		return OK_REACH;
	});
	const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
	const once = { pinned: true, download: true };
	const downloading = Promise.withResolvers<void>();
	const downloadGate = Promise.withResolvers<void>();
	setAptCommandRunnerForTest(async (argv) => {
		if (argv[1] === "update") {
			seen.refresh++;
			return ok(REFRESH);
		}
		if (argv[0] === "/usr/bin/apt-mark") {
			seen.holds++;
			return failing === "hold" && seen.holds === 2
				? { exitCode: 1, stdout: "", stderr: "E: hold query failed" }
				: ok("");
		}
		if (argv[0] === "/usr/bin/apt-cache") {
			const name = argv[argv.indexOf("policy") + 1];
			if (name === undefined) return ok(INVENTORY);
			if (failing === "policy" && installing())
				return { exitCode: 100, stdout: "", stderr: "E: policy failed" };
			return ok(name === "zstd" ? POLICY_ZSTD : POLICY_MM);
		}
		if (argv.includes("-s") && argv.includes("install")) {
			// A stream goes live just before the download; nothing admits it.
			if (failing === "download-liveness")
				setStreamLivenessSourceForTest(() => "streaming");
			if (failing === "pinned-recheck" && once.pinned) {
				once.pinned = false;
				return {
					exitCode: 100,
					stdout: "",
					stderr: "E: pinned recheck failed",
				};
			}
			// The plan has come to need a removal since it was offered.
			if (failing === "pinned-removals" && once.pinned) {
				once.pinned = false;
				return ok(`${OFFER}Remv libqmi-glib5 [1.36.0-1]\n`);
			}
			return ok(OFFER);
		}
		if (argv.includes("-s")) {
			seen.simulation++;
			if (failing === "simulation" && seen.simulation === 2)
				return { exitCode: 100, stdout: "", stderr: "E: simulation failed" };
			return ok(
				failing === "nothing-actionable" && seen.simulation === 2
					? NOTHING_ACTIONABLE
					: OFFER,
			);
		}
		if (argv.includes("-d") && failing === "download-admission") {
			downloading.resolve();
			await downloadGate.promise;
			return ok("");
		}
		if (argv.includes("-d") && once.download && failing === "download") {
			once.download = false;
			return {
				exitCode: 100,
				stdout: "",
				stderr: `E: Failed to fetch ${URI}/pool/main/m/modemmanager.deb  Connection timed out\n`,
			};
		}
		return ok("");
	});

	let cleaned = false;
	spies.push(
		spyOn(defaultAptSpaceDeps, "run").mockImplementation(async (argv) => {
			if (argv.includes("clean")) {
				if (failing === "preflight-admission" && !cleaned) {
					cleaned = true;
					downloading.resolve();
					await downloadGate.promise;
					return { exitCode: 0, stdout: "", stderr: "" };
				}
				const fail = failing === "space-preflight" && !cleaned;
				cleaned = true;
				return { exitCode: fail ? 100 : 0, stdout: "", stderr: "" };
			}
			return argv[0] === "/usr/bin/apt-config"
				? ok("ARCHIVES='/cache/archives/';")
				: ok(
						"After this operation, 2 kB of additional disk space will be used.\n'https://updates.example.org/a.deb' a.deb 4000 SHA256:abc\n",
					);
		}),
		spyOn(defaultAptSpaceDeps, "stat").mockImplementation(async () => ({
			dev: 1n,
		})),
		spyOn(defaultAptSpaceDeps, "statfs").mockImplementation(async () => ({
			bavail: 10n ** 12n,
			bsize: 1n,
		})),
		spyOn(transaction, "runDetachedAptAll").mockImplementation(
			async (args, verdict, handlers) => {
				// These paths run the real launcher over a unit of this file.
				if (
					failing === "launcher-setup" ||
					failing === "unit-refused" ||
					failing === "launcher-probe-timeout" ||
					failing === "launcher-pinned"
				)
					return launcher(args, verdict, handlers, {
						outputPaths: softwareUpdateOutputPaths(),
						// The unit-name probe before the submission: it times out,
						// or it finds the last install's stopped unit still loaded.
						inspect: async () => {
							if (failing === "launcher-probe-timeout")
								throw new SpawnTimeoutError("systemctl show");
							return failing === "launcher-pinned"
								? { kind: "absent", loaded: true }
								: { kind: "absent" };
						},
						prepareOutput: async () => {
							if (failing !== "launcher-setup") return;
							downloading.resolve();
							await downloadGate.promise;
						},
						start: async () => {
							launchCount++;
							throw new Error("systemd-run: unit refused");
						},
						cleanup: async () => {},
						readOutput: async (_file, offset) => ({
							bytes: new Uint8Array(),
							nextOffset: offset,
						}),
						sleep: async () => {},
					});
				// The launcher submits its unit through the handlers (the launch
				// fence on these images); only then is the unit launched.
				await (handlers.submit ?? ((launch) => launch()))(async () => {
					launchCount++;
					if (failing === "start-rejected")
						throw new Error("systemd-run: unit refused");
				});
				handlers.onLaunched?.();
				// The unit keeps running until the test ends.
				if (failing === "launched-running") return unitRunning.promise;
				handlers.onStderr(
					"E: Sub-process /usr/bin/dpkg returned an error code (1)\n",
				);
				return 100;
			},
		),
	);
	if (pinned) {
		const { pin, ownership } = await pinFixture();
		setAptTransportDepsForTest({
			select: async () => rankTransports([sample("eth0", "ethernet", 4)]),
			pin,
			ownership,
		});
	}
	return { flag, downloading, downloadGate, seen };
}

// The orchestrator over the real package code, counting image checks.
function orchestrator(
	options: {
		readonly allowPackagesOverCellular?: boolean;
		readonly onlyMetered?: () => boolean | Promise<boolean>;
		readonly streamLive?: () => boolean;
		/** Runs when the orchestrator reads the capabilities (it may throw). */
		readonly onCapabilityRead?: () => void;
		/** Start installs as the default runtime does: with a launch ticket. */
		readonly ticketed?: boolean;
		/** The up-front proof that the install unit's name is free. */
		readonly installUnitFree?: () => Promise<boolean>;
		/** Whether the schedule's idle window is open (a tick waits on it). */
		readonly isIdle?: () => Promise<boolean>;
		/** Starts refused as busy before the real start runs. */
		readonly busyStarts?: () => number;
	} = {},
) {
	const counts = { osChecks: 0, pendingCleared: 0 };
	const quarantine = testQuarantine();
	const clear = quarantine.clearPending.bind(quarantine);
	quarantine.clearPending = async () => {
		counts.pendingCleared++;
		return clear();
	};
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			quarantine,
			loadCapabilities: async () => {
				options.onCapabilityRead?.();
				return {
					mode: "capable",
					features: ["apt-all-packages", "rauc-verity-streaming"],
				};
			},
			loadSettings: async () => ({
				packagesAuto: true,
				systemAuto: true,
				schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
				channel: "stable",
				allowPackagesOverCellular: options.allowPackagesOverCellular ?? true,
				allowSystemOverCellular: true,
			}),
			onlyMeteredCandidateExists: async () => options.onlyMetered?.() ?? false,
			isStreamLive: () => options.streamLive?.() ?? false,
			runPackageCheck: runSoftwareUpdateCheck,
			startPackageInstall: (ticket) => {
				if ((options.busyStarts?.() ?? 0) > 0)
					return { started: false, reason: "already_updating" };
				return options.ticketed
					? startSoftwareUpdate(undefined, ticket)
					: startSoftwareUpdate();
			},
			...(options.isIdle ? { isIdle: options.isIdle } : {}),
			takePackageLaunchRefusal,
			...(options.installUnitFree
				? { installUnitFree: options.installUnitFree }
				: {}),
			getPackageInstallWireState: getUpdateState,
			takePackageAttemptEnd,
			stopPackageInstallUnit: async () => {
				stops.count++;
				abortAptTransferForStream();
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
	return { counts, quarantine };
}

const settle = async (done: () => boolean) => {
	for (let i = 0; i < 400 && !done(); i++) await Bun.sleep(5);
	await Bun.sleep(20);
};

// Check, find the offer, ask to install, and let the attempt end.
async function attempt(during?: () => void | Promise<void>, tick = true) {
	expect(await checkUpdatesNow()).toEqual({ started: true });
	expect(getOrchestratorState().phase).toBe("available");
	expect(getUpdateState().kind).toBe("available");
	expect(await installUpdatesNow({ scope: "packages" })).toEqual({
		started: true,
	});
	expect(getOrchestratorState().phase).toBe("downloading");
	await during?.();
	await settle(() => {
		const kind = getUpdateState().kind;
		return (
			kind !== "checking" && kind !== "downloading" && kind !== "installing"
		);
	});
	// A refusal admission already recorded needs no poll (a tick would run the
	// due package check straight away).
	if (tick) await runOrchestratorTick();
}

// The refused install: `failed` on the wire and in the orchestrator, then the
// next check rediscovers the offer and the image check runs.
async function expectRefused(
	counts: { osChecks: number; pendingCleared: number },
	wire: Partial<UpdateState>,
	retry?: UpdateQuarantine,
) {
	expect(getUpdateState()).toMatchObject({ kind: "failed", ...wire });
	expect(JSON.stringify(getUpdateState())).not.toContain(TOKEN);
	expect(getOrchestratorState()).toMatchObject({
		phase: "failed",
		failureReason: PACKAGE_INSTALL_REFUSED,
	});
	const os = counts.osChecks;
	const cleared = counts.pendingCleared;
	expect(await checkUpdatesNow()).toEqual({ started: true });
	expect(counts.pendingCleared).toBeGreaterThan(cleared);
	expect(getUpdateState().kind).toBe("available");
	expect(getOrchestratorState().phase).toBe("available");
	expect(counts.osChecks).toBe(os + 1);
	if (retry) {
		// The retry records its pending package versions as any install does.
		expect(await installUpdatesNow({ scope: "packages" })).toEqual({
			started: true,
		});
		expect(await retry.readPending()).toEqual([
			{ name: "modemmanager", version: FIX },
		]);
		await settle(() => getUpdateState().kind === "failed");
	}
}

describe("each way an install ends before its unit launches", () => {
	it("the install's own check is refused (repository unreachable)", async () => {
		await box("install-refresh");
		const { counts } = orchestrator();
		// Every frame that says `failed`: one, with the cleared progress in it.
		const terminal: unknown[] = [];
		let watching = false;
		spies.push(
			spyOn(compat, "broadcastMsg").mockImplementation((type, data) => {
				const frame = data as {
					updating?: unknown;
					update_state?: { kind?: string; reason?: string };
				};
				if (
					watching &&
					type === "status" &&
					frame.update_state?.kind === "failed"
				)
					terminal.push({
						updating: "updating" in frame ? frame.updating : "not in the frame",
						reason: frame.update_state.reason,
					});
			}),
		);
		await attempt(() => {
			watching = true;
		});
		expect(terminal).toEqual([{ updating: null, reason: "repos_unreachable" }]);
		// The refresh's own classification, not a generic reason.
		await expectRefused(counts, { reason: "repos_unreachable" });
	});

	it("the record stops validating", async () => {
		await box("none");
		const { counts } = orchestrator();
		await attempt(() =>
			setImageAptSourceReaderForTest((file) =>
				file === IMAGE_APT_SOURCE_POLICY ? "{}" : null,
			),
		);
		expect(getUpdateState()).toMatchObject({
			kind: "failed",
			reason: "discovery_failed",
		});
		expect(getOrchestratorState()).toMatchObject({
			phase: "failed",
			failureReason: PACKAGE_INSTALL_REFUSED,
		});
		// Once the record validates again, the next check finds the offer.
		setImageAptSourceReaderForTest((file) => FILES[file] ?? null);
		await expectRefused(counts, { reason: "discovery_failed" });
	});

	it("the clock gate closes before preparation", async () => {
		const { flag } = await box("none");
		const { counts } = orchestrator();
		await attempt(() => setImageClockGateFlagForTest(`${flag}.gone`));
		setImageClockGateFlagForTest(flag);
		await expectRefused(counts, { reason: "check_unavailable" });
	});

	it("the install-time discovery simulation fails", async () => {
		await box("simulation");
		const { counts } = orchestrator();
		// Every status frame once the install is asked for.
		const kinds: string[] = [];
		let watching = false;
		spies.push(
			spyOn(compat, "broadcastMsg").mockImplementation((type, data) => {
				const kind = (data as { update_state?: { kind?: string } }).update_state
					?.kind;
				if (watching && type === "status" && kind) kinds.push(kind);
			}),
		);
		await attempt(() => {
			watching = true;
		});
		// `failed` is published without the standing offer showing first.
		expect(kinds).toContain("failed");
		expect(kinds.slice(0, kinds.indexOf("failed"))).not.toContain("available");
		await expectRefused(counts, { reason: "discovery_failed" });
	});

	it("the install-time hold query fails", async () => {
		await box("hold");
		const { counts } = orchestrator();
		await attempt();
		await expectRefused(counts, { reason: "discovery_failed" });
	});

	it("an install-time package policy read fails", async () => {
		await box("policy");
		const { counts } = orchestrator();
		await attempt();
		await expectRefused(counts, { reason: "discovery_failed" });
	});

	it("the install's network is unreachable", async () => {
		const { seen } = await box("install-reachability");
		const { counts } = orchestrator();
		await attempt();
		// Refused on the probe's verdict, before any install-time simulation:
		// the only one that ran is the first check's.
		expect(seen.simulation).toBe(1);
		expect(seen.holds).toBe(1);
		await expectRefused(counts, { reason: "repos_unreachable" });
	});

	it("nothing is installable any more", async () => {
		await box("nothing-actionable");
		const { counts } = orchestrator();
		await attempt();
		await expectRefused(counts, {
			reason: "No actionable application packages are available.",
		});
	});

	it("the pinned recheck refuses", async () => {
		await box("pinned-recheck");
		const { counts } = orchestrator();
		await attempt();
		await expectRefused(counts, { reason: "discovery_failed" });
	});

	it("the space preflight (its archive cleanup) refuses", async () => {
		await box("space-preflight");
		const { counts } = orchestrator();
		await attempt();
		expect(getUpdateState()).toMatchObject({
			kind: "update_preflight_failed",
			preflight_reason: "pre_clean_failed",
		});
		expect(getOrchestratorState()).toMatchObject({
			phase: "failed",
			failureReason: PACKAGE_INSTALL_REFUSED,
		});
		const os = counts.osChecks;
		expect(await checkUpdatesNow()).toEqual({ started: true });
		expect(getUpdateState().kind).toBe("available");
		expect(counts.osChecks).toBe(os + 1);
	});

	it("the download under the pin fails", async () => {
		await box("download");
		const { counts } = orchestrator();
		// The pinned transport serves the install's transfers (a real board's).
		const previous = process.env.CERALIVE_DEVICE_TYPE;
		const restore = () => {
			if (previous === undefined) delete process.env.CERALIVE_DEVICE_TYPE;
			else process.env.CERALIVE_DEVICE_TYPE = previous;
		};
		try {
			await attempt(async () => {
				process.env.CERALIVE_DEVICE_TYPE = "real";
				await settle(() => getUpdateState().kind === "failed");
				restore();
			});
		} finally {
			restore();
		}
		const state = getUpdateState();
		expect(state.kind).toBe("failed");
		expect(state.kind === "failed" ? state.reason : "").toContain(
			`https://${HOST}/pool/main`,
		);
		await expectRefused(counts, {});
	});

	it("a stream starts before launch", async () => {
		await box("none");
		const { counts } = orchestrator();
		await attempt(() => setStreamLivenessSourceForTest(() => "streaming"));
		setStreamLivenessSourceForTest(null);
		await expectRefused(counts, { reason: "streaming" });
	});

	it("stream admission during the pre-launch download refuses the install", async () => {
		const fixture = await box("download-admission");
		const { counts, quarantine } = orchestrator();
		const previous = process.env.CERALIVE_DEVICE_TYPE;
		const restore = () => {
			if (previous === undefined) delete process.env.CERALIVE_DEVICE_TYPE;
			else process.env.CERALIVE_DEVICE_TYPE = previous;
		};
		try {
			await attempt(async () => {
				process.env.CERALIVE_DEVICE_TYPE = "real";
				await fixture.downloading.promise;
				restore();
				setStreamLivenessSourceForTest(() => "streaming");
				await admitAndPrepareStreamStart();
				// Refused at once, never back to the offer.
				expect(getOrchestratorState()).toMatchObject({
					phase: "failed",
					failureReason: PACKAGE_INSTALL_REFUSED,
				});
				fixture.downloadGate.resolve();
			}, false);
		} finally {
			restore();
		}
		setStreamLivenessSourceForTest(null);
		await expectRefused(counts, { reason: "streaming" }, quarantine);
	});

	it("a stream admitted and over while preparation waits still cancels it", async () => {
		const fixture = await box("preflight-admission");
		const { counts, quarantine } = orchestrator();
		await attempt(async () => {
			await fixture.downloading.promise;
			setStreamLivenessSourceForTest(() => "streaming");
			await admitAndPrepareStreamStart();
			// The stream is over before preparation resumes.
			setStreamLivenessSourceForTest(null);
			fixture.downloadGate.resolve();
		}, false);
		await settle(() => false);
		// The install was cancelled: its unit never launched.
		expect(launches()).toBe(0);
		await expectRefused(counts, { reason: "streaming" }, quarantine);
	});

	it("the pinned download aborts on a live stream nobody admitted", async () => {
		await box("download-liveness");
		const { counts, quarantine } = orchestrator();
		const previous = process.env.CERALIVE_DEVICE_TYPE;
		const restore = () => {
			if (previous === undefined) delete process.env.CERALIVE_DEVICE_TYPE;
			else process.env.CERALIVE_DEVICE_TYPE = previous;
		};
		try {
			await attempt(async () => {
				process.env.CERALIVE_DEVICE_TYPE = "real";
				await settle(() => getUpdateState().kind === "failed");
				restore();
			});
		} finally {
			restore();
		}
		setStreamLivenessSourceForTest(null);
		// Not stranded in `downloading`: Check now runs at once.
		await expectRefused(counts, { reason: "streaming" }, quarantine);
	});

	it("stream admission after the wire already settled the refusal", async () => {
		await box("simulation");
		const { counts, quarantine } = orchestrator();
		expect(await checkUpdatesNow()).toEqual({ started: true });
		expect(await installUpdatesNow({ scope: "packages" })).toEqual({
			started: true,
		});
		await settle(() => getUpdateState().kind === "failed");
		// The orchestrator has not polled yet when a stream is admitted.
		expect(getOrchestratorState().phase).toBe("downloading");
		setStreamLivenessSourceForTest(() => "streaming");
		await admitAndPrepareStreamStart();
		setStreamLivenessSourceForTest(null);
		// Settled as the refusal it is, not restored to the offer.
		await expectRefused(counts, { reason: "discovery_failed" }, quarantine);
	});

	it("the pinned recheck would remove a package", async () => {
		await box("pinned-removals");
		const { counts } = orchestrator();
		await attempt();
		await expectRefused(counts, { reason: "removals_required" });
	});

	it("stream admission while the launcher sets up its unit", async () => {
		await using _marker = await armedMarkerFixture();
		const fixture = await box("launcher-setup");
		const { counts, quarantine } = orchestrator();
		await attempt(async () => {
			// The launcher looked for a unit and is preparing its output files.
			await fixture.downloading.promise;
			// Admitted, and never seen live: only the launch fence stops it.
			expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
			expect(getOrchestratorState()).toMatchObject({
				phase: "failed",
				failureReason: PACKAGE_INSTALL_REFUSED,
			});
			// No unit was submitted, so none is stopped.
			expect(stops.count).toBe(0);
			fixture.downloadGate.resolve();
		}, false);
		await Bun.sleep(50);
		// The launcher went on and submitted nothing.
		expect(launches()).toBe(0);
		await expectRefused(counts, { reason: "streaming" }, quarantine);
	});

	it("the start RPC as the Packages card calls it: a stream ends it, and the next check reconciles", async () => {
		const fixture = await box("preflight-admission");
		const { quarantine } = orchestrator();
		// The card's own check finds the offer; the orchestrator takes no part.
		expect(triggerManualUpdateCheck()).toBe(true);
		await settle(() => getUpdateState().kind === "available");
		expect(getOrchestratorState().phase).toBe("idle");
		// With the orchestrator not holding the offer, the card installs through
		// the start RPC: an install the orchestrator does not start.
		expect(startSoftwareUpdate()).toEqual({ started: true });
		await fixture.downloading.promise;
		expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
		expect(getUpdateState()).toMatchObject({
			kind: "failed",
			reason: "streaming",
		});
		fixture.downloadGate.resolve();
		await Bun.sleep(50);
		// Its preparation resumed and launched nothing.
		expect(launches()).toBe(0);
		// The wire says `failed`; the orchestrator recorded nothing and is idle
		// still. The two disagree until the next package check.
		expect(getUpdateState()).toMatchObject({
			kind: "failed",
			reason: "streaming",
		});
		expect(getOrchestratorState()).toMatchObject({
			phase: "idle",
			failureReason: null,
		});
		expect(await quarantine.readPending()).toEqual([]);
		// That check, here the scheduled one, brings them back in line.
		await runOrchestratorTick();
		expect(getUpdateState().kind).toBe("available");
		expect(getOrchestratorState().phase).toBe("available");
	});

	it("the start RPC beside an offer the orchestrator holds: Check now reconciles, and a due image check is not held up", async () => {
		const fixture = await box("preflight-admission");
		// Packages may not use cellular, system images may; only cellular is up.
		let metered = false;
		const { counts, quarantine } = orchestrator({
			allowPackagesOverCellular: false,
			onlyMetered: () => metered,
		});
		expect(await checkUpdatesNow()).toEqual({ started: true });
		expect(getOrchestratorState().phase).toBe("available");
		// Not the orchestrator's install: the start RPC, from any client.
		expect(startSoftwareUpdate()).toEqual({ started: true });
		await fixture.downloading.promise;
		expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
		fixture.downloadGate.resolve();
		await Bun.sleep(50);
		expect(launches()).toBe(0);
		// The wire says `failed` beside the offer the orchestrator still holds.
		const refused = { kind: "failed", reason: "streaming" };
		expect(getUpdateState()).toMatchObject(refused);
		expect(getOrchestratorState().phase).toBe("available");
		expect(await quarantine.readPending()).toEqual([]);
		// The scheduled tick does not check packages for it. The image check
		// that is due runs on schedule, on cellular too, and the offer stays.
		metered = true;
		const os = counts.osChecks;
		setOrchestratorStateForTest({
			...getOrchestratorState(),
			osCheck: { ...getOrchestratorState().osCheck, nextAttemptAt: 0 },
		});
		await runOrchestratorTick();
		expect(counts.osChecks).toBe(os + 1);
		expect(getOrchestratorState().phase).toBe("available");
		expect(getUpdateState()).toMatchObject(refused);
		// The user's Check now is the check that brings the two back in line.
		metered = false;
		expect(await checkUpdatesNow()).toEqual({ started: true });
		expect(getUpdateState().kind).toBe("available");
		expect(getOrchestratorState().phase).toBe("available");
	});

	it("the start RPC's launched unit is stopped by a stream like any other", async () => {
		await using _marker = await armedMarkerFixture();
		await box("launched-running");
		orchestrator();
		// The card's own check finds the offer; the orchestrator stays idle.
		expect(triggerManualUpdateCheck()).toBe(true);
		await settle(() => getUpdateState().kind === "available");
		expect(startSoftwareUpdate()).toEqual({ started: true });
		await settle(() => launches() === 1);
		expect(getUpdateState().kind).toBe("downloading");
		expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
		// Stopped behind the same fresh read and commit-stage probe; there is
		// no plan of the orchestrator's to return to an offer.
		expect(stops.count).toBe(1);
		expect(getOrchestratorState().phase).toBe("idle");
	});

	it("stream admission after systemd refused the unit, before the orchestrator looked", async () => {
		await using _marker = await armedMarkerFixture();
		await box("unit-refused");
		const { counts, quarantine } = orchestrator();
		const failed: unknown[] = [];
		spies.push(
			spyOn(events, "emitEvent").mockImplementation((code, params) => {
				if (code === "update_failed") failed.push(params);
			}),
		);
		expect(await checkUpdatesNow()).toEqual({ started: true });
		expect(await installUpdatesNow({ scope: "packages" })).toEqual({
			started: true,
		});
		await settle(() => getUpdateState().kind === "failed");
		const wire = getUpdateState();
		expect(wire).toMatchObject({
			kind: "failed",
			reason: "systemd-run: unit refused",
		});
		expect(launches()).toBe(1);
		// The orchestrator has not polled yet when a stream is admitted.
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
		// Settled as the refusal it is: no unit to stop, never the offer.
		expect(stops.count).toBe(0);
		expect(getOrchestratorState()).toMatchObject({
			phase: "failed",
			failureReason: PACKAGE_INSTALL_REFUSED,
		});
		// The failure keeps the id the wire gave it.
		const id = wire.kind === "failed" ? wire.failure_id : undefined;
		expect(id).toBeString();
		expect(failed).toEqual([
			{ stage: "download", reason: PACKAGE_INSTALL_REFUSED, id },
		]);
		await expectRefused(
			counts,
			{ reason: "systemd-run: unit refused" },
			quarantine,
		);
	});

	it("stream admission after the download under the pin failed keeps the failure's id", async () => {
		await box("download");
		const { counts } = orchestrator();
		const failed: unknown[] = [];
		spies.push(
			spyOn(events, "emitEvent").mockImplementation((code, params) => {
				if (code === "update_failed") failed.push(params);
			}),
		);
		const previous = process.env.CERALIVE_DEVICE_TYPE;
		const restore = () => {
			if (previous === undefined) delete process.env.CERALIVE_DEVICE_TYPE;
			else process.env.CERALIVE_DEVICE_TYPE = previous;
		};
		try {
			await attempt(async () => {
				process.env.CERALIVE_DEVICE_TYPE = "real";
				await settle(() => getUpdateState().kind === "failed");
				restore();
			}, false);
		} finally {
			restore();
		}
		const wire = getUpdateState();
		const id = wire.kind === "failed" ? wire.failure_id : undefined;
		expect(id).toBeString();
		// The orchestrator has not polled yet when a stream is admitted.
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
		expect(failed).toEqual([
			{ stage: "download", reason: PACKAGE_INSTALL_REFUSED, id },
		]);
		await expectRefused(counts, {});
	});

	it("systemd refuses the unit outright", async () => {
		await using _marker = await armedMarkerFixture();
		await box("start-rejected");
		const { counts } = orchestrator();
		await attempt();
		await expectRefused(counts, { reason: "systemd-run: unit refused" });
	});

	it("updates are turned off once the install started", async () => {
		await box("none");
		const { counts } = orchestrator();
		const previous = setup.apt_update_enabled;
		try {
			await attempt(() => {
				setup.apt_update_enabled = false;
			});
		} finally {
			setup.apt_update_enabled = previous;
		}
		await expectRefused(counts, { reason: "discovery_failed" });
	});

	it.each(["launcher-probe-timeout", "launcher-pinned"] as const)(
		"the launcher refuses before systemd-run (%s): the image's own end, never a requeue",
		async (path) => {
			// Given an install the orchestrator starts with a launch ticket, as
			// the default runtime does.
			await box(path);
			const { counts } = orchestrator({ ticketed: true });
			// When its unit-name probe refuses the launch before systemd-run.
			await attempt();
			// Then nothing was submitted, and the image keeps its own end for it
			// (`failed`, PACKAGE_INSTALL_REFUSED), not a queued retry: installs
			// on this image start only on request.
			expect(launches()).toBe(0);
			expect(getUpdateState()).not.toHaveProperty("retryable");
			await expectRefused(counts, {});
			// And the next check's offer is not installed on its own.
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("available");
			expect(launches()).toBe(0);
		},
	);

	it("a manual install the up-front unit proof refuses uses up its request: no tick installs on its behalf", async () => {
		// Given an install unit name that is not free yet.
		await box("launched-running");
		let free = false;
		orchestrator({ ticketed: true, installUnitFree: async () => free });
		expect(await checkUpdatesNow()).toEqual({ started: true });
		expect(getOrchestratorState().phase).toBe("available");
		// When the owner installs, the proof refuses it before any launch.
		expect(await installUpdatesNow({ scope: "packages" })).toEqual({
			started: false,
			reason: "not_available",
		});
		expect(launches()).toBe(0);
		// Then the request is used up: once the name is free, no idle tick
		// installs on its behalf,
		free = true;
		await runOrchestratorTick();
		expect(launches()).toBe(0);
		// not after the Packages card's recheck finds the offer again,
		expect(triggerManualUpdateCheck()).toBe(true);
		await settle(() => getUpdateState().kind === "available");
		await runOrchestratorTick();
		expect(launches()).toBe(0);
		// and not after updates are turned off and on again.
		const previous = setup.apt_update_enabled;
		setup.apt_update_enabled = false;
		try {
			await runOrchestratorTick();
		} finally {
			setup.apt_update_enabled = previous;
		}
		await runOrchestratorTick();
		expect(launches()).toBe(0);
		// A new request does launch.
		expect(await installUpdatesNow({ scope: "packages" })).toEqual({
			started: true,
		});
		await settle(() => launches() === 1);
		expect(launches()).toBe(1);
	});

	it("a tick that waited while Install now's unit proof used the request up does not launch on its behalf", async () => {
		// Given a manual request that could not start yet (the updater busy),
		// so it stands, as the image's own rules keep it.
		await box("launched-running");
		let busy = 1;
		let free = true;
		let idle = Promise.withResolvers<boolean>();
		let idleAsked = 0;
		orchestrator({
			ticketed: true,
			installUnitFree: async () => free,
			isIdle: () => {
				idleAsked++;
				return idle.promise;
			},
			busyStarts: () => busy--,
		});
		expect(await checkUpdatesNow()).toEqual({ started: true });
		expect(await installUpdatesNow({ scope: "packages" })).toEqual({
			started: false,
			reason: "busy",
		});
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
		// When a tick passes the request check and waits on the idle window,
		const tick = runOrchestratorTick();
		await settle(() => idleAsked > 0);
		expect(idleAsked).toBe(1);
		// a new Install now meets a held install unit and is turned down,
		free = false;
		expect(await installUpdatesNow({ scope: "packages" })).toEqual({
			started: false,
			reason: "not_available",
		});
		// and the name is free again by the time the tick resumes.
		free = true;
		idle.resolve(true);
		await tick;
		// Then the tick starts nothing: the request was used up.
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
		await settle(() => launches() > 0);
		expect(launches()).toBe(0);
		idle = Promise.withResolvers<boolean>();
		idle.resolve(true);
		await runOrchestratorTick();
		expect(launches()).toBe(0);
	});

	it("preparation throws", async () => {
		await box("throw");
		const { counts } = orchestrator();
		await attempt();
		// The rejection is logged by the check, not left unhandled.
		expect((spies[1]?.mock.calls ?? []).map(([message]) => message)).toContain(
			"Software update check continuation failed",
		);
		await expectRefused(counts, { reason: "not_started" });
	});

	it("a start delayed behind a running check cannot start", async () => {
		await box("none");
		const { counts } = orchestrator();
		expect(await checkUpdatesNow()).toEqual({ started: true });
		// A check of the dialog's is running when the install is asked for.
		const gate = Promise.withResolvers<void>();
		setAptCommandRunnerForTest(async (argv) => {
			if (argv[1] === "update") await gate.promise;
			return {
				exitCode: 0,
				stdout: argv[1] === "update" ? REFRESH : "",
				stderr: "",
			};
		});
		expect(triggerManualUpdateCheck()).toBe(true);
		expect(await installUpdatesNow({ scope: "packages" })).toEqual({
			started: true,
		});
		// The delayed start finds a stream when it runs.
		setStreamLivenessSourceForTest(() => "streaming");
		gate.resolve();
		await Bun.sleep(3_200);
		await runOrchestratorTick();
		expect(getUpdateState()).toMatchObject({ kind: "failed" });
		expect(getOrchestratorState()).toMatchObject({
			phase: "failed",
			failureReason: PACKAGE_INSTALL_REFUSED,
		});
		setStreamLivenessSourceForTest(null);
		await box("none");
		const os = counts.osChecks;
		expect(await checkUpdatesNow()).toEqual({ started: true });
		expect(getUpdateState().kind).toBe("available");
		expect(counts.osChecks).toBe(os + 1);
	});
});

describe("a check that could not start after all", () => {
	it("updates turned off while the pending list is cleared: no check, no event, no backoff", async () => {
		await box("simulation");
		const { counts, quarantine } = orchestrator();
		await attempt();
		expect(getOrchestratorState().failureReason).toBe(PACKAGE_INSTALL_REFUSED);
		const said: string[] = [];
		spies.push(
			spyOn(events, "emitEvent").mockImplementation((code) => {
				said.push(code);
			}),
		);
		// Check now clears the refused install's pending list first: a wait.
		const clear = quarantine.clearPending.bind(quarantine);
		const clearing = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		quarantine.clearPending = async () => {
			clearing.resolve();
			await proceed.promise;
			return clear();
		};
		const before = getOrchestratorState().packageCheck;
		const os = counts.osChecks;
		const previous = setup.apt_update_enabled;
		try {
			const check = checkUpdatesNow();
			await clearing.promise;
			// Updates are turned off during that wait.
			setup.apt_update_enabled = false;
			proceed.resolve();
			expect(await check).toEqual({ started: true });
		} finally {
			setup.apt_update_enabled = previous;
		}
		// No package check was dispatched for it: nothing failed, nobody was
		// told, and the next check is due when it was.
		expect(said).toEqual([]);
		expect(getOrchestratorState().packageCheck).toEqual(before);
		// The image check still ran.
		expect(counts.osChecks).toBe(os + 1);
	});
});

describe("a start the install's own check cannot begin", () => {
	it("leaves the plan queued and answers not_available", async () => {
		await using _marker = await armedMarkerFixture();
		const { flag } = await box("launched");
		const { quarantine } = orchestrator();
		expect(await checkUpdatesNow()).toEqual({ started: true });
		// The clock gate shuts: the check an install starts with cannot run.
		setImageClockGateFlagForTest(`${flag}.gone`);
		expect(await installUpdatesNow({ scope: "packages" })).toEqual({
			started: false,
			reason: "not_available",
		});
		// Nothing started: the wire is as it was and no attempt exists.
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
		expect(getUpdateState().kind).toBe("available");
		expect(packageFailedBeforeLaunch()).toBe(false);
		expect(await quarantine.readPending()).toEqual([]);
		expect(launches()).toBe(0);
		// The request stands: once the check can run, the next tick starts it.
		setImageClockGateFlagForTest(flag);
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(await quarantine.readPending()).toEqual([
			{ name: "modemmanager", version: FIX },
		]);
	});
});

describe("a delayed start and a stream", () => {
	it("stream admission cancels the delayed start: it never launches", async () => {
		await box("none");
		const { counts } = orchestrator();
		expect(await checkUpdatesNow()).toEqual({ started: true });
		const gate = Promise.withResolvers<void>();
		let refreshes = 0;
		setAptCommandRunnerForTest(async (argv) => {
			if (argv[1] === "update") {
				refreshes++;
				await gate.promise;
			}
			return {
				exitCode: 0,
				stdout: argv[1] === "update" ? REFRESH : "",
				stderr: "",
			};
		});
		// A dialog check is running: the install waits behind it.
		expect(triggerManualUpdateCheck()).toBe(true);
		expect(await installUpdatesNow({ scope: "packages" })).toEqual({
			started: true,
		});
		setStreamLivenessSourceForTest(() => "streaming");
		await admitAndPrepareStreamStart();
		expect(getOrchestratorState()).toMatchObject({
			phase: "failed",
			failureReason: PACKAGE_INSTALL_REFUSED,
		});
		expect(getUpdateState()).toMatchObject({
			kind: "failed",
			reason: "streaming",
		});
		setStreamLivenessSourceForTest(null);
		gate.resolve();
		// Past the delayed start's 3 s: it was cancelled. Only the dialog's own
		// refresh ran; the install never started its check or its unit.
		await Bun.sleep(3_300);
		expect(refreshes).toBe(1);
		expect(launches()).toBe(0);
		await box("none");
		const os = counts.osChecks;
		expect(await checkUpdatesNow()).toEqual({ started: true });
		expect(getUpdateState().kind).toBe("available");
		expect(counts.osChecks).toBe(os + 1);
	});
});

describe("once the unit launched, a stream takes today's path", () => {
	it("stream admission stops the unit and returns to the offer", async () => {
		await using _marker = await armedMarkerFixture();
		await box("launched-running");
		const { counts } = orchestrator();
		await attempt();
		setStreamLivenessSourceForTest(() => "streaming");
		await admitAndPrepareStreamStart();
		expect(getOrchestratorState().phase).toBe("available");
		expect(stops.count).toBeGreaterThan(0);
		setStreamLivenessSourceForTest(null);
		expect(counts.osChecks).toBeGreaterThan(0);
	});
});

describe("the refused install is never stranded", () => {
	it.each(["clock gate shut", "updates turned off"] as const)(
		"Check now still runs the image check with the %s",
		async (cause) => {
			const { flag } = await box("simulation");
			const { counts } = orchestrator();
			await attempt();
			expect(getOrchestratorState().failureReason).toBe(
				PACKAGE_INSTALL_REFUSED,
			);
			const previous = setup.apt_update_enabled;
			if (cause === "clock gate shut")
				setImageClockGateFlagForTest(`${flag}.gone`);
			else setup.apt_update_enabled = false;
			try {
				const os = counts.osChecks;
				expect(await checkUpdatesNow()).toEqual({ started: true });
				// The package check could not run; the image check did.
				expect(counts.osChecks).toBe(os + 1);
				expect(getOrchestratorState().phase).not.toBe("downloading");
			} finally {
				setup.apt_update_enabled = previous;
				setImageClockGateFlagForTest(flag);
			}
		},
	);

	it("the scheduled tick runs the package check at once, leaving failed", async () => {
		await box("simulation");
		const { counts } = orchestrator();
		await attempt();
		expect(getOrchestratorState().failureReason).toBe(PACKAGE_INSTALL_REFUSED);
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("available");
		expect(getUpdateState().kind).toBe("available");
		// The image check was not held: it runs as soon as it is asked for.
		const os = counts.osChecks;
		expect(await checkUpdatesNow()).toEqual({ started: true });
		expect(counts.osChecks).toBe(os + 1);
	});

	it("while a stream is live the scheduled retry waits: no failed check, and the due image check runs", async () => {
		await box("simulation");
		let live = false;
		const { counts } = orchestrator({ streamLive: () => live });
		const said: { code: string; params: unknown }[] = [];
		await attempt();
		expect(getOrchestratorState().failureReason).toBe(PACKAGE_INSTALL_REFUSED);
		spies.push(
			spyOn(events, "emitEvent").mockImplementation((code, params) => {
				said.push({ code, params });
			}),
		);
		// A stream is live when the tick comes, and an image check is due.
		live = true;
		setStreamLivenessSourceForTest(() => "streaming");
		const due = () =>
			setOrchestratorStateForTest({
				...getOrchestratorState(),
				osCheck: { ...getOrchestratorState().osCheck, nextAttemptAt: 0 },
			});
		due();
		const before = getOrchestratorState().packageCheck;
		const os = counts.osChecks;
		await runOrchestratorTick();
		// No package check was dispatched: none failed, no backoff, no event.
		expect(getOrchestratorState().packageCheck).toEqual(before);
		expect(said.filter(({ code }) => code === "update_refused")).toEqual([]);
		expect(getOrchestratorState().phase).not.toBe("checking");
		// The image check ran on that tick.
		expect(counts.osChecks).toBe(os + 1);
		// The stream goes on: the next tick waits likewise, wherever the image
		// check left the plan.
		due();
		await runOrchestratorTick();
		expect(getOrchestratorState().packageCheck).toEqual(before);
		expect(said.filter(({ code }) => code === "update_refused")).toEqual([]);
		expect(counts.osChecks).toBe(os + 2);
		expect(getUpdateState().kind).toBe("failed");
		// The stream over, the retry runs and finds the offer.
		live = false;
		setStreamLivenessSourceForTest(null);
		await runOrchestratorTick();
		expect(getUpdateState().kind).toBe("available");
		expect(getOrchestratorState()).toMatchObject({
			phase: "available",
			packageCheck: { consecutiveFailures: 0 },
		});
	});

	it("a stream that starts while the retry clears the pending list defers it too", async () => {
		await box("simulation");
		let live = false;
		const { counts, quarantine } = orchestrator({ streamLive: () => live });
		const said: { code: string; params: unknown }[] = [];
		await attempt();
		expect(getOrchestratorState().failureReason).toBe(PACKAGE_INSTALL_REFUSED);
		spies.push(
			spyOn(events, "emitEvent").mockImplementation((code, params) => {
				said.push({ code, params });
			}),
		);
		// No stream when the tick comes. One starts while the retry clears the
		// refused install's pending list.
		const clear = quarantine.clearPending.bind(quarantine);
		quarantine.clearPending = async () => {
			await clear();
			live = true;
			setStreamLivenessSourceForTest(() => "streaming");
		};
		setOrchestratorStateForTest({
			...getOrchestratorState(),
			osCheck: { ...getOrchestratorState().osCheck, nextAttemptAt: 0 },
		});
		const before = getOrchestratorState().packageCheck;
		const os = counts.osChecks;
		const cleared = counts.pendingCleared;
		await runOrchestratorTick();
		// The cleanup ran (the image check clears the list as well).
		expect(counts.pendingCleared).toBeGreaterThan(cleared);
		// The check did not run: nothing was dispatched, so nothing failed. No
		// refusal event, no backoff; the image check that was due ran.
		expect(getOrchestratorState().packageCheck).toEqual(before);
		expect(said.filter(({ code }) => code === "update_refused")).toEqual([]);
		expect(getOrchestratorState().phase).not.toBe("checking");
		expect(counts.osChecks).toBe(os + 1);
		expect(getUpdateState().kind).toBe("failed");
		// The stream over, the retry runs and finds the offer.
		quarantine.clearPending = clear;
		live = false;
		setStreamLivenessSourceForTest(null);
		await runOrchestratorTick();
		expect(getUpdateState().kind).toBe("available");
		expect(getOrchestratorState()).toMatchObject({
			phase: "available",
			packageCheck: { consecutiveFailures: 0 },
		});
	});

	it("a retry that defers says nothing of a capability read that failed meanwhile", async () => {
		await box("simulation");
		let live = false;
		// Armed for the retry's own read, the second of a tick (the tick reads
		// the capabilities once for itself): the file is unreadable then, and
		// (the first time) a stream starts while it is read.
		let failing = false;
		let reads = 0;
		let streamStarts = true;
		const { counts } = orchestrator({
			streamLive: () => live,
			onCapabilityRead: () => {
				if (!failing || ++reads < 2) return;
				failing = false;
				if (streamStarts) {
					live = true;
					setStreamLivenessSourceForTest(() => "streaming");
				}
				throw new UpdateCapabilityReadError(new Error("unreadable"));
			},
		});
		const said: { code: string; params: unknown }[] = [];
		await attempt();
		expect(getOrchestratorState().failureReason).toBe(PACKAGE_INSTALL_REFUSED);
		spies.push(
			spyOn(events, "emitEvent").mockImplementation((code, params) => {
				said.push({ code, params });
			}),
		);
		setOrchestratorStateForTest({
			...getOrchestratorState(),
			osCheck: { ...getOrchestratorState().osCheck, nextAttemptAt: 0 },
		});
		const before = getOrchestratorState().packageCheck;
		const os = counts.osChecks;
		failing = true;
		await runOrchestratorTick();
		expect(failing).toBe(false);
		// The check was deferred for the stream: nobody is told it was refused,
		// for the capabilities or anything else, and the image check ran.
		expect(said.filter(({ code }) => code === "update_refused")).toEqual([]);
		expect(getOrchestratorState().packageCheck).toEqual(before);
		expect(counts.osChecks).toBe(os + 1);
		// The same failure with no stream is reported: that check runs.
		live = false;
		setStreamLivenessSourceForTest(null);
		streamStarts = false;
		reads = 0;
		failing = true;
		await runOrchestratorTick();
		expect(failing).toBe(false);
		expect(said.filter(({ code }) => code === "update_refused")).toHaveLength(
			1,
		);
		expect(JSON.stringify(said)).toContain("package-capabilities");
	});

	it("a retry whose pending-list cleanup fails during a stream waits, and the due image check runs", async () => {
		await box("simulation");
		let live = false;
		const { counts, quarantine } = orchestrator({ streamLive: () => live });
		await attempt();
		expect(getOrchestratorState().failureReason).toBe(PACKAGE_INSTALL_REFUSED);
		// A stream is live, and the pending list cannot be cleared just now.
		live = true;
		setStreamLivenessSourceForTest(() => "streaming");
		const clear = quarantine.clearPending.bind(quarantine);
		let faults = 1;
		quarantine.clearPending = async () => {
			if (faults-- > 0) throw new Error("EIO: the pending list");
			return clear();
		};
		setOrchestratorStateForTest({
			...getOrchestratorState(),
			osCheck: { ...getOrchestratorState().osCheck, nextAttemptAt: 0 },
		});
		const before = getOrchestratorState().packageCheck;
		const os = counts.osChecks;
		// The tick is not rejected: the package side's fault is logged, its
		// check waits, and the image check that was due runs.
		await runOrchestratorTick();
		expect(
			(spies[1]?.mock.calls ?? []).map(([message]) => String(message)),
		).toContain(
			"update-orchestrator: clearing a refused install's pending list failed; the package check waits",
		);
		expect(getOrchestratorState().packageCheck).toEqual(before);
		expect(counts.osChecks).toBe(os + 1);
		quarantine.clearPending = clear;
		live = false;
		setStreamLivenessSourceForTest(null);
		await runOrchestratorTick();
		expect(getUpdateState().kind).toBe("available");
	});

	it.each([
		"the pending list is cleared",
		"the capabilities are read",
	] as const)(
		"updates turned off while %s: no check ran, so the due image check runs on that tick",
		async (during) => {
			await box("simulation");
			const previous = setup.apt_update_enabled;
			let armed = false;
			let reads = 0;
			const { counts, quarantine } = orchestrator({
				onCapabilityRead: () => {
					// The retry's own read is the second of a tick.
					if (armed && during === "the capabilities are read" && ++reads === 2)
						setup.apt_update_enabled = false;
				},
			});
			await attempt();
			expect(getOrchestratorState().failureReason).toBe(
				PACKAGE_INSTALL_REFUSED,
			);
			const clear = quarantine.clearPending.bind(quarantine);
			quarantine.clearPending = async () => {
				await clear();
				if (armed && during === "the pending list is cleared")
					setup.apt_update_enabled = false;
			};
			setOrchestratorStateForTest({
				...getOrchestratorState(),
				osCheck: { ...getOrchestratorState().osCheck, nextAttemptAt: 0 },
			});
			const before = getOrchestratorState().packageCheck;
			const os = counts.osChecks;
			armed = true;
			try {
				await runOrchestratorTick();
				expect(setup.apt_update_enabled).toBe(false);
				// Nothing was dispatched for packages, and the image check did
				// not slip to the next tick.
				expect(getOrchestratorState().packageCheck).toEqual(before);
				expect(getOrchestratorState().phase).not.toBe("checking");
				expect(counts.osChecks).toBe(os + 1);
			} finally {
				setup.apt_update_enabled = previous;
				quarantine.clearPending = clear;
			}
		},
	);

	it("a pending list that cannot be cleared at all does not keep the image check from its manifest", async () => {
		await box("simulation");
		const { counts, quarantine } = orchestrator();
		await attempt();
		expect(getOrchestratorState().failureReason).toBe(PACKAGE_INSTALL_REFUSED);
		// Every attempt to clear the list fails, the image check's own too.
		const clear = quarantine.clearPending.bind(quarantine);
		quarantine.clearPending = async () => {
			throw new Error("EIO: the pending list");
		};
		setOrchestratorStateForTest({
			...getOrchestratorState(),
			osCheck: { ...getOrchestratorState().osCheck, nextAttemptAt: 0 },
		});
		const os = counts.osChecks;
		// The tick is not rejected, and the manifest is read.
		await runOrchestratorTick();
		expect(counts.osChecks).toBe(os + 1);
		const warned = (spies[1]?.mock.calls ?? []).map(([message]) =>
			String(message),
		);
		expect(warned).toContain(
			"update-orchestrator: clearing a refused install's pending list failed; the package check waits",
		);
		expect(warned).toContain(
			"update-orchestrator: clearing a refused install's pending list failed; the image check goes on",
		);
		quarantine.clearPending = clear;
	});

	it("a scheduled check that waited for the uplinks dispatches nothing over a Check now and Install now made meanwhile", async () => {
		await box("launched-running");
		// While the scheduled check asks which uplinks exist, the user checks
		// and installs.
		let meanwhile: (() => Promise<void>) | null = null;
		const { counts } = orchestrator({
			onlyMetered: async () => {
				const act = meanwhile;
				meanwhile = null;
				await act?.();
				return false;
			},
		});
		const said: { code: string; params: unknown }[] = [];
		spies.push(
			spyOn(events, "emitEvent").mockImplementation((code, params) => {
				said.push({ code, params });
			}),
		);
		meanwhile = async () => {
			expect(await checkUpdatesNow()).toEqual({ started: true });
			expect(await installUpdatesNow({ scope: "packages" })).toEqual({
				started: true,
			});
			expect(getOrchestratorState().phase).toBe("downloading");
		};
		// The first tick's scheduled check is due.
		await runOrchestratorTick();
		expect(meanwhile).toBeNull();
		// The install is the plan now: no check was dispatched over it, and
		// nobody was told one was refused.
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(said.filter(({ code }) => code === "update_refused")).toEqual([]);
		// The install goes on to launch its unit, undisturbed.
		await settle(() => launches() === 1);
		expect(launches()).toBe(1);
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(said.filter(({ code }) => code === "update_refused")).toEqual([]);
		void counts;
	});

	it("on cellular only, the scheduled check waits and Check now still runs it", async () => {
		await box("simulation");
		let metered = false;
		const { counts } = orchestrator({
			allowPackagesOverCellular: false,
			onlyMetered: () => metered,
		});
		await attempt();
		// Only metered uplinks now, and packages may not use them.
		metered = true;
		await runOrchestratorTick();
		expect(getOrchestratorState()).toMatchObject({
			phase: "failed",
			failureReason: PACKAGE_INSTALL_REFUSED,
		});
		// The image check is not held by it (its own cellular rule allows it here).
		expect(counts.osChecks).toBeGreaterThan(0);
		const os = counts.osChecks;
		expect(await checkUpdatesNow()).toEqual({ started: true });
		expect(getUpdateState().kind).toBe("available");
		expect(getOrchestratorState().phase).toBe("available");
		expect(counts.osChecks).toBe(os + 1);
	});
});

describe("once the unit launched", () => {
	it("its own failure fails the update, as on every image", async () => {
		await using _marker = await armedMarkerFixture();
		await box("launched");
		orchestrator();
		await attempt();
		await settle(() => getUpdateState().kind === "failed");
		await runOrchestratorTick();
		expect(getUpdateState().kind).toBe("failed");
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().failureReason).not.toBe(
			PACKAGE_INSTALL_REFUSED,
		);
	});
});
