/*
    IN-USE belongs to the radio that reported the scan row.

    A box with two radios, one running the hotspot and one joined to a venue
    Wi-Fi, lists both as in use in `nmcli device wifi list`: NetworkManager
    reports the hotspot as the AP radio's own in-use access point. Copying the
    flag onto every radio labelled the venue link with the hotspot's SSID.
*/
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as nm from "../modules/network/network-manager.ts";
import { linkLabelFor } from "../modules/streaming/link-label.ts";
import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
	parseWifiScanRow,
	wifiUpdateScanResult,
} from "../modules/wifi/wifi-connections.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

let registry: ReturnType<typeof isolateWifiRegistry>;
const spies: { mockRestore(): void }[] = [];
beforeEach(() => {
	registry = isolateWifiRegistry();
	for (const [mac, id, ifname] of [
		["02:00:00:00:00:01", 1, "wlx020000000001"],
		["02:00:00:00:00:02", 2, "wlx020000000002"],
		["02:00:00:00:00:03", 3, "wlx020000000003"],
	] as const)
		addWifiInterface(mac, {
			id,
			ifname,
			conn: null,
			hw: `Radio ${id}`,
			available: new Map(),
			saved: {},
			savedAll: {},
			// Radio 1 runs the hotspot: NetworkManager reports AP mode.
			...(id === 1
				? {
						activeMode: "ap" as const,
						activeConn: "hotspot-profile",
						hotspot: {
							conn: "hotspot-profile",
							name: "Box Hotspot",
							availableChannels: ["auto"],
							warnings: {},
						} as never,
					}
				: {}),
		});
});
afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	restoreWifiRegistry(registry);
});

const row = (
	inUse: boolean,
	ssid: string,
	signal: number,
	device: string,
	bssid = "AA\\:BB\\:CC\\:DD\\:EE\\:FF",
) =>
	`${inUse ? "*" : " "}:${bssid}:${ssid}:Infra:6:54 Mbit/s:${signal}:____:WPA2:${device}`;

test("the scan read asks nmcli which radio reported each row", async () => {
	const scan = spyOn(nm, "nmScanResults").mockResolvedValue([""]);
	spies.push(scan);
	await wifiUpdateScanResult();
	expect(scan.mock.calls[0]?.[0]).toBe(
		"IN-USE,BSSID,SSID,MODE,CHAN,RATE,SIGNAL,BARS,SECURITY,DEVICE",
	);
});

test("the parser keeps the reporting radio", () => {
	expect(parseWifiScanRow(row(true, "Venue", 80, "wlan1"))?.device).toBe(
		"wlan1",
	);
	expect(
		parseWifiScanRow(
			" :AA\\:BB\\:CC\\:DD\\:EE\\:FF:Venue:Infra:6:54 Mbit/s:80:____:WPA2",
		)?.device,
	).toBeUndefined();
});

test("each radio is in use only on its own network", async () => {
	spies.push(
		spyOn(nm, "nmScanResults").mockResolvedValue([
			// The hotspot radio's own AP, as NetworkManager reports it.
			row(
				true,
				"Box Hotspot",
				0,
				"wlx020000000001",
				"02\\:00\\:00\\:00\\:00\\:01",
			),
			row(true, "Hotel", 90, "wlx020000000002"),
			// The spare radio hears the same venue later in the list; that must
			// not clear the station radio's in-use row.
			row(false, "Hotel", 70, "wlx020000000003"),
			row(false, "Cafe", 40, "wlx020000000002", "11\\:22\\:33\\:44\\:55\\:66"),
		]),
	);
	expect(await wifiUpdateScanResult()).toBe(true);
	const radios = Object.values(getWifiInterfacesByMacAddress());
	const station = radios.find((r) => r.id === 2);
	const hotspot = radios.find((r) => r.id === 1);
	const spare = radios.find((r) => r.id === 3);
	const inUse = (r: typeof station) =>
		[...(r?.available.values() ?? [])]
			.filter((n) => n.active)
			.map((n) => n.ssid);
	expect(inUse(station)).toEqual(["Hotel"]);
	expect(inUse(hotspot)).toEqual(["Box Hotspot"]);
	// The box's own hotspot is not offered to the station radio as a network.
	expect(station?.available.has("Box Hotspot")).toBe(false);
	// Networks a station radio heard are still offered to every radio, the
	// other station's venue Wi-Fi as a candidate rather than its connection.
	expect(hotspot?.available.has("Cafe")).toBe(true);
	expect(spare?.available.get("Hotel")).toMatchObject({
		ssid: "Hotel",
		active: false,
	});
	expect(inUse(spare)).toEqual([]);
	expect(spare?.available.has("Box Hotspot")).toBe(false);
	expect(
		linkLabelFor(
			"wlx020000000002",
			{
				"2": {
					ifname: "wlx020000000002",
					available: [...(station?.available.values() ?? [])],
				},
			},
			{},
		),
	).toBe("Hotel");
});
