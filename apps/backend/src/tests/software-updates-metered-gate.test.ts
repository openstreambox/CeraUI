/*
 * The automatic hourly package check must not refresh the apt indices over an
 * uplink that is metered only, unless packages may use cellular. The first
 * refresh after a boot downloads every index again (the lists are in tmpfs),
 * which on a Debian trixie arm64 box is about 14 MB.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSettingsSchema } from "@ceraui/rpc/schemas";
import type { SpawnWithTimeoutResult } from "../helpers/spawn-policy.ts";
import {
	METERED_RECHECK_DELAY_MS,
	packageCheckMayUseUplinks,
	periodicCheckForSoftwareUpdates,
	resetSoftwareUpdateCheckRunner,
	setPeriodicUplinkGateForTest,
	setSoftwareUpdateCheckRunner,
} from "../modules/system/software-updates.ts";
import { setUpdateSettingsFilePathForTest } from "../modules/system/update-settings.ts";
import {
	defaultUpdateTransportDeps,
	onlyMeteredUplinksRemain,
} from "../modules/system/update-transport/executor.ts";

const settleGate = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("periodicCheckForSoftwareUpdates() — metered uplink gate", () => {
	let clock: ReturnType<typeof jest.spyOn>;
	let seconds: number;
	let nanoseconds: number;
	// The scheduler keeps its deadline across tests; start each one past the last.
	let offset = 0;

	beforeEach(() => {
		[seconds, nanoseconds] = process.hrtime();
		offset += 7200;
		seconds += offset;
		jest.useFakeTimers();
		// Fake timers reset hrtime; keep the scheduler's deadline in reach.
		clock = jest
			.spyOn(process, "hrtime")
			.mockReturnValue([seconds, nanoseconds]);
	});

	afterEach(() => {
		resetSoftwareUpdateCheckRunner();
		setPeriodicUplinkGateForTest(null);
		jest.restoreAllMocks();
		jest.useRealTimers();
	});

	it("waits without running apt when the gate refuses, and looks again later", async () => {
		const runner = jest.fn(() => true);
		setSoftwareUpdateCheckRunner(runner);
		const gate = jest.fn(async () => false);
		setPeriodicUplinkGateForTest(gate);
		const schedule = jest.spyOn(globalThis, "setTimeout");

		periodicCheckForSoftwareUpdates();
		await settleGate();

		expect(gate).toHaveBeenCalledTimes(1);
		expect(runner).not.toHaveBeenCalled();
		expect(schedule).toHaveBeenCalledWith(
			periodicCheckForSoftwareUpdates,
			METERED_RECHECK_DELAY_MS,
		);
	});

	it("runs the check once a later look finds an unmetered uplink", async () => {
		const runner = jest.fn(() => true);
		setSoftwareUpdateCheckRunner(runner);
		let unmetered = false;
		setPeriodicUplinkGateForTest(async () => unmetered);

		periodicCheckForSoftwareUpdates();
		await settleGate();
		expect(runner).not.toHaveBeenCalled();

		unmetered = true;
		clock.mockReturnValue([
			seconds + METERED_RECHECK_DELAY_MS / 1000,
			nanoseconds,
		]);
		jest.advanceTimersByTime(METERED_RECHECK_DELAY_MS);
		await settleGate();
		expect(runner).toHaveBeenCalledTimes(1);
	});

	it("runs the check at once when the gate allows it", async () => {
		const runner = jest.fn(() => true);
		setSoftwareUpdateCheckRunner(runner);
		setPeriodicUplinkGateForTest(async () => true);

		periodicCheckForSoftwareUpdates();
		await settleGate();

		expect(runner).toHaveBeenCalledTimes(1);
	});

	it("treats a failing gate as a refusal", async () => {
		const runner = jest.fn(() => true);
		setSoftwareUpdateCheckRunner(runner);
		setPeriodicUplinkGateForTest(async () => {
			throw new Error("nmcli exploded");
		});
		const schedule = jest.spyOn(globalThis, "setTimeout");

		periodicCheckForSoftwareUpdates();
		await settleGate();

		expect(runner).not.toHaveBeenCalled();
		expect(schedule).toHaveBeenCalledWith(
			periodicCheckForSoftwareUpdates,
			METERED_RECHECK_DELAY_MS,
		);
	});

	it("asks the gate once while a decision is pending", async () => {
		const runner = jest.fn(() => true);
		setSoftwareUpdateCheckRunner(runner);
		let release: (allowed: boolean) => void = () => {};
		const gate = jest.fn(
			() =>
				new Promise<boolean>((resolve) => {
					release = resolve;
				}),
		);
		setPeriodicUplinkGateForTest(gate);

		periodicCheckForSoftwareUpdates();
		// A stream stop calls the loop again while the first decision is open.
		periodicCheckForSoftwareUpdates();
		release(true);
		await settleGate();

		expect(gate).toHaveBeenCalledTimes(1);
		expect(runner).toHaveBeenCalledTimes(1);
	});
});

describe("packageCheckMayUseUplinks()", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "metered-gate-"));
	});

	afterEach(() => {
		setUpdateSettingsFilePathForTest(null);
		rmSync(dir, { recursive: true, force: true });
	});

	it("allows any uplink when packages may use cellular, without asking NetworkManager", async () => {
		const file = join(dir, "update-settings.json");
		writeFileSync(
			file,
			JSON.stringify({
				...updateSettingsSchema.parse({}),
				allowPackagesOverCellular: true,
			}),
		);
		// The sidecar marks the file as migrated, so the load does not rewrite it.
		writeFileSync(
			join(dir, "update-image-channel.json"),
			JSON.stringify({
				schema: 1,
				channel: "stable",
				allowSystemDownloadsOverCellular: false,
			}),
		);
		setUpdateSettingsFilePathForTest(file);
		const run = jest.spyOn(defaultUpdateTransportDeps, "run");

		expect(await packageCheckMayUseUplinks()).toBe(true);
		expect(run).not.toHaveBeenCalled();
		run.mockRestore();
	});
});

describe("onlyMeteredUplinksRemain()", () => {
	const deps = (
		stdout: string,
		options: { exitCode?: number; modems?: string[]; throws?: boolean } = {},
	) => ({
		...defaultUpdateTransportDeps,
		listIfnames: () => ["eth0", "wlan0", "wwan0"],
		mmIfnames: () => options.modems ?? ["wwan0"],
		routerIfnames: () => [],
		dongleIfnames: () => [],
		run: async (): Promise<SpawnWithTimeoutResult> => {
			if (options.throws) throw new Error("spawn failed");
			return { exitCode: options.exitCode ?? 0, stdout, stderr: "" };
		},
	});

	const row = (device: string, type: string, metered: string) =>
		`GENERAL.DEVICE:${device}\nGENERAL.TYPE:${type}\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:${metered}\n`;

	it("is true when the only connected uplink is a modem", async () => {
		expect(
			await onlyMeteredUplinksRemain(deps(row("wwan0", "gsm", "yes"))),
		).toBe(true);
	});

	it("is false when Ethernet or Wi-Fi is unmetered beside the modem", async () => {
		expect(
			await onlyMeteredUplinksRemain(
				deps(
					`${row("wwan0", "gsm", "yes (guessed)")}\n${row("eth0", "ethernet", "no (guessed)")}`,
				),
			),
		).toBe(false);
	});

	it("counts a phone hotspot that NetworkManager marks metered as metered", async () => {
		expect(
			await onlyMeteredUplinksRemain(
				deps(row("wlan0", "wifi", "yes (guessed)"), { modems: [] }),
			),
		).toBe(true);
	});

	it("is true when NetworkManager cannot be read", async () => {
		expect(await onlyMeteredUplinksRemain(deps("", { exitCode: 8 }))).toBe(
			true,
		);
		expect(await onlyMeteredUplinksRemain(deps("", { throws: true }))).toBe(
			true,
		);
	});
});
