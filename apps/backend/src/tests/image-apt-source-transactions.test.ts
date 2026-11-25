/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateState } from "@ceraui/rpc/schemas";
import {
	buildAptAllDiscoveryArgs,
	buildAptAllDownloadArgs,
	buildAptAllInstallArgs,
} from "../modules/system/apt-all-packages.ts";
import {
	IMAGE_APT_SOURCE_POLICY,
	imageAptSourceArgs,
	parseImageAptSource,
	setImageAptSourceReaderForTest,
	setImageClockGateFlagForTest,
} from "../modules/system/image-apt-source.ts";
import { runDetachedAptAll } from "../modules/system/software-update-process.ts";
import type { DetachedAptServiceState } from "../modules/system/software-update-service.ts";
import {
	buildDetachedAptAllCommand,
	buildDetachedAptUpgradeCommand,
	InvalidDetachedAptUpgradeArgumentsError,
} from "../modules/system/software-update-service.ts";
import {
	expectedAptAllScript,
	isExpectedAptAllInstallArgv,
	validateDetachedAptServiceIdentity,
} from "../modules/system/software-update-service-contract.ts";
import { buildAptRefreshArgs } from "../modules/system/software-updates.ts";
import { reduceOrchestrator } from "../modules/system/update-orchestrator/reducer.ts";
import {
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { canStartManualCheck } from "../modules/system/update-orchestrator/schedule.ts";
import { normalizeStartupDiscovery } from "../modules/system/update-orchestrator/startup-discovery.ts";
import {
	initialOrchestratorState,
	PACKAGE_INSTALL_REFUSED,
} from "../modules/system/update-orchestrator/types.ts";
import { selectUpdateTransport } from "../modules/system/update-transport/executor.ts";
import {
	fakeDeps,
	quarantineDirs,
	testQuarantine,
} from "./helpers/orchestrator-runtime-harness.ts";

const HOST = "updates.example.org";
const TOKEN = "k7Qm2xV9pL4sT8wZ";
const URI = `https://${HOST}/${TOKEN}/apt`;
const SUITE = "rock-5b-plus-2026.11.6";
const SOURCES_FILE = "/etc/apt/sources.list.d/openstreambox.sources";
const POLICY = `{"schema":1,"sourcesFile":"${SOURCES_FILE}","host":"${HOST}","origin":"OpenStreamBox","label":"OpenStreamBox","suites":["${SUITE}","${SUITE}-emergency"]}`;
const SOURCES = `Types: deb\nURIs: ${URI}/\nSuites: ${SUITE} ${SUITE}-emergency\nComponents: main\nSigned-By: /usr/share/keyrings/openstreambox-archive-keyring.pgp\n`;
const PAIR = [
	"-o",
	`Dir::Etc::SourceList=${SOURCES_FILE}`,
	"-o",
	"Dir::Etc::SourceParts=/dev/null",
];
const OUTPUT = {
	stdout: "/run/ceralive/software-update.stdout",
	stderr: "/run/ceralive/software-update.stderr",
};

const withImageSource = () =>
	setImageAptSourceReaderForTest((file) =>
		file === IMAGE_APT_SOURCE_POLICY
			? POLICY
			: file === SOURCES_FILE
				? SOURCES
				: null,
	);
const withoutImageSource = () => setImageAptSourceReaderForTest(() => null);

let clockDir: string | undefined;
afterEach(() => {
	resetOrchestratorRuntimeForTest();
	setImageAptSourceReaderForTest(null);
	setImageClockGateFlagForTest(null);
	if (clockDir) rmSync(clockDir, { recursive: true, force: true });
	clockDir = undefined;
	for (const dir of quarantineDirs.splice(0)) rmSync(dir, { recursive: true });
});

// systemd's view of a running unit, in the shape `systemctl show` prints it.
const unit = (script: string) =>
	`Id=ceralive-software-update.service\nFragmentPath=/run/systemd/transient/ceralive-software-update.service\nDescription=CeraLive software update\nTransient=yes\nType=exec\nRemainAfterExit=yes\nStandardOutput=append\nStandardError=append\nUser=\nExecStartPre=\nExecStartPost=\nExecStart={ path=/usr/bin/flock ; argv[]=/usr/bin/flock -x /run/lock/ceralive-update.lock /bin/sh -ec ${script} ; ignore_errors=no ; start_time=[Mon 2026-11-24 18:05:58 UTC] ; stop_time=[n/a] ; pid=1088904 ; code=(null) ; status=0/0 }\n`;
const PIN = [{ name: "modemmanager", version: "1.24.2-2~ceralive.3+osb3" }];
const CONFOLD = [
	"-y",
	"--no-download",
	"--no-remove",
	"-o",
	"Dpkg::Options::=--force-confdef",
	"-o",
	"Dpkg::Options::=--force-confold",
];
const PINNED = "install modemmanager=1.24.2-2~ceralive.3+osb3";

describe("apt argv on an image with its own source", () => {
	it("every package-update builder adds exactly the source overrides", () => {
		withImageSource();
		expect(imageAptSourceArgs()).toEqual(PAIR);
		expect(buildAptRefreshArgs("any").slice(-4)).toEqual(PAIR);
		expect(buildAptAllDiscoveryArgs([]).slice(-4)).toEqual(PAIR);
		expect(buildAptAllDownloadArgs([]).slice(-4)).toEqual(PAIR);
		expect(buildAptAllInstallArgs(PIN, "force_ipv4")).toEqual([
			...CONFOLD,
			"-o",
			"Acquire::ForceIPv4=true",
			...PAIR,
			"install",
			"modemmanager=1.24.2-2~ceralive.3+osb3",
		]);
	});

	it("without the record the builders are as before", () => {
		withoutImageSource();
		expect(imageAptSourceArgs()).toEqual([]);
		expect(buildAptRefreshArgs("any")).toEqual([
			"/usr/bin/apt-get",
			"update",
			"--allow-releaseinfo-change",
			"-o",
			"Acquire::http::Timeout=15",
			"-o",
			"Acquire::https::Timeout=15",
			"-o",
			"Acquire::Retries=1",
		]);
		expect(buildAptAllDownloadArgs([])).toEqual([
			"/usr/bin/apt-get",
			"-d",
			"-y",
			"upgrade",
			"--with-new-pkgs",
		]);
		expect(buildAptAllInstallArgs(PIN, "any")).toEqual([
			...CONFOLD,
			"install",
			"modemmanager=1.24.2-2~ceralive.3+osb3",
		]);
	});

	it("the detached unit's download and install stages both carry them, and adopt", () => {
		withImageSource();
		const command = buildDetachedAptAllCommand(
			buildAptAllInstallArgs(PIN, "any"),
			"any",
			OUTPUT,
		);
		const script = command.at(-1) ?? "";
		expect(script).toBe(
			`/usr/bin/apt-get -d -y upgrade --with-new-pkgs ${PAIR.join(" ")} && /usr/bin/apt-get ${CONFOLD.join(" ")} ${PAIR.join(" ")} ${PINNED}`,
		);
		expect(() =>
			validateDetachedAptServiceIdentity(unit(script)),
		).not.toThrow();
		// A unit an earlier backend launched without them is still adopted.
		withImageSource();
		const plain = `/usr/bin/apt-get -d -y upgrade --with-new-pkgs && /usr/bin/apt-get ${CONFOLD.join(" ")} ${PINNED}`;
		expect(() => validateDetachedAptServiceIdentity(unit(plain))).not.toThrow();
	});

	const install = (...middle: string[]) => [
		"/usr/bin/apt-get",
		...CONFOLD,
		...middle,
		"install",
		"modemmanager=1.24.2-2~ceralive.3+osb3",
	];
	it.each([
		[
			"another source file",
			[
				"-o",
				"Dir::Etc::SourceList=/etc/apt/sources.list.d/other.sources",
				PAIR[2] ?? "",
				PAIR[3] ?? "",
			],
		],
		[
			"source parts left on",
			[
				PAIR[0] ?? "",
				PAIR[1] ?? "",
				"-o",
				"Dir::Etc::SourceParts=/etc/apt/sources.list.d",
			],
		],
		["the pair twice", [...PAIR, ...PAIR]],
		["the pair before the family", [...PAIR, "-o", "Acquire::ForceIPv4=true"]],
		[
			"the parts before the list",
			[PAIR[2] ?? "", PAIR[3] ?? "", PAIR[0] ?? "", PAIR[1] ?? ""],
		],
		[
			"another option beside it",
			[...PAIR, "-o", "APT::Get::AllowUnauthenticated=true"],
		],
		["only the list", [PAIR[0] ?? "", PAIR[1] ?? ""]],
	])("launch refuses %s", (_label, middle) => {
		withImageSource();
		const argv = install(...middle);
		expect(isExpectedAptAllInstallArgv(argv)).toBe(false);
		expect(() => expectedAptAllScript(argv.slice(1), [])).toThrow();
	});

	it("launch accepts exactly the pair, after the family", () => {
		withImageSource();
		expect(isExpectedAptAllInstallArgv(install(...PAIR))).toBe(true);
		expect(
			isExpectedAptAllInstallArgv(
				install("-o", "Acquire::ForceIPv6=true", ...PAIR),
			),
		).toBe(true);
	});

	it("adoption refuses a download stage that reads another source", () => {
		withImageSource();
		const installStage = `/usr/bin/apt-get ${CONFOLD.join(" ")} ${PAIR.join(" ")} ${PINNED}`;
		for (const download of [
			"-o Dir::Etc::SourceList=/etc/apt/sources.list.d/other.sources -o Dir::Etc::SourceParts=/dev/null",
			"",
		])
			expect(() =>
				validateDetachedAptServiceIdentity(
					unit(
						`/usr/bin/apt-get -d -y upgrade --with-new-pkgs${download ? ` ${download}` : ""} && ${installStage}`,
					),
				),
			).toThrow();
	});

	it("without the record, neither launch nor adoption accepts the pair", () => {
		withoutImageSource();
		expect(isExpectedAptAllInstallArgv(install(...PAIR))).toBe(false);
		expect(() =>
			validateDetachedAptServiceIdentity(
				unit(
					`/usr/bin/apt-get -d -y upgrade --with-new-pkgs ${PAIR.join(" ")} && /usr/bin/apt-get ${CONFOLD.join(" ")} ${PAIR.join(" ")} ${PINNED}`,
				),
			),
		).toThrow();
	});
});

describe("the record's URI goes through the URL parser too", () => {
	it.each([
		["a port out of range", `https://${HOST}:99999/${TOKEN}/apt/`],
		["a zero-padded port", `https://${HOST}:08443/${TOKEN}/apt/`],
	])("refuses %s", (_label, uri) => {
		expect(
			parseImageAptSource(POLICY, () => SOURCES.replace(`${URI}/`, uri)).kind,
		).toBe("invalid");
	});

	it("reads an explicit default port as apt and the probes do", () => {
		expect(
			parseImageAptSource(POLICY, () =>
				SOURCES.replace(`${URI}/`, `https://${HOST}:443/${TOKEN}/apt/`),
			).kind,
		).toBe("active");
	});
});

// The orchestrator with an offer of one emergency fix.
function orchestrator(wire: () => UpdateState, beforeLaunch = false) {
	const counts = { installs: 0, osChecks: 0 };
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			quarantine: testQuarantine(),
			packageFailedBeforeLaunch: () => beforeLaunch,
			stopPackageInstallUnit: async () => {},
			loadCapabilities: async () => ({
				mode: "capable",
				features: ["apt-all-packages", "rauc-verity-streaming"],
			}),
			checkOsManifest: async () => {
				counts.osChecks++;
				return {
					available: false,
					rateLimited: false,
					failed: false,
					reason: "",
				};
			},
			getPackageInstallWireState: wire,
			startPackageInstall: () => {
				counts.installs++;
				return { started: true };
			},
		}),
	);
	return counts;
}
const offer: UpdateState = {
	kind: "available",
	identity: { version: "emergency", packages: ["modemmanager"] },
	package_count: 1,
	actionable_count: 1,
	packages: [
		{ name: "modemmanager", origin: HOST, layer: "app", actionable: true },
	],
};
const openClock = () => {
	clockDir = mkdtempSync(join(tmpdir(), "image-apt-clock-"));
	const flag = join(clockDir, "clock-gate-open");
	Bun.write(flag, "");
	setImageClockGateFlagForTest(flag);
};

