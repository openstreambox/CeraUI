/*
  While the roaming coordinator runs, the radio that carries the stream is never
  scanned by CeraUI itself. A device-less rescan scans every other radio by
  name; a rescan aimed at the holder scans nothing and leaves its stamp alone.
*/
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { call } from "@orpc/server";

import type { MacAddress } from "../modules/network/network-manager.ts";
import {
	protectRadiosFromScans,
	type RadioMode,
	setScanGateModeReader,
} from "../modules/network/wifi-roaming/scan-gate.ts";
import { withWifiAdapterLock } from "../modules/wifi/wifi-adapter-lock.ts";
import {
	addWifiInterface,
	getWifiScanStampForDevice,
	resetWifiScanStampsForTest,
	setRescanActionForTest,
	setScanRefreshAction,
	setScanResultReaderForTest,
	wifiCancelScanRefresh,
	wifiRescan,
} from "../modules/wifi/wifi-connections.ts";
import type { WifiInterface } from "../modules/wifi/wifi-interfaces.ts";
import { wifiScanProcedure } from "../rpc/procedures/wifi.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const HOLDER: MacAddress = "aa:bb:cc:dd:ee:01";
const SEARCHER: MacAddress = "aa:bb:cc:dd:ee:02";
const THIRD: MacAddress = "aa:bb:cc:dd:ee:03";

function seedRadio(macAddress: MacAddress, id: number, ifname: string): void {
	addWifiInterface(macAddress, {
		id,
		ifname,
		conn: null,
		hw: `radio ${id}`,
		available: new Map(),
		saved: {},
		savedAll: {},
	} as WifiInterface);
}

let inherited: ReturnType<typeof isolateWifiRegistry>;
let spawns: Array<string | undefined>;

beforeEach(() => {
	inherited = isolateWifiRegistry();
	resetWifiScanStampsForTest();
	seedRadio(HOLDER, 0, "wlan0");
	seedRadio(SEARCHER, 1, "wlan1");
	seedRadio(THIRD, 2, "wlan2");
	setScanRefreshAction(() => {});
	setScanResultReaderForTest(() => Promise.resolve(true));
	spawns = [];
	setRescanActionForTest(async (device) => {
		spawns.push(device);
	});
});

afterEach(() => {
	protectRadiosFromScans([]);
	setScanGateModeReader(null);
	wifiCancelScanRefresh();
	restoreWifiRegistry(inherited);
	resetWifiScanStampsForTest();
});

describe("rescans while a radio holds the stream", () => {
	test("without a protected radio a device-less rescan stays device-less", async () => {
		await wifiRescan();
		expect(spawns).toEqual([undefined]);
	});

	test("a device-less rescan scans every other radio by name", async () => {
		protectRadiosFromScans(["wlan0"]);
		await wifiRescan();
		expect(spawns).toEqual(["wlan1", "wlan2"]);
		expect(getWifiScanStampForDevice(0)).toBeUndefined();
		expect(getWifiScanStampForDevice(1)?.generation).toBe(1);
		expect(getWifiScanStampForDevice(2)?.generation).toBe(1);
	});

	test("a rescan aimed at the holder scans nothing", async () => {
		protectRadiosFromScans(["wlan0"]);
		await wifiRescan(0);
		expect(spawns).toEqual([]);
		expect(getWifiScanStampForDevice(0)).toBeUndefined();
	});

	test("two holders are both skipped", async () => {
		protectRadiosFromScans(["wlan0", "wlan2"]);
		await wifiRescan();
		expect(spawns).toEqual(["wlan1"]);
	});

	test("a radio protected while the loop runs is skipped and keeps its stamp", async () => {
		protectRadiosFromScans(["wlan0"]);
		setRescanActionForTest(async (device) => {
			spawns.push(device);
			// The coordinator starts a join on wlan2 while wlan1 scans.
			if (device === "wlan1") protectRadiosFromScans(["wlan0", "wlan2"]);
		});
		await wifiRescan();
		expect(spawns).toEqual(["wlan1"]);
		expect(getWifiScanStampForDevice(1)?.generation).toBe(1);
		expect(getWifiScanStampForDevice(2)).toBeUndefined();
	});

	test("a rescan aimed at another radio is unchanged", async () => {
		protectRadiosFromScans(["wlan0"]);
		await wifiRescan(1);
		expect(spawns).toEqual(["wlan1"]);
		expect(getWifiScanStampForDevice(1)?.generation).toBe(1);
	});
});

