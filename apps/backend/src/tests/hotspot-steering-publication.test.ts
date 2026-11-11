import { expect, test } from "bun:test";
import {
	applyConcurrentApBondGate,
	getNetworkInterfaces,
	NETIF_ERR_HOTSPOT,
	onNetworkInterfacesChange,
	refreshWifiApClientZones,
} from "../modules/network/network-interfaces.ts";
import {
	addWifiInterface,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import { stopHotspotForInterface } from "../modules/wifi/wifi-hotspot-config.ts";
import {
	registerPendingConfirmation,
	settlePending,
} from "../modules/wifi/wifi-hotspot-monitor.ts";
import type { WifiInterfaceWithHotspot } from "../modules/wifi/wifi-hotspot-types.ts";

test("fake NM confirmation publishes AP zone without a second connection edge and fences completion", async () => {
	const mac = "02:00:00:00:00:93";
	const iface: WifiInterfaceWithHotspot = {
		id: 93,
		ifname: "wlan93",
		conn: null,
		hw: "test",
		available: new Map(),
		saved: {},
		savedAll: {},
		hotspot: {
			conn: "ap93",
			name: "test",
			warnings: {},
			availableChannels: ["auto"],
		},
	};
	const netif = getNetworkInterfaces();
	netif.wlan93 = {
		ip: "10.42.0.1",
		netmask: "255.255.255.0",
		enabled: true,
		error: 0,
		tp: 0,
		txb: 0,
		rxb: 0,
	};
	addWifiInterface(mac, iface);
	let edges = 0;
	const off = onNetworkInterfacesChange(() => edges++);
	let release!: (ready: boolean) => void;
	const ready = new Promise<boolean>((resolve) => {
		release = resolve;
	});
	const outcomes: unknown[] = [];
	let checks = 0;
	try {
		registerPendingConfirmation(mac, iface, {
			nmConnect: async () => true,
			nmConnSetFields: async () => true,
			nmHotspot: async () => null,
			wifiUpdateSavedConns: async () => {},
			broadcastState: refreshWifiApClientZones,
			setDupIpSuppression: () => {},
			credentials: { get: () => undefined, remember: () => {} },
			findHotspotConn: async () => undefined,
			confirmSteering: async () => {
				if (++checks === 1) return false;
				return ready;
			},
			publishOutcome: (...args) => {
				outcomes.push(args);
			},
		});
		settlePending(iface.ifname, true);
		expect(netif.wlan93.error & NETIF_ERR_HOTSPOT).toBe(NETIF_ERR_HOTSPOT);
		expect(edges).toBe(1);
		expect(outcomes).toEqual([]);
		// A later IP snapshot must carry the zone even without a Wi-Fi status change.
		const late = { wlan93: { ...netif.wlan93, error: 0, enabled: true } };
		applyConcurrentApBondGate(late);
		expect(late.wlan93.error & NETIF_ERR_HOTSPOT).toBe(NETIF_ERR_HOTSPOT);
		release(true);
		await Bun.sleep(550);
		expect(checks).toBe(2);
		expect(outcomes).toEqual([["start", 93, { success: true }]]);
		iface.activeMode = "ap";
		iface.activeConn = "ap93";
		await stopHotspotForInterface(mac, iface, {
			nmConnSetFields: async () => true,
			nmDisconnect: async () => true,
			releaseConcurrentInterface: async () => true,
			broadcastState: refreshWifiApClientZones,
			setDupIpSuppression: () => {},
			rescan: async () => {},
		});
		expect(netif.wlan93.error & NETIF_ERR_HOTSPOT).toBe(0);
		expect(edges).toBe(2);
	} finally {
		off();
		removeWifiInterface(mac);
		delete netif.wlan93;
	}
});
