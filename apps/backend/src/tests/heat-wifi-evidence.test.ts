import { expect, test } from "bun:test";
import { idleWifiEvidence } from "../modules/wifi/heat-wifi-runtime.ts";

const idle = {
	usb: true,
	singleRadioInterface: true,
	disconnected: true,
	bond: false,
	hotspot: false,
	addresses: [],
	routes: [],
};
test("positive proof admits only a completely unused USB radio", () => {
	expect(idleWifiEvidence(idle)).toBe(true);
});
for (const [name, patch] of Object.entries({
	onboard: { usb: false },
	virtualAP: { singleRadioInterface: false },
	connected: { disconnected: false },
	bond: { bond: true },
	hotspot: { hotspot: true },
	management4: { addresses: [{ family: "inet", local: "192.0.2.4" }] },
	management6: { addresses: [{ family: "inet6", local: "fe80::1" }] },
	uplink: { routes: [{ dst: "default" }] },
	policyRoute: { routes: [{ table: 100, dst: "198.51.100.0/24" }] },
})) {
	test(`${name} never qualifies`, () => {
		expect(idleWifiEvidence({ ...idle, ...patch })).toBe(false);
	});
}

import {
	type heatWifiReaders,
	readHeatWifiRadios,
} from "../modules/wifi/heat-wifi-runtime.ts";

test("native reader with fake interfaces: USB identity, NM idle, routes and AP siblings", async () => {
	let state = "30 (disconnected)";
	let up = true;
	let siblings = ["wlan1"];
	let upper = false;
	let routes: unknown[] = [];
	let addresses: unknown[] = [];
	let path = "/sys/devices/pci/usb1/1-2/1-2:1.0";
	const radio = {
		id: 1,
		ifname: "wlan1",
		hw: "USB",
		conn: null,
		activeConn: null,
		available: new Map(),
		saved: {},
		savedAll: {},
	};
	const deps: typeof heatWifiReaders = {
		registry: () => ({ "02:00:00:00:00:01": radio }),
		interfaces: () => ({}),
		realpath: async (p) =>
			p.endsWith("device") ? path : "/sys/class/ieee80211/phy1",
		read: async () => "7",
		list: async (path) =>
			path.endsWith("/device/net") ? siblings : upper ? ["upper_mv0"] : [],
		command: async (cmd, args) => {
			if (cmd === "nmcli") return state;
			if (args.includes("address"))
				return JSON.stringify([
					{ flags: up ? ["UP"] : [], addr_info: addresses },
				]);
			return JSON.stringify(routes);
		},
	};
	expect((await readHeatWifiRadios(deps))[0]?.eligible).toBe(true);
	up = false;
	state = "20 (unavailable)";
	expect((await readHeatWifiRadios(deps))[0]?.eligible).toBe(true);
	up = true;
	expect((await readHeatWifiRadios(deps))[0]?.eligible).toBe(false);
	state = "30 (disconnected)";
	siblings = ["wlan1", "clap-wlan1"];
	expect((await readHeatWifiRadios(deps))[0]?.eligible).toBe(false);
	siblings = ["wlan1"];
	addresses = [{ family: "inet6" }];
	expect((await readHeatWifiRadios(deps))[0]?.eligible).toBe(false);
	addresses = [];
	routes = [{ dst: "default" }];
	expect((await readHeatWifiRadios(deps))[0]?.eligible).toBe(false);
	routes = [];
	upper = true;
	expect((await readHeatWifiRadios(deps))[0]?.eligible).toBe(false);
	upper = false;
	path = "/sys/devices/platform/onboard";
	expect((await readHeatWifiRadios(deps))[0]?.eligible).toBe(false);
	deps.command = async () => {
		throw Error("no observation");
	};
	expect(await readHeatWifiRadios(deps)).toEqual([]);
});