describe("rescans checked at dispatch, under the adapter lock", () => {
	/** Each radio on its own phy, none in AP mode, unless overridden. */
	const modes = (over: Record<string, RadioMode | undefined> = {}) => {
		const reads: string[] = [];
		setScanGateModeReader(async (ifname) => {
			reads.push(ifname);
			return ifname in over
				? over[ifname]
				: { phy: `phy-${ifname}`, apOnPhy: false };
		});
		return reads;
	};

	test("a radio that became an AP since the last publication is not scanned", async () => {
		protectRadiosFromScans(["wlan0"], ["phy-wlan0"]);
		modes({ wlan1: { phy: "phy-wlan1", apOnPhy: true } });
		await wifiRescan(1);
		expect(spawns).toEqual([]);
		expect(getWifiScanStampForDevice(1)).toBeUndefined();
	});

	test("a radio on a protected radio's phy is not scanned", async () => {
		protectRadiosFromScans(["wlan0"], ["phy-wlan0"]);
		modes({ wlan2: { phy: "phy-wlan0", apOnPhy: false } });
		await wifiRescan();
		expect(spawns).toEqual(["wlan1"]);
	});

	test("an unreadable mode refuses the scan", async () => {
		protectRadiosFromScans(["wlan0"], ["phy-wlan0"]);
		setScanGateModeReader(async () => {
			throw new Error("iw failed");
		});
		await wifiRescan(1);
		expect(spawns).toEqual([]);
	});

	test("a radio whose adapter lock is held is skipped, not waited for", async () => {
		protectRadiosFromScans(["wlan0"], ["phy-wlan0"]);
		const reads = modes();
		await withWifiAdapterLock(SEARCHER, async () => {
			await wifiRescan(1);
		});
		expect(spawns).toEqual([]);
		expect(reads).toEqual([]);
	});

	test("the mode is read for each radio right before its scan", async () => {
		protectRadiosFromScans(["wlan0"], ["phy-wlan0"]);
		const reads = modes();
		setRescanActionForTest(async (device) => {
			spawns.push(device);
			expect(reads.at(-1)).toBe(device);
		});
		await wifiRescan();
		expect(spawns).toEqual(["wlan1", "wlan2"]);
		expect(reads).toEqual(["wlan1", "wlan2"]);
	});
});

describe("the scan RPC while the gate is active", () => {
	const ctx = (): RPCContext => ({
		ws: {
			send: () => {},
			data: { isAuthenticated: true, lastActive: Date.now() },
		} as unknown as AppWebSocket,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	});

	test("a named scan of an eligible radio really scans it, under the RPC's own lock", async () => {
		protectRadiosFromScans(["wlan0"], ["phy-wlan0"]);
		setScanGateModeReader(async (ifname) => ({
			phy: `phy-${ifname}`,
			apOnPhy: false,
		}));
		expect(
			await call(wifiScanProcedure, { device: "1" }, { context: ctx() }),
		).toEqual({
			success: true,
		});
		expect(spawns).toEqual(["wlan1"]);
		expect(getWifiScanStampForDevice(1)?.generation).toBe(1);
	});

	test("a named scan of a radio that turned into an AP is not dispatched", async () => {
		protectRadiosFromScans(["wlan0"], ["phy-wlan0"]);
		setScanGateModeReader(async (ifname) => ({
			phy: `phy-${ifname}`,
			apOnPhy: ifname === "wlan1",
		}));
		expect(
			await call(wifiScanProcedure, { device: "1" }, { context: ctx() }),
		).toEqual({ success: false, error: "DEVICE_BUSY" });
		expect(spawns).toEqual([]);
	});

	test("a named scan of a protected radio reports that it did not run", async () => {
		protectRadiosFromScans(["wlan0"], ["phy-wlan0"]);
		setScanGateModeReader(async (ifname) => ({
			phy: `phy-${ifname}`,
			apOnPhy: false,
		}));
		expect(
			await call(wifiScanProcedure, { device: "0" }, { context: ctx() }),
		).toEqual({ success: false, error: "DEVICE_BUSY" });
		expect(spawns).toEqual([]);
	});

	test("the RPC reports a busy radio instead of a scan it never ran", async () => {
		protectRadiosFromScans(["wlan0"], ["phy-wlan0"]);
		setScanGateModeReader(async (ifname) => ({
			phy: `phy-${ifname}`,
			apOnPhy: false,
		}));
		let result: unknown;
		await withWifiAdapterLock(SEARCHER, async () => {
			result = await call(
				wifiScanProcedure,
				{ device: "1" },
				{ context: ctx() },
			);
		});
		expect(result).toEqual({ success: false, error: "DEVICE_BUSY" });
		expect(spawns).toEqual([]);
	});
});
