import {
	afterEach,
	beforeEach,
	expect,
	jest,
	mock,
	spyOn,
	test,
} from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../helpers/logger.ts";
import * as runner from "../helpers/run.ts";
import * as nm from "../modules/network/network-manager.ts";
import {
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import {
	refreshWifiCapabilities,
	resetWifiCapabilitiesForTest,
	setWifiCapabilityDepsForTest,
} from "../modules/wifi/wifi-capabilities.ts";
import {
	getWifiInterfacesByMacAddress,
	wifiCancelScanRefresh,
} from "../modules/wifi/wifi-connections.ts";
import * as devices from "../modules/wifi/wifi-device-list.ts";
import { canHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import {
	resetWifiConnectionModeCache,
	resetWifiInterfaceDiscoveryForTest,
	wifiUpdateDevices,
} from "../modules/wifi/wifi-interfaces.ts";
import { setPermanentMacReaderForTest } from "../modules/wifi/wifi-permanent-mac.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "../modules/wifi/wifi-radio-identity.ts";
import { wifiRadioObservation } from "../modules/wifi/wifi-radio-observation.ts";
import * as compat from "../rpc/compat.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

/*
  NetworkManager's WIFI-PROPERTIES.AP decides whether a radio is offered a
  hotspot; the phy's own parsed "Supported interface modes" may lift a `no`
  until NM and iw are shown to agree on every supported radio. Absent evidence
  never lifts it.
*/

const mac = "58:02:05:e1:79:2d";
let registry: ReturnType<typeof isolateWifiRegistry>;
let nmAp: "yes" | "no";
let infos: string[];
let phyDump: string;
let regDump: string;
let devDump: string;

const fixture = (name: string) =>
	readFile(join(import.meta.dir, "fixtures", "wifi", name), "utf8");

/** The onboard RTL8852BE dump without AP among its supported interface modes. */
function withoutApMode(dump: string): string {
	const stripped = dump.replace(
		/(\tSupported interface modes:\n(?:\t\t \* .*\n)*?)\t\t \* AP\n/,
		"$1",
	);
	if (stripped === dump) throw new Error("fixture lost its AP mode line");
	return stripped;
}

function useIw(phy: string | undefined): void {
	setWifiCapabilityDepsForTest({
		runIw: async (args) => {
			if (phy === undefined) throw new Error("iw unavailable in this case");
			return args[0] === "phy" ? phy : args[0] === "reg" ? regDump : devDump;
		},
		readPhyName: async () => "phy0",
		pathExists: async () => false,
		readNmcliWifiProperties: async () => undefined,
		now: () => Date.now(),
	});
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 3; turn++) {
		for (let i = 0; i < 300; i++) await Promise.resolve();
		jest.advanceTimersByTime(0);
	}
	for (let i = 0; i < 300; i++) await Promise.resolve();
}

function row() {
	const rows = Object.values(getWifiInterfacesByMacAddress());
	expect(rows).toHaveLength(1);
	const found = rows[0];
	if (!found) throw new Error("no radio row");
	return found;
}

function fallbackLogs(): string[] {
	return infos.filter((message) => message.includes("phy lists AP mode"));
}

beforeEach(async () => {
	jest.useFakeTimers();
	jest.setSystemTime(0);
	registry = isolateWifiRegistry();
	wifiRadioObservation.stop();
	await wifiRadioObservation.settled;
	await wifiRadioIdentity.discover([]);
	resetWifiInterfaceDiscoveryForTest();
	resetWifiConnectionModeCache();
	wifiCancelScanRefresh();
	onWifiChange(() => undefined);
	setWifiState({});
	nmAp = "no";
	infos = [];
	[phyDump, regDump, devDump] = await Promise.all([
		fixture("iw-phy-rock5bplus-rtl8852be.txt"),
		fixture("iw-reg-get-rock5bplus.txt"),
		fixture("iw-dev-rock5bplus.txt"),
	]);
	setPermanentMacReaderForTest(async () => mac);
	spyOn(devices, "wifiDeviceListGetMacAddress").mockReturnValue(mac);
	spyOn(devices, "wifiDeviceListGetInetAddress").mockReturnValue(undefined);
	spyOn(nm, "nmDevices").mockResolvedValue(["wlan0:wifi:disconnected:"]);
	spyOn(nm, "nmDeviceProp").mockImplementation(async () => [
		"Realtek Semiconductor Co., Ltd.",
		"RTL8852BE PCIe 802.11ax Wireless Network Controller",
		nmAp,
		"yes",
		"yes",
	]);
	spyOn(nm, "nmConnGetFields").mockResolvedValue(["infrastructure"]);
	spyOn(nm, "nmConnsGet").mockResolvedValue([""]);
	spyOn(nm, "nmScanResults").mockResolvedValue([""]);
	spyOn(runner, "run").mockRejectedValue(new Error("Unfaked command"));
	spyOn(compat, "broadcastMsg").mockImplementation(() => undefined);
	for (const level of ["debug", "warn", "error"] as const)
		spyOn(logger, level).mockImplementation(() => logger);
	spyOn(logger, "info").mockImplementation((message) => {
		infos.push(String(message));
		return logger;
	});
	spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) =>
		path.endsWith("/ifindex") ? "3" : path.endsWith("/index") ? "0" : mac,
	);
	spyOn(radioIdentityReaders, "realpath").mockResolvedValue(
		"/sys/devices/radio/phy0",
	);
	resetWifiCapabilitiesForTest();
});

