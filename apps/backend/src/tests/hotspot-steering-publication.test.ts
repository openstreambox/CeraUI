import { expect, mock, spyOn, test } from "bun:test";
import * as interfaces from "../modules/network/network-interfaces.ts";
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
	beginHotspotTransition,
	registerPendingConfirmation,
	settlePending,
} from "../modules/wifi/wifi-hotspot-monitor.ts";
import {
	awaitHotspotSteering,
	captureHotspotSteeringFence,
	type HotspotSteeringDeps,
} from "../modules/wifi/wifi-hotspot-readiness.ts";
import type {
	HotspotActivationDeps,
	WifiInterfaceWithHotspot,
} from "../modules/wifi/wifi-hotspot-types.ts";
import { mockActiveObservation } from "./helpers/wifi-active-observation.ts";

const MAC = "02:00:00:00:00:93";

function fixture() {
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
	addWifiInterface(MAC, iface);
	let verified = false;
	let reconciles = 0;
	const steering: HotspotSteeringDeps = {
		reconcile: async () => {
			reconciles++;
		},
		verified: () => verified,
	};
	const outcomes: unknown[] = [];
	const deps = {
		nmConnect: async () => true,
		nmConnSetFields: async () => true,
		wifiUpdateSavedConns: async () => {},
		broadcastState: refreshWifiApClientZones,
		setDupIpSuppression: () => {},
		credentials: { get: () => undefined, remember: () => {} },
		findHotspotConn: async () => undefined,
		steering,
		publishOutcome: (...args: unknown[]) => {
			outcomes.push(args);
		},
	} as unknown as HotspotActivationDeps;
	const confirm = () => {
		iface.hotspot.transition = "activating";
		registerPendingConfirmation(
			{ macAddress: MAC, uuid: "ap93", ifname: "wlan93" },
			iface,
			deps,
		);
		settlePending("wlan93", true);
	};
	return {
		iface,
		netif,
		deps,
		outcomes,
		confirm,
		verify: () => {
			verified = true;
		},
		reconciles: () => reconciles,
		restore: () => {
			removeWifiInterface(MAC);
			delete netif.wlan93;
		},
	};
}

test("fake NM confirmation publishes AP zone without a second connection edge and fences completion", async () => {
	const f = fixture();
	let edges = 0;
	const off = onNetworkInterfacesChange(() => edges++);
	try {
		f.confirm();
		expect((f.netif.wlan93?.error ?? 0) & NETIF_ERR_HOTSPOT).toBe(
			NETIF_ERR_HOTSPOT,
		);
		expect(edges).toBe(1);
		expect(f.outcomes).toEqual([]);
		// A later IP snapshot must carry the zone even without a Wi-Fi status change.
		const late = {
			wlan93: { ...(f.netif.wlan93 ?? { tp: 0 }), error: 0, enabled: true },
		} as Parameters<typeof applyConcurrentApBondGate>[0];
		applyConcurrentApBondGate(late);
		expect((late.wlan93?.error ?? 0) & NETIF_ERR_HOTSPOT).toBe(
			NETIF_ERR_HOTSPOT,
		);
		await Bun.sleep(20);
		expect(f.outcomes).toEqual([]);
		f.verify();
		await Bun.sleep(550);
		expect(f.reconciles()).toBeGreaterThan(0);
		expect(f.outcomes).toEqual([["start", 93, { success: true }]]);
		f.iface.activeMode = "ap";
		f.iface.activeConn = "ap93";
		// Upstream's Stop brings down the exact activation NM reports.
		mockActiveObservation((name) => (name === "wlan93" ? "ap93" : undefined));
		await stopHotspotForInterface(MAC, f.iface, {
			nmConnSetFields: async () => true,
			nmDisconnect: async () => true,
			releaseConcurrentInterface: async () => true,
			broadcastState: refreshWifiApClientZones,
			setDupIpSuppression: () => {},
			rescan: async () => {},
		});
		expect((f.netif.wlan93?.error ?? 0) & NETIF_ERR_HOTSPOT).toBe(0);
		expect(edges).toBe(2);
	} finally {
		mock.restore();
		off();
		f.restore();
	}
});

test("a Stop during the steering wait cancels the old Start without a success frame", async () => {
	const f = fixture();
	try {
		f.confirm();
		await Bun.sleep(20);
		beginHotspotTransition(f.iface, "deactivating");
		f.verify();
		await Bun.sleep(600);
		expect(f.outcomes).toEqual([]);
	} finally {
		f.restore();
	}
});

test("an operation that finishes during the wait still cancels the old Start", async () => {
	const f = fixture();
	try {
		f.confirm();
		await Bun.sleep(20);
		// A reconfigure restarts the same profile and clears its transition again.
		beginHotspotTransition(f.iface, "activating");
		delete f.iface.hotspot.transition;
		f.verify();
		await Bun.sleep(600);
		expect(f.outcomes).toEqual([]);
	} finally {
		f.restore();
	}
});

test("a replaced row or profile during the wait never certifies the replacement", async () => {
	for (const replace of ["profile", "row"] as const) {
		const f = fixture();
		try {
			f.confirm();
			await Bun.sleep(20);
			if (replace === "profile") f.iface.hotspot.conn = "ap94";
			else f.iface.hotspot = { ...f.iface.hotspot };
			f.verify();
			await Bun.sleep(600);
			expect(f.outcomes).toEqual([]);
		} finally {
			f.restore();
		}
	}
});

const activationWitness = {
	activePath: "/active/1",
	profile: {
		path: "/settings/1",
		runId: "fixture",
		fingerprint: "ap",
		file: { filename: "/fixture", device: "1", inode: "2", ctime: "3" },
	},
};

test("a netif snapshot arriving after NM confirmation can verify the same AP", async () => {
	const f = fixture();
	const incarnation = spyOn(
		interfaces,
		"getNetworkInterfaceIncarnation",
	).mockReturnValue(undefined);
	const published = Promise.withResolvers<unknown[]>();
	f.deps.publishOutcome = (...args) => published.resolve(args);
	f.deps.steering = {
		readActivation: async () => activationWitness,
		reconcile: async () => {
			incarnation.mockReturnValue(7);
		},
		verified: (_, observed) => observed === 7,
	};
	try {
		f.confirm();
		expect(await published.promise).toEqual(["start", 93, { success: true }]);
	} finally {
		f.restore();
		incarnation.mockRestore();
	}
}, 2000);

test("a bound netif incarnation change cancels Start with the same NM activation", async () => {
	const f = fixture();
	const incarnation = spyOn(
		interfaces,
		"getNetworkInterfaceIncarnation",
	).mockReturnValue(undefined);
	try {
		f.iface.conn = "ap93";
		const fence = captureHotspotSteeringFence(f.iface, "ap93", {
			witness: activationWitness,
		});
		const readActivation = mock(async () => {
			expect(fence.incarnation).toBe(7);
			incarnation.mockReturnValue(8);
			return activationWitness;
		});
		const result = await awaitHotspotSteering(
			fence,
			{
				reconcile: async () => {
					incarnation.mockReturnValue(7);
				},
				verified: (_, observed) => observed !== undefined,
				readActivation,
			},
			undefined,
			(outcome) => f.deps.publishOutcome?.("start", f.iface.id, outcome),
		);
		expect(readActivation).toHaveBeenCalledTimes(1);
		expect(result).toBeUndefined();
		expect(f.outcomes).toEqual([]);
	} finally {
		f.restore();
		incarnation.mockRestore();
	}
});
