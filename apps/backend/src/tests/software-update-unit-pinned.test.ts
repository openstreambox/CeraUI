import { expect, test } from "bun:test";
import { buildAptAllInstallArgs } from "../modules/system/apt-all-packages.ts";
import { softwareUpdateOutputPaths } from "../modules/system/software-update-output.ts";
import {
	type DetachedAptUpgradeDeps,
	recoverDetachedAptUpgrade,
	runDetachedAptAll,
} from "../modules/system/software-update-process.ts";
import { isSoftwareUpdateRecoveryInconclusive } from "../modules/system/software-update-recovery.ts";
import {
	buildDetachedAptAllCommand,
	buildDetachedAptUpgradeCommand,
} from "../modules/system/software-update-service.ts";
import {
	DetachedAptServiceCommandError,
	SOFTWARE_UPDATE_UNIT,
	validateDetachedAptServiceFragment,
} from "../modules/system/software-update-service-contract.ts";
import { parseDetachedAptServiceProbe } from "../modules/system/software-update-service-state.ts";
import {
	getLastInstallUnitVerdict,
	recoverSoftwareUpdateIfRunning,
} from "../modules/system/software-updates.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

/*
  On an image whose shutdown drain names ceralive-software-update.service in
  After=, systemd keeps the stopped transient unit loaded (inactive/dead) after
  CeraUI's cleanup stop. CeraUI exits after a finished package install; the next
  start's recovery probe then read that state as unrecognized and retried every
  3 s until a reboot, and a second install in the same boot could not start its
  unit ("already loaded or has a fragment file"). Seen on ROCK 5B+ boards on
  image 6.1 and 6.2 (systemd 257.13). These replay that sequence on a modelled
  systemd: a stopped transient unit stays loaded only while another loaded unit
  names it; its own Before= never keeps it.
*/

const install = buildAptAllInstallArgs(
	[{ name: "ceralive-device", version: "2026.11.6" }],
	"any",
);
const execStart = (status: "running" | "exited") =>
	`ExecStart={ path=/usr/bin/flock ; argv[]=/usr/bin/flock -x /run/lock/ceralive-update.lock /bin/sh -ec /usr/bin/apt-get -d -y upgrade --with-new-pkgs && /usr/bin/apt-get ${install.join(" ")} ; ignore_errors=no ; start_time=[Wed 2026-11-26 07:20:01 UTC] ; stop_time=[${status === "running" ? "n/a" : "Wed 2026-11-26 07:21:12 UTC"}] ; pid=4242 ; code=${status === "running" ? "(null)" : "exited"} ; status=${status === "running" ? "0/0" : "0/SUCCESS"} }`;

// The transient file systemd 257 writes for a systemd-run request: one write
// per property in the order systemd-run sends them (Description, each
// --property, then the service settings), with a section header whenever the
// section changes. Checked against a file captured on a board below.
const UNIT_SECTION_KEYS = new Set(["Before", "After", "Wants", "Requires"]);
function transientFragment(argv: readonly string[]): string {
	const end = argv.indexOf("--");
	const options = argv.slice(0, end);
	const value = (prefix: string) =>
		options
			.filter((arg) => arg.startsWith(prefix))
			.map((arg) => arg.slice(prefix.length));
	const writes: [string, string][] = value("--description=").map((d) => [
		"Unit",
		`Description=${d}`,
	]);
	for (const property of value("--property="))
		writes.push([
			UNIT_SECTION_KEYS.has(property.slice(0, property.indexOf("=")))
				? "Unit"
				: "Service",
			property,
		]);
	if (options.includes("--remain-after-exit"))
		writes.push(["Service", "RemainAfterExit=yes"]);
	for (const type of value("--service-type="))
		writes.push(["Service", `Type=${type}`]);
	for (const env of value("--setenv="))
		writes.push(["Service", `Environment="${env}"`]);
	writes.push(["Service", "ExecStart="]);
	writes.push([
		"Service",
		`ExecStart=:${argv
			.slice(end + 1)
			.map((arg) => `"${arg}"`)
			.join(" ")}`,
	]);
	let file =
		"# This is a transient unit file, created programmatically via the systemd API. Do not edit.\n";
	let section = "";
	for (const [name, line] of writes) {
		if (name !== section) file += `${section ? "\n" : ""}[${name}]\n`;
		section = name;
		file += `${line}\n`;
	}
	return file;
}

