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
	triggerManualUpdateCheck,
} from "../modules/system/software-updates.ts";
import { setStreamLivenessSourceForTest } from "../modules/system/stream-liveness-source.ts";
import { setCeraliveSourcesFileForTest } from "../modules/system/update-apt-channel.ts";
import { setUpdateCapabilityPathForTest } from "../modules/system/update-capabilities.ts";
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
	| "space-preflight"
	| "download"
	| "start-rejected"
	| "throw"
	| "launched";

const scratch: string[] = [];
let spies: ReturnType<typeof spyOn>[] = [];
beforeEach(() => {
	spies = [
		spyOn(logger, "info").mockImplementation(() => logger),
		spyOn(logger, "warn").mockImplementation(() => logger),
		spyOn(logger, "error").mockImplementation(() => logger),
	];
});
afterEach(async () => {
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
	const pinned = failing === "download";
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
			if (failing === "pinned-recheck" && once.pinned) {
				once.pinned = false;
				return {
					exitCode: 100,
					stdout: "",
					stderr: "E: pinned recheck failed",
				};
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
		if (argv.includes("-d") && once.download) {
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
			(_args, _verdict, handlers) => {
				if (failing === "start-rejected")
					return Promise.reject(new Error("systemd-run: unit refused"));
				handlers.onLaunched?.();
				handlers.onStderr(
					"E: Sub-process /usr/bin/dpkg returned an error code (1)\n",
				);
				return Promise.resolve(100);
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
	return { flag };
}

// The orchestrator over the real package code, counting image checks.
function orchestrator(
	options: {
		readonly allowPackagesOverCellular?: boolean;
		readonly onlyMetered?: () => boolean;
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
			loadCapabilities: async () => ({
				mode: "capable",
				features: ["apt-all-packages", "rauc-verity-streaming"],
			}),
			loadSettings: async () => ({
				packagesAuto: true,
				systemAuto: true,
				schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
				channel: "stable",
				allowPackagesOverCellular: options.allowPackagesOverCellular ?? true,
				allowSystemOverCellular: true,
			}),
			onlyMeteredCandidateExists: async () => options.onlyMetered?.() ?? false,
			runPackageCheck: runSoftwareUpdateCheck,
			startPackageInstall: () => startSoftwareUpdate(),
			getPackageInstallWireState: getUpdateState,
			packageFailedBeforeLaunch,
			stopPackageInstallUnit: async () => abortAptTransferForStream(),
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
async function attempt(during?: () => void | Promise<void>) {
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
	await runOrchestratorTick();
}

// The refused install: `failed` on the wire and in the orchestrator, then the
// next check rediscovers the offer and the image check runs.
async function expectRefused(
	counts: { osChecks: number; pendingCleared: number },
	wire: Partial<UpdateState>,
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
}

describe("each way an install ends before its unit launches", () => {
	it("the install's own check is refused (repository unreachable)", async () => {
		await box("install-refresh");
		const { counts } = orchestrator();
		await attempt();
		await expectRefused(counts, {
			reason: "Failed to fetch the updated package list; aborting the update.",
		});
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
		await box("install-reachability");
		const { counts } = orchestrator();
		await attempt();
		await expectRefused(counts, {
			reason: "The software repositories are unreachable.",
		});
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

	it("a stream starts during the download: the plan returns to the offer, as today", async () => {
		await box("none");
		const { counts } = orchestrator();
		await attempt(async () => {
			setStreamLivenessSourceForTest(() => "streaming");
			await admitAndPrepareStreamStart();
		});
		expect(getOrchestratorState().phase).toBe("available");
		expect(getUpdateState().kind).toBe("available");
		setStreamLivenessSourceForTest(null);
		const os = counts.osChecks;
		expect(await checkUpdatesNow()).toEqual({ started: true });
		expect(getOrchestratorState().phase).toBe("available");
		expect(counts.osChecks).toBe(os + 1);
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

describe("the refused install is never stranded", () => {
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
