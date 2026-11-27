/*
  A rescan started inside an adapter-lock owner without being awaited (hotspot
  teardown does `void deps.rescan()`) must not count as dispatched under that
  lock: by the time its scan goes out the owner may have released the lock, and
  another transaction (a hotspot Start) may hold it.
*/
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { MacAddress } from "../modules/network/network-manager.ts";
import {
	protectRadiosFromScans,
	type RadioMode,
	setScanGateModeReader,
} from "../modules/network/wifi-roaming/scan-gate.ts";
import { withWifiAdapterLock } from "../modules/wifi/wifi-adapter-lock.ts";
import {
	resetWifiScanStampsForTest,
	setRescanActionForTest,
	setScanRefreshAction,
	setScanResultReaderForTest,
	wifiCancelScanRefresh,
	wifiRescan,
} from "../modules/wifi/wifi-connections.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";
import { seedWifiRadios } from "./helpers/wifi-verified-radios.ts";

const HOLDER: MacAddress = "aa:bb:cc:dd:ee:01";
const SEARCHER: MacAddress = "aa:bb:cc:dd:ee:02";
let inherited: ReturnType<typeof isolateWifiRegistry>;
let seeded: Awaited<ReturnType<typeof seedWifiRadios>>;
beforeEach(async () => {
	inherited = isolateWifiRegistry();
	resetWifiScanStampsForTest();
	// Verified, published radios: the gate admits a radio before scanning it.
	seeded = await seedWifiRadios();
	await seeded.publish(
		[HOLDER, SEARCHER].map((mac, id) => ({
			ifname: `wlan${id}`,
			mac,
			ifindex: 70 + id,
			phy: 7 + id,
			row: { id, hw: `r${id}` },
		})),
	);
	setScanRefreshAction(() => {});
	setScanResultReaderForTest(() => Promise.resolve(true));
});
afterEach(async () => {
	protectRadiosFromScans([]);
	setScanGateModeReader(null);
	wifiCancelScanRefresh();
	await seeded.restore();
	restoreWifiRegistry(inherited);
	resetWifiScanStampsForTest();
});

test("a rescan started by a lock owner never scans while another transaction holds the lock", async () => {
	protectRadiosFromScans(["wlan0"], ["phy-wlan0"]);
	let modeRead: (m: RadioMode) => void = () => {};
	setScanGateModeReader(
		() =>
			new Promise<RadioMode>((resolve) => {
				modeRead = resolve;
			}),
	);
	let otherHolds = false;
	const scannedWhileOtherHeld: string[] = [];
	const spawns: string[] = [];
	setRescanActionForTest(async (device) => {
		spawns.push(String(device));
		if (otherHolds) scannedWhileOtherHeld.push(String(device));
	});

	// Teardown-like owner: starts a rescan and returns without awaiting it.
	let run: Promise<void> | undefined;
	const teardown = await withWifiAdapterLock(SEARCHER, async () => {
		run = wifiRescan();
	});
	expect(teardown.success).toBe(true);

	// A hotspot Start now takes the same radio's lock and holds it.
	let releaseStart = () => {};
	const start = withWifiAdapterLock(SEARCHER, async () => {
		otherHolds = true;
		await new Promise<void>((done) => {
			releaseStart = done;
		});
		otherHolds = false;
	});
	await Promise.resolve();
	// The scan's fresh mode read answers "station" (the AP is not up yet).
	modeRead({ phy: "phy-wlan1", apOnPhy: false });
	await run;
	releaseStart();
	expect((await start).success).toBe(true);
	expect(scannedWhileOtherHeld).toEqual([]);
});