describe("an install that never launched is one failure origin", () => {
	const refused = {
		...initialOrchestratorState(0),
		phase: "failed" as const,
		enteredAt: 3,
		failureReason: PACKAGE_INSTALL_REFUSED,
	};

	it("enters failed with the package check due now", () => {
		const next = reduceOrchestrator(
			{ ...initialOrchestratorState(0), phase: "downloading" },
			{ type: "DOWNLOAD_FAILED", now: 5, reason: PACKAGE_INSTALL_REFUSED },
		);
		expect(next).toMatchObject({
			phase: "failed",
			failureReason: PACKAGE_INSTALL_REFUSED,
			packageCheck: { nextAttemptAt: 5 },
		});
	});

	it.each(["PACKAGE_CHECK_STARTED", "OS_CHECK_STARTED"] as const)(
		"%s leaves it as it would leave idle",
		(type) => {
			const next = reduceOrchestrator(refused, { type, now: 6 });
			expect(next.phase).toBe("checking");
			expect(next.failureReason).toBeNull();
		},
	);

	it.each(["PACKAGE_CHECK_STARTED", "OS_CHECK_STARTED"] as const)(
		"%s leaves any other failure alone",
		(type) => {
			const other = { ...refused, failureReason: "discovery_failed" };
			expect(reduceOrchestrator(other, { type, now: 6 })).toBe(other);
		},
	);

	it("a manual check may start from it, and from no other failure", () => {
		expect(canStartManualCheck("failed", PACKAGE_INSTALL_REFUSED)).toBe(true);
		expect(canStartManualCheck("failed", "discovery_failed")).toBe(false);
		expect(canStartManualCheck("failed")).toBe(false);
	});

	it("without the record, an install failure keeps its own reason", async () => {
		withoutImageSource();
		orchestrator(() => ({ kind: "failed", reason: "discovery_failed" }), true);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
		});
		await runOrchestratorTick();
		expect(getOrchestratorState()).toMatchObject({
			phase: "failed",
			failureReason: "discovery_failed",
		});
	});
});