afterEach(async () => {
	await settle();
	wifiRadioObservation.stop();
	await wifiRadioObservation.settled;
	resetWifiInterfaceDiscoveryForTest();
	resetWifiConnectionModeCache();
	wifiCancelScanRefresh();
	resetWifiCapabilitiesForTest();
	setPermanentMacReaderForTest(null);
	onWifiChange(() => undefined);
	setWifiState({});
	mock.restore();
	restoreWifiRegistry(registry);
	jest.useRealTimers();
});

test("NM's no is lifted when the phy's parsed interface modes list AP, logged once per radio", async () => {
	useIw(phyDump);
	await refreshWifiCapabilities(["wlan0"]);
	await wifiUpdateDevices();
	await settle();
	expect(canHotspot(row())).toBe(true);
	await wifiUpdateDevices();
	await settle();
	expect(canHotspot(row())).toBe(true);
	expect(fallbackLogs()).toHaveLength(1);
	expect(fallbackLogs()[0]).toContain("wlan0");
	expect(fallbackLogs()[0]).not.toContain(mac);
});

test("NM's no stands when the phy does not list AP mode", async () => {
	useIw(withoutApMode(phyDump));
	await refreshWifiCapabilities(["wlan0"]);
	await wifiUpdateDevices();
	await settle();
	expect(canHotspot(row())).toBe(false);
	expect(fallbackLogs()).toEqual([]);
});

for (const phy of ["ap", "no-ap", "absent"] as const) {
	test(`NM's yes offers the hotspot unchanged; iw evidence ${phy}`, async () => {
		nmAp = "yes";
		useIw(
			phy === "absent"
				? undefined
				: phy === "ap"
					? phyDump
					: withoutApMode(phyDump),
		);
		await wifiUpdateDevices();
		await settle();
		expect(canHotspot(row())).toBe(true);
		expect(fallbackLogs()).toEqual([]);
	});
}

test("absent capability evidence keeps NM's no", async () => {
	useIw(undefined);
	await wifiUpdateDevices();
	await settle();
	await wifiUpdateDevices();
	await settle();
	expect(canHotspot(row())).toBe(false);
	expect(fallbackLogs()).toEqual([]);
});

test("evidence published after the first classification re-runs it once", async () => {
	useIw(phyDump);
	const listings = spyOn(nm, "nmDevices");
	// The capability read starts after classification, so the first pass can
	// only see NM's answer.
	await wifiUpdateDevices();
	expect(canHotspot(row())).toBe(false);
	await settle();
	expect(canHotspot(row())).toBe(true);
	expect(fallbackLogs()).toHaveLength(1);
	const passes = listings.mock.calls.length;
	await settle();
	expect(listings.mock.calls.length).toBe(passes);
});
