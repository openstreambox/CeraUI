/*
 * The automatic hourly package check must not refresh the apt indices over an
 * uplink that is metered only, unless packages may use cellular. The first
 * refresh after a boot downloads every index again (the lists are in tmpfs),
 * which on a Debian trixie arm64 box is about 14 MB.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSettingsSchema } from "@ceraui/rpc/schemas";
import { logger } from "../helpers/logger.ts";
import type { SpawnWithTimeoutResult } from "../helpers/spawn-policy.ts";
import {
	METERED_RECHECK_DELAY_MS,
	packageCheckMayUseUplinks,
	periodicCheckForSoftwareUpdates,
	resetAptReachabilityProbeForTest,
	resetSoftwareUpdateCheckRunner,
	resetSoftwareUpdateSizeRunner,
	SKIP_RETRY_DELAY_MS,
	type SoftwareUpdateError,
	setAptReachabilityProbeForTest,
	setPeriodicUplinkGateForTest,
	setSoftwareUpdateCheckRunner,
	setSoftwareUpdateSizeRunner,
} from "../modules/system/software-updates.ts";
import {
	readPackageCellularConsent,
	saveUpdateSettings,
	setUpdateSettingsFilePathForTest,
} from "../modules/system/update-settings.ts";
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

describe("periodicCheckForSoftwareUpdates() — one cycle at a time", () => {
	let offset = 1_000_000;

	afterEach(() => {
		resetSoftwareUpdateCheckRunner();
		resetSoftwareUpdateSizeRunner();
		resetAptReachabilityProbeForTest();
		setPeriodicUplinkGateForTest(null);
		jest.restoreAllMocks();
		jest.useRealTimers();
	});

	function fakeClock() {
		const [seconds, nanoseconds] = process.hrtime();
		offset += 7200;
		jest.useFakeTimers();
		jest
			.spyOn(process, "hrtime")
			.mockReturnValue([seconds + offset, nanoseconds]);
	}

	it("does not start a second refresh while the first is still reporting back", async () => {
		fakeClock();
		setAptReachabilityProbeForTest(async () => ({
			ipv4: "ok",
			ipv6: "ok",
			used: "any",
			verdict: "any",
			detail: [],
		}));
		setSoftwareUpdateSizeRunner(async () => null);
		let report:
			| ((err: SoftwareUpdateError, failures: number) => unknown)
			| undefined;
		const runner = jest.fn(
			(cb: (err: SoftwareUpdateError, failures: number) => unknown) => {
				report = cb;
				return true;
			},
		);
		setSoftwareUpdateCheckRunner(runner);
		const gate = jest.fn(async () => true);
		setPeriodicUplinkGateForTest(gate);

		periodicCheckForSoftwareUpdates();
		await settleGate();
		expect(runner).toHaveBeenCalledTimes(1);

		// A stream stop calls the loop while the first refresh still runs.
		periodicCheckForSoftwareUpdates();
		await settleGate();
		expect(gate).toHaveBeenCalledTimes(1);
		expect(runner).toHaveBeenCalledTimes(1);

		const schedule = jest.spyOn(globalThis, "setTimeout");
		await report?.(null, 0);
		await settleGate();
		const next = schedule.mock.calls.at(-1)?.[1];
		expect(typeof next).toBe("number");
		expect(next as number).toBeGreaterThan(0);

		// Before that deadline another call only re-arms the timer.
		periodicCheckForSoftwareUpdates();
		await settleGate();
		expect(gate).toHaveBeenCalledTimes(1);
		expect(runner).toHaveBeenCalledTimes(1);
	});

	it("releases the loop and retries when the runner throws before it starts", async () => {
		fakeClock();
		const runner = jest.fn(() => {
			throw new Error("broadcast failed");
		});
		setSoftwareUpdateCheckRunner(runner);
		const gate = jest.fn(async () => true);
		setPeriodicUplinkGateForTest(gate);
		const schedule = jest.spyOn(globalThis, "setTimeout");

		periodicCheckForSoftwareUpdates();
		await settleGate();

		expect(runner).toHaveBeenCalledTimes(1);
		expect(schedule).toHaveBeenCalledWith(
			periodicCheckForSoftwareUpdates,
			SKIP_RETRY_DELAY_MS,
		);
	});

	it("keeps a timer when discovery rejects after the refresh", async () => {
		fakeClock();
		let report:
			| ((err: SoftwareUpdateError, failures: number) => unknown)
			| undefined;
		setSoftwareUpdateCheckRunner((cb) => {
			report = cb;
			return true;
		});
		setPeriodicUplinkGateForTest(async () => true);
		setAptReachabilityProbeForTest(async () => {
			throw new Error("probe exploded");
		});
		periodicCheckForSoftwareUpdates();
		await settleGate();
		const schedule = jest.spyOn(globalThis, "setTimeout");

		await report?.(null, 0);
		await settleGate();

		expect(schedule).toHaveBeenCalledWith(
			periodicCheckForSoftwareUpdates,
			expect.any(Number),
		);
	});

	it("logs the wait once per episode", async () => {
		fakeClock();
		setSoftwareUpdateCheckRunner(jest.fn(() => true));
		setPeriodicUplinkGateForTest(async () => false);
		const info = jest.spyOn(logger, "info");
		const [seconds, nanoseconds] = process.hrtime();

		periodicCheckForSoftwareUpdates();
		await settleGate();
		jest
			.spyOn(process, "hrtime")
			.mockReturnValue([
				seconds + METERED_RECHECK_DELAY_MS / 1000,
				nanoseconds,
			]);
		jest.advanceTimersByTime(METERED_RECHECK_DELAY_MS);
		await settleGate();

		const waits = info.mock.calls.filter(([message]) =>
			String(message).startsWith("Automatic package check waits"),
		);
		expect(waits).toHaveLength(1);
	});
});

describe("packageCheckMayUseUplinks()", () => {
	let dir: string;
	let primary: string;
	let sidecar: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "metered-gate-"));
		primary = join(dir, "update-settings.json");
		sidecar = join(dir, "update-image-channel.json");
		setUpdateSettingsFilePathForTest(primary);
	});

	afterEach(() => {
		setUpdateSettingsFilePathForTest(null);
		rmSync(dir, { recursive: true, force: true });
	});

	const settings = (allowPackagesOverCellular: boolean) =>
		JSON.stringify({
			...updateSettingsSchema.parse({}),
			allowPackagesOverCellular,
		});
	const goodSidecar = JSON.stringify({
		schema: 1,
		channel: "stable",
		allowSystemDownloadsOverCellular: false,
	});
	const probe = (onlyMetered: boolean) => jest.fn(async () => onlyMetered);

	it("allows any uplink when packages may use cellular, without asking NetworkManager", async () => {
		writeFileSync(primary, settings(true));
		writeFileSync(sidecar, goodSidecar);
		const onlyMetered = probe(true);
		expect(await packageCheckMayUseUplinks(onlyMetered)).toBe(true);
		expect(onlyMetered).not.toHaveBeenCalled();
	});

	it("follows NetworkManager when packages may not use cellular", async () => {
		writeFileSync(primary, settings(false));
		writeFileSync(sidecar, goodSidecar);
		expect(await packageCheckMayUseUplinks(probe(true))).toBe(false);
		expect(await packageCheckMayUseUplinks(probe(false))).toBe(true);
	});

	it("keeps a refusal when only the image-channel sidecar is corrupt", async () => {
		writeFileSync(primary, settings(false));
		writeFileSync(sidecar, "{not json");
		const onlyMetered = probe(true);
		expect(await packageCheckMayUseUplinks(onlyMetered)).toBe(false);
		expect(onlyMetered).toHaveBeenCalledTimes(1);
	});

	it("requires a confirmed unmetered uplink when the settings file is corrupt", async () => {
		writeFileSync(primary, "{not json");
		expect(await packageCheckMayUseUplinks(probe(true))).toBe(false);
		expect(await packageCheckMayUseUplinks(probe(false))).toBe(true);
		writeFileSync(
			primary,
			JSON.stringify({ allowPackagesOverCellular: "yes" }),
		);
		expect(await packageCheckMayUseUplinks(probe(true))).toBe(false);
	});

	it("uses the factory default only when there is no settings file", async () => {
		const onlyMetered = probe(true);
		expect(await packageCheckMayUseUplinks(onlyMetered)).toBe(
			updateSettingsSchema.parse({}).allowPackagesOverCellular ||
				!(await onlyMetered()),
		);
	});

	it("reads again when a save lands during the read", async () => {
		writeFileSync(primary, settings(true));
		writeFileSync(sidecar, goodSidecar);
		const pending = readPackageCellularConsent(primary);
		saveUpdateSettings(
			{ ...updateSettingsSchema.parse({}), allowPackagesOverCellular: false },
			primary,
		);
		expect(await pending).toBe(false);
	});

	it("never migrates or writes settings", async () => {
		// A pre-sidecar file is what loadUpdateSettings migrates on read.
		const legacy = settings(false);
		writeFileSync(primary, legacy);
		await packageCheckMayUseUplinks(probe(true));
		expect(existsSync(sidecar)).toBe(false);
		expect(readFileSync(primary, "utf8")).toBe(legacy);
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