describe("an uncertain submission is a launch", () => {
	const install = [
		...CONFOLD,
		...PAIR,
		"install",
		"modemmanager=1.24.2-2~ceralive.3+osb3",
	];
	// systemd-run's client fails; what PID 1 shows next decides.
	const deps = (after: (() => Promise<DetachedAptServiceState>)[]) => {
		let inspected = 0;
		return {
			outputPaths: OUTPUT,
			prepareOutput: async () => {},
			start: async () => {
				throw new Error("systemd-run: Connection timed out");
			},
			// The first look (before submitting) finds nothing.
			inspect: async () =>
				inspected++ === 0
					? { kind: "absent" as const }
					: (
							(after[inspected - 2] ??
								after.at(-1)) as () => Promise<DetachedAptServiceState>
						)(),
			cleanup: async () => {},
			readOutput: async (_file: string, offset: number) => ({
				bytes: new Uint8Array(),
				nextOffset: offset,
			}),
			sleep: async () => {},
		};
	};
	const finished = async () =>
		({ kind: "finished", exitCode: 0, cleanup: "stop" }) as const;

	it("a unit PID 1 owns is observed to its end", async () => {
		withImageSource();
		let launched = false;
		await expect(
			runDetachedAptAll(
				install,
				"any",
				{
					onStdout: () => {},
					onStderr: () => {},
					onLaunched: () => {
						launched = true;
					},
				},
				deps([async () => ({ kind: "running" }), finished]),
			),
		).resolves.toBe(0);
		expect(launched).toBe(true);
	});

	it("an unreadable unit state is treated as launched", async () => {
		withImageSource();
		let launched = false;
		await expect(
			runDetachedAptAll(
				install,
				"any",
				{
					onStdout: () => {},
					onStderr: () => {},
					onLaunched: () => {
						launched = true;
					},
				},
				deps([
					async () => {
						throw new Error("systemctl: bus unavailable");
					},
					finished,
				]),
			),
		).resolves.toBe(0);
		expect(launched).toBe(true);
	});

	it("no unit after the error is a refused start", async () => {
		withImageSource();
		let launched = false;
		await expect(
			runDetachedAptAll(
				install,
				"any",
				{
					onStdout: () => {},
					onStderr: () => {},
					onLaunched: () => {
						launched = true;
					},
				},
				deps([async () => ({ kind: "absent" })]),
			),
		).rejects.toThrow("systemd-run: Connection timed out");
		expect(launched).toBe(false);
	});

	it("without the record, the client error stays the outcome", async () => {
		withoutImageSource();
		await expect(
			runDetachedAptAll(
				[...CONFOLD, "install", "modemmanager=1.24.2-2~ceralive.3+osb3"],
				"any",
				{ onStdout: () => {}, onStderr: () => {} },
				deps([async () => ({ kind: "running" })]),
			),
		).rejects.toThrow("systemd-run: Connection timed out");
	});
});