type UnitState = {
	active: "active" | "inactive";
	sub: "running" | "exited" | "dead";
	job: string;
	exited: boolean;
};

function render(unit: UnitState | null): string {
	if (unit === null)
		return `Id=${SOFTWARE_UPDATE_UNIT}\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nJob=\n`;
	return [
		`Id=${SOFTWARE_UPDATE_UNIT}`,
		`FragmentPath=/run/systemd/transient/${SOFTWARE_UPDATE_UNIT}`,
		"Description=CeraLive software update",
		"LoadState=loaded",
		`ActiveState=${unit.active}`,
		`SubState=${unit.sub}`,
		`Job=${unit.job}`,
		"Transient=yes",
		"Type=exec",
		"RemainAfterExit=yes",
		"User=",
		`ExecMainCode=${unit.exited ? 1 : 0}`,
		"ExecMainStatus=0",
		execStart(unit.exited ? "exited" : "running"),
		"StandardOutput=append",
		"StandardError=append",
		"",
	].join("\n");
}

function modelledSystemd(drainAfter: readonly string[]) {
	let unit: UnitState | null = null;
	let fragment = "";
	let polls = 0;
	const launches: (readonly string[])[] = [];
	const stops: string[] = [];
	const command = ["systemctl", "show", SOFTWARE_UPDATE_UNIT];
	const deps: DetachedAptUpgradeDeps = {
		outputPaths: softwareUpdateOutputPaths(),
		prepareOutput: async () => {},
		start: async (argv) => {
			// systemd refuses a transient unit whose name is still loaded.
			if (unit !== null)
				throw new DetachedAptServiceCommandError(
					argv,
					1,
					`Failed to start transient service unit: Unit ${SOFTWARE_UPDATE_UNIT} was already loaded or has a fragment file.`,
				);
			launches.push(argv);
			fragment = transientFragment(argv);
			unit = { active: "active", sub: "running", job: "", exited: false };
		},
		// As inspectService: a loaded unit's transient file is checked too.
		inspect: async () => {
			const state = parseDetachedAptServiceProbe(
				{ exitCode: 0, stdout: render(unit), stderr: "" },
				command,
			);
			if (state.kind !== "absent" || state.loaded)
				validateDetachedAptServiceFragment(fragment);
			return state;
		},
		cleanup: async (state) => {
			stops.push(state.cleanup);
			if (unit === null) throw new Error("cleanup of an absent unit");
			unit = { ...unit, active: "inactive", sub: "dead" };
			// The transient unit's own Before= goes with it; another loaded unit's
			// After= naming it keeps it loaded.
			if (!drainAfter.includes(SOFTWARE_UPDATE_UNIT)) unit = null;
		},
		readOutput: async (_path, offset) => ({
			bytes: new Uint8Array(),
			nextOffset: offset,
		}),
		sleep: async () => {
			// A unit CeraUI can't read (a refused transient file) keeps the
			// observer retrying; on a box that never ends.
			if (++polls > 50) throw new Error("observer kept polling");
			// apt-get finishes on the observer's first poll.
			if (unit?.sub === "running")
				unit = { ...unit, sub: "exited", exited: true };
		},
	};
	return {
		deps,
		launches,
		stops,
		queueStartJob: () => {
			if (unit) unit = { ...unit, job: "4711" };
		},
	};
}

const handlers = { onStdout: () => {}, onStderr: () => {} };
// The image 6.x drain and the drain this change pairs with.
const pinningDrain = [
	"rauc.service",
	SOFTWARE_UPDATE_UNIT,
	"ceralive-slot-sync.service",
];
const fixedDrain = ["rauc.service", "ceralive-slot-sync.service"];

function recoverAfterRestart(deps: DetachedAptUpgradeDeps) {
	const retries: (() => void)[] = [];
	const recovered = recoverSoftwareUpdateIfRunning({
		recover: (h) => recoverDetachedAptUpgrade(h, deps),
		scheduleRetry: (retry) => retries.push(retry),
		resumePeriodicChecks: () => {},
	});
	return { recovered, retries };
}

