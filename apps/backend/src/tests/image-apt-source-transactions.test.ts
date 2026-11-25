/// <reference types="bun" />

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateState } from "@ceraui/rpc/schemas";
import { logger } from "../helpers/logger.ts";
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
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
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
function orchestrator(
	wire: () => UpdateState,
	beforeLaunch = false,
	quarantine = testQuarantine(),
) {
	const counts = { installs: 0, osChecks: 0 };
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			quarantine,
			packageFailedBeforeLaunch: () => beforeLaunch,
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

describe("an install that ended before apt's unit launched", () => {
	it.each<[string, UpdateState]>([
		["dpkg_interrupted", { kind: "failed", reason: "dpkg_interrupted" }],
		["refresh_failed", { kind: "failed", reason: "refresh_failed" }],
		["check_unavailable", { kind: "failed", reason: "check_unavailable" }],
		[
			"an unreachable repository",
			{ kind: "failed", reason: "The software repositories are unreachable." },
		],
		[
			"a captive portal",
			{
				kind: "failed",
				reason: "A captive portal prevented the software update.",
			},
		],
		[
			"a failed refresh",
			{
				kind: "failed",
				reason:
					"Failed to fetch the updated package list; aborting the update.",
			},
		],
		[
			"the space preflight",
			{
				kind: "update_preflight_failed",
				preflight_reason: "insufficient_space",
			},
		],
	])(
		"%s settles as a package result and keeps the image check eligible",
		async (_label, wire) => {
			withImageSource();
			openClock();
			const counts = orchestrator(() => wire, true);
			setOrchestratorStateForTest({
				...initialOrchestratorState(0),
				phase: "downloading",
			});
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("idle");
			expect(getOrchestratorState().failureReason).toBeNull();
			const before = counts.osChecks;
			expect(await checkUpdatesNow()).toEqual({ started: true });
			expect(counts.osChecks).toBe(before + 1);
		},
	);

	it("an apt failure after launch still fails the update", async () => {
		withImageSource();
		openClock();
		orchestrator(
			() => ({
				kind: "failed",
				reason: "discovery_failed",
			}),
			false,
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("failed");
	});

	it("without the record, the same refusal fails the update as before", async () => {
		withoutImageSource();
		orchestrator(() => ({ kind: "failed", reason: "discovery_failed" }), true);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("failed");
	});
});

describe("a release only ever releases the plan it was issued for", () => {
	const at = (phase: "awaiting-idle" | "downloading", enteredAt: number) => ({
		...initialOrchestratorState(0),
		phase,
		enteredAt,
	});
	const release = (
		from: "awaiting-idle" | "downloading",
		enteredAt: number,
	) => ({
		type: "PACKAGE_PLAN_RELEASED" as const,
		now: 5,
		from,
		enteredAt,
		packageAttempt: undefined,
	});

	it("is a no-op once the phase moved on", () => {
		const downloading = at("downloading", 3);
		expect(reduceOrchestrator(downloading, release("awaiting-idle", 3))).toBe(
			downloading,
		);
		const later = at("awaiting-idle", 4);
		expect(reduceOrchestrator(later, release("awaiting-idle", 3))).toBe(later);
	});

	it("releases the current entry", () => {
		expect(
			reduceOrchestrator(at("awaiting-idle", 3), release("awaiting-idle", 3))
				.phase,
		).toBe("idle");
		expect(
			reduceOrchestrator(at("downloading", 3), release("downloading", 3)).phase,
		).toBe("idle");
	});

	it("a manual install during the queued plan's cleanup never gets released", async () => {
		withImageSource();
		openClock();
		// The cleanup's write is held open while the user asks to install.
		const gate = Promise.withResolvers<void>();
		const quarantine = testQuarantine();
		const clear = quarantine.clearPending.bind(quarantine);
		let held = true;
		quarantine.clearPending = async () => {
			if (held) {
				held = false;
				await gate.promise;
			}
			return clear();
		};
		const counts = orchestrator(() => offer, false, quarantine);
		const info = spyOn(logger, "info").mockImplementation(() => logger);
		try {
			setOrchestratorStateForTest({
				...initialOrchestratorState(0),
				phase: "awaiting-idle",
			});
			const tick = runOrchestratorTick();
			await Bun.sleep(0);
			const manual = installUpdatesNow({ scope: "packages" });
			// Long enough for the request to reach its launch decision.
			for (let i = 0; i < 20; i++) await Bun.sleep(1);
			gate.resolve();
			await tick;
			const outcome = await manual;
			// Either the click was held off while the plan went, or its install
			// survived: never a live transaction released to idle.
			if (outcome.started) {
				expect(getOrchestratorState().phase).toBe("downloading");
				expect(counts.installs).toBe(1);
			} else {
				expect(["busy", "not_available"]).toContain(outcome.reason);
				expect(counts.installs).toBe(0);
				expect(getOrchestratorState().phase).toBe("idle");
			}
		} finally {
			info.mockRestore();
		}
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
	it("a persisted plan is dropped, not launched, and discovery runs again", async () => {
		withImageSource();
		openClock();
		const counts = orchestrator(() => offer);
		const info = spyOn(logger, "info").mockImplementation(() => logger);
		try {
			// As a restart restores it.
			setOrchestratorStateForTest({
				...initialOrchestratorState(0),
				phase: "awaiting-idle",
			});
			await runOrchestratorTick();
			expect(counts.installs).toBe(0);
			expect(getOrchestratorState().phase).not.toBe("downloading");
			expect(info.mock.calls.map(([message]) => message)).toContain(
				"Queued package install dropped: the image apt source installs only when asked",
			);
		} finally {
			info.mockRestore();
		}
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