describe("launch needs the source pair on an image with its own source", () => {
	it("refuses to build an install unit without it", () => {
		withImageSource();
		const bare = [
			...CONFOLD,
			"install",
			"modemmanager=1.24.2-2~ceralive.3+osb3",
		];
		expect(() => buildDetachedAptAllCommand(bare, "any", OUTPUT)).toThrow(
			InvalidDetachedAptUpgradeArgumentsError,
		);
		expect(() =>
			buildDetachedAptUpgradeCommand(
				[
					"-y",
					"-o",
					"Dpkg::Options::=--force-confdef",
					"-o",
					"Dpkg::Options::=--force-confold",
					"install",
					"cerastream",
				],
				OUTPUT,
			),
		).toThrow(InvalidDetachedAptUpgradeArgumentsError);
		// With it, the unit is built.
		expect(() =>
			buildDetachedAptAllCommand(
				buildAptAllInstallArgs(PIN, "any"),
				"any",
				OUTPUT,
			),
		).not.toThrow();
	});

	it("without the record, builds as before", () => {
		withoutImageSource();
		expect(() =>
			buildDetachedAptUpgradeCommand(
				[
					"-y",
					"-o",
					"Dpkg::Options::=--force-confdef",
					"-o",
					"Dpkg::Options::=--force-confold",
					"install",
					"cerastream",
				],
				OUTPUT,
			),
		).not.toThrow();
		const bare = [
			...CONFOLD,
			"install",
			"modemmanager=1.24.2-2~ceralive.3+osb3",
		];
		expect(() => buildDetachedAptAllCommand(bare, "any", OUTPUT)).not.toThrow();
	});
});