test("the restart after an install finds the pinned stopped unit settled, with no retry loop", async () => {
	await using _h = await updateHarness();
	// Given an install that finished on an image whose drain names the unit.
	const systemd = modelledSystemd(pinningDrain);
	expect(await runDetachedAptAll(install, "any", handlers, systemd.deps)).toBe(
		0,
	);
	expect(systemd.stops).toEqual(["stop"]);
	// When CeraUI restarts and recovery probes the unit.
	const { recovered, retries } = recoverAfterRestart(systemd.deps);
	// Then nothing is attached, no retry is scheduled and power actions are free.
	expect(await recovered).toBe(false);
	expect(retries).toHaveLength(0);
	expect(isSoftwareUpdateRecoveryInconclusive()).toBe(false);
	expect(getLastInstallUnitVerdict()).toBe("absent");
});

test("a second install in that boot is refused by name, without a systemd-run", async () => {
	// Given the same boot after the first install.
	const systemd = modelledSystemd(pinningDrain);
	await runDetachedAptAll(install, "any", handlers, systemd.deps);
	// When a second install starts.
	const second = runDetachedAptAll(install, "any", handlers, systemd.deps);
	// Then it is refused as pinned, and no second transient unit is requested.
	await expect(second).rejects.toMatchObject({
		name: "DetachedAptServicePinnedError",
	});
	expect(systemd.launches).toHaveLength(1);
});

test("with the drain no longer naming the unit, a second install in the same boot runs", async () => {
	// Given an image whose drain leaves the ordering to the unit itself.
	const systemd = modelledSystemd(fixedDrain);
	await runDetachedAptAll(install, "any", handlers, systemd.deps);
	// When a second install starts in the same boot.
	expect(await runDetachedAptAll(install, "any", handlers, systemd.deps)).toBe(
		0,
	);
	// Then both ran, each ordered before the drain so a shutdown still waits.
	expect(systemd.launches).toHaveLength(2);
	for (const argv of systemd.launches) {
		expect(argv.slice(0, argv.indexOf("--"))).toContain(
			"--property=Before=ceralive-write-drain.service",
		);
	}
});

test("a stopped unit with a queued job is still unrecognized and retried", async () => {
	await using _h = await updateHarness();
	// Given a stopped, pinned unit that a start job is queued for.
	const systemd = modelledSystemd(pinningDrain);
	await runDetachedAptAll(install, "any", handlers, systemd.deps);
	systemd.queueStartJob();
	// When recovery probes it.
	const { recovered, retries } = recoverAfterRestart(systemd.deps);
	// Then it fails closed and asks again later.
	await expect(recovered).rejects.toThrow(/unrecognized.*inactive\/dead/);
	expect(retries).toHaveLength(1);
});

// systemd 257.13 on a ROCK 5B+ (image 6.2), for the command with Before= sent
// after the output paths: two [Service] sections.
const boardFragment = `# This is a transient unit file, created programmatically via the systemd API. Do not edit.
[Unit]
Description=CeraLive software update

[Service]
StandardOutput=append:/run/ceralive/software-update.stdout
StandardError=append:/run/ceralive/software-update.stderr

[Unit]
Before=ceralive-write-drain.service

[Service]
RemainAfterExit=yes
Type=exec
Environment="LC_ALL=C"
ExecStart=
ExecStart=:"/usr/bin/apt-get" "-y" "-o" "Dpkg::Options::=--force-confdef" "-o" "Dpkg::Options::=--force-confold" "install" "srtla"
`;
const directArgs = [
	"-y",
	"-o",
	"Dpkg::Options::=--force-confdef",
	"-o",
	"Dpkg::Options::=--force-confold",
	"install",
	"srtla",
];

test("the transient file of either command form passes CeraUI's own fragment check", () => {
	// Given the modelled writer reproduces the board's file for Before= sent late.
	const direct = buildDetachedAptUpgradeCommand(
		directArgs,
		softwareUpdateOutputPaths(),
	);
	const before = "--property=Before=ceralive-write-drain.service";
	const late = direct.filter((arg) => arg !== before);
	late.splice(late.indexOf("--"), 0, before);
	expect(transientFragment(late)).toBe(boardFragment);
	expect(() => validateDetachedAptServiceFragment(boardFragment)).toThrow(
		"Service section is duplicated",
	);
	// When the units are written for the commands CeraUI sends.
	const all = buildDetachedAptAllCommand(
		install,
		"any",
		softwareUpdateOutputPaths(),
	);
	// Then each file has one [Service] section and is adopted.
	for (const argv of [direct, all]) {
		const file = transientFragment(argv);
		expect(file.match(/^\[Service\]$/gm)).toHaveLength(1);
		expect(() => validateDetachedAptServiceFragment(file)).not.toThrow();
	}
});
