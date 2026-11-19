/*
  While the roaming coordinator runs, the radio that carries the stream is never
  scanned by CeraUI itself. A device-less rescan scans every other radio by
  name; a rescan aimed at the holder scans nothing and leaves its stamp alone.
*/
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { MacAddress } from "../modules/network/network-manager.ts";
import { protectRadiosFromScans } from "../modules/network/wifi-roaming/scan-gate.ts";
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

	test("a rescan aimed at another radio is unchanged", async () => {
		protectRadiosFromScans(["wlan0"]);
		await wifiRescan(1);
		expect(spawns).toEqual(["wlan1"]);
		expect(getWifiScanStampForDevice(1)?.generation).toBe(1);
	});
});