describe("a queued plan is not a request", () => {
	it("a persisted plan is dropped at startup, and discovery runs again", () => {
		const persisted = {
			...initialOrchestratorState(0),
			phase: "awaiting-idle" as const,
		};
		expect(normalizeStartupDiscovery(persisted, 9, true)).toMatchObject({
			phase: "idle",
			packageCheck: { nextAttemptAt: 9 },
		});
		expect(normalizeStartupDiscovery(persisted, 9, false)).toBe(persisted);
	});

	it("a queued plan without a request in this process never launches", async () => {
		withImageSource();
		openClock();
		const counts = orchestrator(() => offer);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "awaiting-idle",
		});
		await runOrchestratorTick();
		expect(counts.installs).toBe(0);
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
	});

	it("a manual install that could not start yet is retried as the same request", async () => {
		withImageSource();
		openClock();
		let refusals = 1;
		const counts = { installs: 0 };
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				quarantine: testQuarantine(),
				getPackageInstallWireState: () => offer,
				startPackageInstall: () => {
					counts.installs++;
					return refusals-- > 0
						? { started: false, reason: "already_updating" }
						: { started: true };
				},
			}),
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "available",
		});
		expect(await installUpdatesNow({ scope: "packages" })).toEqual({
			started: false,
			reason: "busy",
		});
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
		await runOrchestratorTick();
		expect(counts.installs).toBe(2);
		expect(getOrchestratorState().phase).toBe("downloading");
	});

	it("without the record, a persisted plan still launches", async () => {
		withoutImageSource();
		const counts = orchestrator(() => offer);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "awaiting-idle",
		});
		await runOrchestratorTick();
		expect(counts.installs).toBe(1);
	});
});

describe("repository answers are not captive portals", () => {
	const select = (sources: string) =>
		selectUpdateTransport(
			{ profile: "apt", board: "apt", channel: "stable" },
			{
				listIfnames: () => ["eth0"],
				readSources: async () => sources,
				credentials: async () => undefined,
				mmIfnames: () => [],
				routerIfnames: () => [],
				dongleIfnames: () => [],
				run: async (argv) => {
					if (argv[0] === "nmcli")
						return {
							exitCode: 0,
							stdout:
								"GENERAL.DEVICE:eth0\nGENERAL.IP-IFACE:eth0\nGENERAL.TYPE:ethernet\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:no",
							stderr: "",
						};
					if (argv[0] === "resolvectl")
						return argv.includes("-6")
							? { exitCode: 1, stdout: "", stderr: "" }
							: {
									exitCode: 0,
									stdout: `${argv.at(-1)}: 192.0.2.10`,
									stderr: "",
								};
					if (argv[0] === "openssl")
						return { exitCode: 0, stdout: "", stderr: "" };
					// Verified TLS, and the repository answers 403.
					return {
						exitCode: 0,
						stdout: "\n<<<update-probe>>>403 0.05",
						stderr: "",
					};
				},
			},
		);

	it("a 403 from the image's host over verified TLS is unreachable", async () => {
		withImageSource();
		const selection = await select(SOURCES);
		const rows = selection.ranked
			.filter((row) => row.family === 4)
			.flatMap((row) => row.hosts);
		expect(rows.map(({ host, state }) => `${host} ${state}`)).toEqual([
			`${HOST} no-route`,
			`${HOST} no-route`,
		]);
	});

	it("without the record, other sources keep today's verdict", async () => {
		withoutImageSource();
		const selection = await select(
			"Types: deb\nURIs: https://deb.debian.org/debian\nSuites: trixie\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n",
		);
		const debian = selection.ranked
			.filter((row) => row.family === 4)
			.flatMap((row) => row.hosts)
			.filter(({ host }) => host.startsWith("https://deb.debian.org"));
		expect(debian.map(({ state }) => state)).toEqual(["captive-http"]);
	});
});
