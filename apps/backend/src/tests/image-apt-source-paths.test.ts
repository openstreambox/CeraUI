/// <reference types="bun" />

/**
 * Every way an install attempt on an image with its own apt source can end
 * before the detached unit launches (docs/agents/the-device-update-system.md
 * keeps the table). One test per path, through the real package code and the
 * real orchestrator: the wire and the orchestrator release together, and an
 * image check can run afterwards.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UpdateState } from "@ceraui/rpc/schemas";
import { logger } from "../helpers/logger.ts";
import { defaultAptSpaceDeps } from "../modules/system/apt-space-admission.ts";
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
	currentPackageInstallAttempt,
	getUpdateState,
	resetAptReachabilityProbeForTest,
	resetSoftwareUpdateCheckRunner,
	resetSoftwareUpdateState,
	runSoftwareUpdateCheck,
	setAptCommandRunnerForTest,
	setAptReachabilityProbeForTest,
	startSoftwareUpdate,
} from "../modules/system/software-updates.ts";
import { setStreamLivenessSourceForTest } from "../modules/system/stream-liveness-source.ts";
import { setCeraliveSourcesFileForTest } from "../modules/system/update-apt-channel.ts";
import { setUpdateCapabilityPathForTest } from "../modules/system/update-capabilities.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { rankTransports } from "../modules/system/update-transport/core.ts";
import { notificationRemove } from "../modules/ui/notifications.ts";
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
// Only a package from a source that is not the image's: nothing installable.
const NOTHING_ACTIONABLE = plan(
	"Inst zstd [1.5.6+dfsg-2] (1.5.7+dfsg-1 Debian:13.7/stable [arm64])\nConf zstd (1.5.7+dfsg-1 Debian:13.7/stable [arm64])\n",
);
const REFRESH = `Hit:1 ${URI} ${SUITE} InRelease\nHit:2 ${URI} ${EMERGENCY} InRelease\nReading package lists...\n`;

type Path =
	| "install-refresh"
	| "install-reachability"
	| "simulation"
	| "hold"
	| "policy"
	| "nothing-actionable"
	| "pinned-recheck"
	| "space-preflight"
	| "download"
	| "stream"
	| "start-rejected"
	| "clock"
	| "launched";

const scratch: string[] = [];
let quiet: ReturnType<typeof spyOn>[] = [];
beforeEach(() => {
	quiet = [
		spyOn(logger, "info").mockImplementation(() => logger),
		spyOn(logger, "warn").mockImplementation(() => logger),
		spyOn(logger, "error").mockImplementation(() => logger),
	];
});
afterEach(async () => {
	for (const spy of quiet) spy.mockRestore();
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

// A box with the record, an offer of one emergency fix, and `path` failing.
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
	await writeFile(path.join(dir, "clock-gate-open"), "");
	setImageAptSourceReaderForTest((file) => FILES[file] ?? null);
	setImageClockGateFlagForTest(path.join(dir, "clock-gate-open"));
	setDpkgUpdatesDirForTest(path.join(dir, "updates"));
	setUpdateCapabilityPathForTest(path.join(dir, "capabilities.json"));
	setCeraliveSourcesFileForTest(path.join(dir, "ceralive.sources"));
	setImageOwnedPackagesReaderForTest(null, path.join(dir, "no-pin"));

	const seen = { refresh: 0, simulation: 0, probes: 0 };
	setAptReachabilityProbeForTest(async () =>
		++seen.probes > 0 && failing === "install-reachability" && seen.refresh >= 2
			? {
					ipv4: "no_route",
					ipv6: "no_route",
					used: "none",
					verdict: "unreachable",
					detail: [],
				}
			: // The check probes twice (refresh, discovery); the install's own check next.
				failing === "install-refresh" && seen.probes >= 3
				? {
						ipv4: "no_route",
						ipv6: "no_route",
						used: "none",
						verdict: "unreachable",
						detail: [],
					}
				: { ipv4: "ok", ipv6: "ok", used: "any", verdict: "any", detail: [] },
	);
	const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
	const install = () => seen.simulation >= 2;
	setAptCommandRunnerForTest(async (argv) => {
		if (argv[1] === "update") {
			seen.refresh++;
			return ok(REFRESH);
		}
		if (argv[0] === "/usr/bin/apt-mark")
			return failing === "hold" && install()
				? { exitCode: 1, stdout: "", stderr: "E: hold query failed" }
				: ok("");
		if (argv[0] === "/usr/bin/apt-cache") {
			const name = argv[argv.indexOf("policy") + 1];
			if (name === undefined) return ok(INVENTORY);
			if (failing === "policy" && install())
				return { exitCode: 100, stdout: "", stderr: "E: policy failed" };
			return ok(name === "zstd" ? POLICY_ZSTD : POLICY_MM);
		}
		if (argv.includes("-s") && argv.includes("install"))
			return failing === "pinned-recheck"
				? { exitCode: 100, stdout: "", stderr: "E: pinned recheck failed" }
				: ok(OFFER);
		if (argv.includes("-s")) {
			seen.simulation++;
			if (failing === "simulation" && install())
				return { exitCode: 100, stdout: "", stderr: "E: simulation failed" };
			return ok(
				failing === "nothing-actionable" && install()
					? NOTHING_ACTIONABLE
					: OFFER,
			);
		}
		if (argv.includes("-d"))
			return {
				exitCode: 100,
				stdout: "",
				stderr: `E: Failed to fetch ${URI}/pool/main/m/modemmanager.deb  Connection timed out\n`,
			};
		return ok("");
	});

	// The space probe: everything fits, unless this is the path that fails.
	spies.push(
		spyOn(defaultAptSpaceDeps, "run").mockImplementation(async (argv) =>
			argv.includes("clean")
				? {
						exitCode: failing === "space-preflight" ? 100 : 0,
						stdout: "",
						stderr: "",
					}
				: argv[0] === "/usr/bin/apt-config"
					? ok("ARCHIVES='/cache/archives/';")
					: ok(
							"After this operation, 2 kB of additional disk space will be used.\n'https://updates.example.org/a.deb' a.deb 4000 SHA256:abc\n",
						),
		),
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
}
const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});

// The orchestrator over the real package code, counting image checks.
function orchestrator() {
	const counts = { osChecks: 0 };
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			quarantine: testQuarantine(),
			loadCapabilities: async () => ({
				mode: "capable",
				features: ["apt-all-packages", "rauc-verity-streaming"],
			}),
			runPackageCheck: runSoftwareUpdateCheck,
			startPackageInstall: () => startSoftwareUpdate(),
			getPackageInstallWireState: getUpdateState,
			packageInstallAttempt: currentPackageInstallAttempt,
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
	return counts;
}

// Check, find the offer, ask to install, and let the attempt end.
async function attempt(onStarted?: () => void, beforeTick?: () => void) {
	expect(await checkUpdatesNow()).toEqual({ started: true });
	expect(getOrchestratorState().phase).toBe("available");
	expect(getUpdateState().kind).toBe("available");
	expect(await installUpdatesNow({ scope: "packages" })).toEqual({
		started: true,
	});
	expect(getOrchestratorState().phase).toBe("downloading");
	onStarted?.();
	for (let i = 0; i < 400; i++) {
		const { kind } = currentPackageInstallAttempt().outcome;
		if (kind !== "pending" && kind !== "launching") break;
		await Bun.sleep(5);
	}
	await Bun.sleep(20);
	beforeTick?.();
	await runOrchestratorTick();
}

// Released together, and the image check runs afterwards.
async function expectReleased(
	counts: { osChecks: number },
	wire: Partial<UpdateState> | ((state: UpdateState) => void),
	phase: "idle" | "available" = "idle",
) {
	expect(getOrchestratorState().phase).toBe(phase);
	const state = getUpdateState();
	if (typeof wire === "function") wire(state);
	else expect(state).toMatchObject(wire);
	expect(JSON.stringify(state)).not.toContain(TOKEN);
	const before = counts.osChecks;
	expect(await checkUpdatesNow()).toEqual({ started: true });
	expect(counts.osChecks).toBe(before + 1);
}
const leftTheOffer = (state: UpdateState) => {
	expect(state.kind).not.toBe("available");
	expect(state.kind).not.toBe("downloading");
	expect(state.kind).not.toBe("installing");
};

describe("each way an install attempt ends before its unit launches", () => {
	it("the install's own refresh is refused (repository unreachable)", async () => {
		await box("install-refresh");
		const counts = orchestrator();
		await attempt();
		expect(currentPackageInstallAttempt().outcome.kind).toBe("refused");
		await expectReleased(counts, {
			kind: "failed",
			reason: "Failed to fetch the updated package list; aborting the update.",
		});
	});

	it("the install's network turns out unreachable", async () => {
		await box("install-reachability");
		const counts = orchestrator();
		await attempt();
		await expectReleased(counts, {
			kind: "failed",
			reason: "The software repositories are unreachable.",
		});
	});

	it("the image's record stops validating once the install started", async () => {
		await box("install-refresh");
		// The check itself stays healthy: only the record changes.
		setAptReachabilityProbeForTest(async () => ({
			ipv4: "ok",
			ipv6: "ok",
			used: "any",
			verdict: "any",
			detail: [],
		}));
		const counts = orchestrator();
		await attempt(() =>
			setImageAptSourceReaderForTest((file) =>
				file === IMAGE_APT_SOURCE_POLICY ? "{}" : null,
			),
		);
		expect(currentPackageInstallAttempt().outcome.kind).toBe("refused");
		await expectReleased(counts, {
			kind: "failed",
			reason: "discovery_failed",
		});
	});

	it("the clock gate closes before the install is prepared", async () => {
		await box("clock");
		const counts = orchestrator();
		await attempt(() =>
			setImageClockGateFlagForTest("/nonexistent/clock-gate-open"),
		);
		expect(currentPackageInstallAttempt().outcome).toMatchObject({
			kind: "refused",
			reason: "check_unavailable",
		});
		// The package check now waits for the clock; the image check still runs.
		await expectReleased(counts, {
			kind: "failed",
			reason: "check_unavailable",
		});
	});

	it("the install-time discovery simulation fails after a standing offer", async () => {
		await box("simulation");
		const counts = orchestrator();
		await attempt();
		await expectReleased(counts, {
			kind: "failed",
			reason: "discovery_failed",
		});
	});

	it("the install-time hold query fails after a standing offer", async () => {
		await box("hold");
		const counts = orchestrator();
		await attempt();
		await expectReleased(counts, {
			kind: "failed",
			reason: "discovery_failed",
		});
	});

	it("an install-time package policy read fails", async () => {
		await box("policy");
		const counts = orchestrator();
		await attempt();
		await expectReleased(counts, {
			kind: "failed",
			reason: "discovery_failed",
		});
	});

	it("nothing is installable any more", async () => {
		await box("nothing-actionable");
		const counts = orchestrator();
		await attempt();
		await expectReleased(counts, {
			kind: "failed",
			reason: "No actionable application packages are available.",
		});
	});

	it("the pinned recheck refuses", async () => {
		await box("pinned-recheck");
		const counts = orchestrator();
		await attempt();
		await expectReleased(counts, {
			kind: "failed",
			reason: "discovery_failed",
		});
	});

	it("the space preflight (its archive cleanup) refuses", async () => {
		await box("space-preflight");
		const counts = orchestrator();
		await attempt();
		await expectReleased(counts, {
			kind: "update_preflight_failed",
			preflight_reason: "pre_clean_failed",
		});
	});

	it("the download under the pin fails", async () => {
		await box("download");
		const counts = orchestrator();
		// The pinned transport serves the install's transfers (a real board's).
		const previous = process.env.CERALIVE_DEVICE_TYPE;
		const restore = () => {
			if (previous === undefined) delete process.env.CERALIVE_DEVICE_TYPE;
			else process.env.CERALIVE_DEVICE_TYPE = previous;
		};
		try {
			await attempt(() => {
				process.env.CERALIVE_DEVICE_TYPE = "real";
			}, restore);
		} finally {
			restore();
		}
		expect(currentPackageInstallAttempt().outcome.kind).toBe("refused");
		await expectReleased(counts, (state) => {
			leftTheOffer(state);
			expect(state.kind).toBe("failed");
		});
	});

	it("a stream starts before the install is prepared", async () => {
		await box("stream");
		const counts = orchestrator();
		await attempt(() => setStreamLivenessSourceForTest(() => "streaming"));
		expect(currentPackageInstallAttempt().outcome.kind).toBe("stream");
		setStreamLivenessSourceForTest(null);
		// The offer stays: the install can be asked for again.
		await expectReleased(counts, { kind: "available" }, "available");
	});

	it("systemd refuses the unit before it starts", async () => {
		await using _marker = await armedMarkerFixture();
		await box("start-rejected");
		const counts = orchestrator();
		await attempt();
		expect(currentPackageInstallAttempt().outcome).toMatchObject({
			kind: "refused",
			reason: "systemd-run: unit refused",
		});
		await expectReleased(counts, (state) => {
			leftTheOffer(state);
			expect(state.kind).toBe("failed");
		});
	});
});

describe("once the unit launched", () => {
	it("its own failure fails the update, as before", async () => {
		await using _marker = await armedMarkerFixture();
		await box("launched");
		orchestrator();
		await attempt();
		expect(currentPackageInstallAttempt().outcome.kind).toBe("launched");
		for (let i = 0; i < 100 && getUpdateState().kind !== "failed"; i++)
			await Bun.sleep(5);
		await runOrchestratorTick();
		expect(getUpdateState().kind).toBe("failed");
		expect(getOrchestratorState().phase).toBe("failed");
	});
});
