import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseApModeSupport,
	parseApStaConcurrencySupport,
} from "../modules/wifi/wifi-ap-sta-capability.ts";
import {
	resetWifiPermanentMacCache,
	resolveWifiPermanentMac,
	setPermanentMacReaderForTest,
} from "../modules/wifi/wifi-permanent-mac.ts";
import {
	isWirelessInterface,
	readWifiRadioIdentity,
	resolveWirelessAddress,
} from "../modules/wifi/wifi-radio-identity.ts";

test("wireless discovery uses sysfs markers, never interface spelling", async () => {
	const root = await mkdtemp(join(tmpdir(), "wireless-"));
	try {
		for (const name of ["wlx020000000001", "renamed-radio"]) {
			await mkdir(join(root, name, "wireless"), { recursive: true });
			expect(isWirelessInterface(name, root)).toBe(true);
			expect(
				await resolveWirelessAddress(
					name,
					undefined,
					async () => "02:00:00:00:00:01",
				),
			).toBe("02:00:00:00:00:01");
		}
		await mkdir(join(root, "wlan-ethernet"));
		expect(isWirelessInterface("wlan-ethernet", root)).toBe(false);
		expect(
			await resolveWirelessAddress(
				"wlx020000000001",
				undefined,
				async () => undefined,
				async () => "02:00:00:00:00:02",
			),
		).toBe("02:00:00:00:00:02");
	} finally {
		await rm(root, { recursive: true });
	}
});

test("permanent radio identity survives rename and replug with a new PHY", async () => {
	resetWifiPermanentMacCache();
	setPermanentMacReaderForTest(async () => "02:00:00:00:00:01");
	try {
		const identities = [];
		for (const [name, phy] of [
			["wlx020000000001", "phy3"],
			["ap-radio", "phy3"],
			["wlx020000000001", "phy7"],
		] as const) {
			const mac = await resolveWifiPermanentMac(name, "06:00:00:00:00:02");
			identities.push(
				await readWifiRadioIdentity(name, mac, async (path) =>
					path.endsWith("phy80211")
						? `/sys/devices/ieee80211/${phy}`
						: "/sys/devices/platform/usb/3-1/3-1.2/3-1.2:1.0",
				),
			);
		}
		expect(identities.map((i) => i.id)).toEqual(
			Array(3).fill("02:00:00:00:00:01"),
		);
		expect(identities[2]?.phy).toBe("phy7");
		expect(identities[2]?.device_path).toBe(identities[0]?.device_path);
	} finally {
		setPermanentMacReaderForTest(null);
		resetWifiPermanentMacCache();
	}
});

test("AP and concurrency come from separate PHY sections", () => {
	expect(
		parseApModeSupport(
			"Supported interface modes:\n\t * managed\n\t * AP\nBand 1:",
		),
	).toBe(true);
	expect(
		parseApModeSupport(
			"Supported interface modes:\n\t * managed\nBand 1:\n * AP",
		),
	).toBe(false);
	expect(parseApModeSupport("unreadable")).toBeUndefined();
	expect(
		parseApStaConcurrencySupport(
			"valid interface combinations:\n * #{ managed, AP } <= 1, total <= 1, #channels <= 1",
		),
	).toBe(false);
	expect(
		parseApStaConcurrencySupport(
			"valid interface combinations:\n * #{ managed } <= 1, #{ AP } <= 1, total <= 2, #channels <= 1",
		),
	).toBe(true);
});

test("stable API target maps to the current device id and never falls back", async () => {
	const { resolveHotspotRadioDevice } = await import(
		"../modules/wifi/wifi-interfaces.ts"
	);
	const { addWifiInterface, removeWifiInterface } = await import(
		"../modules/wifi/wifi-connections.ts"
	);
	const mac = "02:00:00:00:04:01";
	try {
		addWifiInterface(mac, {
			id: 81,
			ifname: "renamed-usb",
			conn: null,
			hw: "USB",
			available: new Map(),
			saved: {},
			savedAll: {},
		});
		expect(resolveHotspotRadioDevice({ device: "0", radio_id: mac })).toBe(81);
		expect(
			resolveHotspotRadioDevice({ device: "81", radio_id: "missing" }),
		).toBeNaN();
		expect(resolveHotspotRadioDevice({ device: "81" })).toBe(81);
	} finally {
		removeWifiInterface(mac);
	}
});

test("PHY AP modes override an inconsistent NM AP property", async () => {
	const { parseWifiDeviceProperties } = await import(
		"../modules/wifi/wifi-interfaces.ts"
	);
	const props = ["Example", "USB radio", "no", "yes", "yes"];
	const supported = parseWifiDeviceProperties(props, true);
	expect(supported.ok && supported.value.supportsAp).toBe(true);
	const unsupported = parseWifiDeviceProperties(
		["Example", "USB radio", "yes", "yes", "yes"],
		false,
	);
	expect(unsupported.ok && unsupported.value.supportsAp).toBe(false);
});

test("down wlx radios enter the discovery cache while a wlan-named Ethernet does not", async () => {
	const { processIfconfigOutput } = await import(
		"../modules/network/network-interfaces.ts"
	);
	const { wifiDeviceListGetMacAddress } = await import(
		"../modules/wifi/wifi-device-list.ts"
	);
	const { stopWifiUpdateLoopForTest } = await import(
		"../modules/wifi/wifi-interfaces.ts"
	);
	const root = await mkdtemp(join(tmpdir(), "radio-poll-"));
	try {
		await mkdir(join(root, "wlx020000000001", "phy80211"), { recursive: true });
		processIfconfigOutput(
			[
				"wlx020000000001: flags=4098<BROADCAST,MULTICAST> mtu 1500\n        ether 02:00:00:00:00:01 txqueuelen 1000",
				"wlan-ethernet: flags=4098<BROADCAST,MULTICAST> mtu 1500\n        ether 02:00:00:00:00:02 txqueuelen 1000",
			].join("\n\n"),
			undefined,
			0,
			(name) => isWirelessInterface(name, root),
		);
		expect(wifiDeviceListGetMacAddress("wlx020000000001")).toBe(
			"02:00:00:00:00:01",
		);
		expect(wifiDeviceListGetMacAddress("wlan-ethernet")).toBeUndefined();
	} finally {
		stopWifiUpdateLoopForTest();
		await rm(root, { recursive: true });
	}
});
