/**
 * A hotspot Start's terminal belongs to exactly one request and one AP
 * activation: every Start (also an already-up one) takes a ticket, the wait
 * keeps the NM activation witness through its final recheck, and only a
 * verification of this AP lifetime that began after the confirmation counts.
 * The status producer shows the same wait the terminal is fenced on.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as netifs from "../modules/network/network-interfaces.ts";
import type { NmProfileInstance } from "../modules/network/network-manager-profile-instance.ts";
import {
	beginSteeringVerification,
	enableSteeringReadiness,
	hotspotSteeringVerified,
	publishSteeringReadiness,
	resetSteeringReadinessForTest,
} from "../modules/network/uplink-steering/readiness.ts";
import { setWifiState } from "../modules/wifi/state/wifi-state.ts";
import { wifiBuildMsg } from "../modules/wifi/wifi.ts";
import { addWifiInterface } from "../modules/wifi/wifi-connections.ts";
import { startHotspotForInterface } from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	registerPendingConfirmation,
	settlePending,
} from "../modules/wifi/wifi-hotspot-monitor.ts";
import type { HotspotOutcomePublisher } from "../modules/wifi/wifi-hotspot-outcome.ts";
import {
	awaitHotspotSteering,
	captureHotspotSteeringFence,
	type HotspotSteeringDeps,
} from "../modules/wifi/wifi-hotspot-readiness.ts";
import type {
	HotspotActivationDeps,
	HotspotActivationInstance,
	WifiInterfaceWithHotspot,
} from "../modules/wifi/wifi-hotspot-types.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const MAC = "02:00:00:00:00:95";
const UUID = "ap95";
const ZONE = [{ ifname: "wlan95", ipv4Cidr: "10.42.0.0/24" }];
const LIFETIME = 5;
const PROFILE: NmProfileInstance = {
	path: "/org/freedesktop/NetworkManager/Settings/95",
	fingerprint: "ap95-settings",
	runId: "run-1",
	file: {
		filename: "ap95.nmconnection",
		device: "8",
		inode: "95",
		ctime: "1",
	},
};
const PATH_1 = "/org/freedesktop/NetworkManager/ActiveConnection/1";
const PATH_2 = "/org/freedesktop/NetworkManager/ActiveConnection/2";

let inherited: ReturnType<typeof isolateWifiRegistry> = [];
let row: WifiInterfaceWithHotspot;
let outcomes: unknown[][];
let activePath: string | undefined;
let reconciles: number;
let restoreIncarnation: () => void;

const steering: HotspotSteeringDeps = {
	reconcile: async () => {
		reconciles++;
	},
	verified: hotspotSteeringVerified,
	readActivation: async (apIfname, uuid) =>
		apIfname === "wlan95" && uuid === UUID && activePath
			? { activePath, profile: { ...PROFILE } }
			: undefined,
};

function publisher(tag: string): HotspotOutcomePublisher {
	return (kind, device, outcome) => {
		outcomes.push([tag, kind, device, outcome]);
	};
}

function deps(tag = "start"): HotspotActivationDeps {
	return {
		nmConnect: async () => true,
		nmConnSetFields: async () => true,
		nmApConnAdd: async () => UUID,
		nmConnDelete: async () => true,
		nmDisconnect: async () => true,
		wifiUpdateSavedConns: async () => {},
		broadcastState: () => {},
		setDupIpSuppression: () => {},
		credentials: { get: () => undefined, remember: () => {} },
		findHotspotConn: async () => undefined,
		pruneHotspotConns: async () => {},
		steering,
		publishOutcome: publisher(tag),
	};
}

/** A rule readback whose plan was built now (lifetime taken at entry). */
function beginVerification() {
	return beginSteeringVerification(["wlan95"], () => LIFETIME);
}

function completeVerification(
	entry: ReturnType<typeof beginVerification>,
): void {
	publishSteeringReadiness(ZONE, entry, () => LIFETIME);
}

/** NM confirms the exact activation a real Start dispatched. */
function confirmActivation(
	activation: HotspotActivationInstance = {
		profile: PROFILE,
		activePath: PATH_1,
	},
): void {
	row.hotspot.transition = "activating";
	registerPendingConfirmation(
		{ macAddress: MAC, uuid: UUID, ifname: "wlan95", activation },
		row,
		deps(),
	);
	row.activeConn = UUID;
	settlePending("wlan95", true);
}

const statusTransition = () =>
	(wifiBuildMsg() as Record<number, { transition?: string }>)[95]?.transition;

beforeEach(() => {
	inherited = isolateWifiRegistry();
	setWifiState({});
	outcomes = [];
	activePath = PATH_1;
	reconciles = 0;
	row = {
		id: 95,
		ifname: "wlan95",
		conn: null,
		hw: "test",
		available: new Map(),
		saved: {},
		savedAll: {},
		hotspot: {
			conn: UUID,
			name: "test",
			warnings: {},
			availableChannels: ["auto"],
		},
	};
	addWifiInterface(MAC, row);
	netifs.getNetworkInterfaces().wlan95 = {
		ip: "10.42.0.1",
		netmask: "255.255.255.0",
		enabled: true,
		error: 0,
		tp: 0,
		txb: 0,
		rxb: 0,
	};
	const spy = spyOn(
		netifs,
		"getNetworkInterfaceIncarnation",
	).mockImplementation((name) => (name === "wlan95" ? LIFETIME : undefined));
	restoreIncarnation = () => spy.mockRestore();
	enableSteeringReadiness();
});

afterEach(() => {
	restoreIncarnation();
	resetSteeringReadinessForTest();
	delete netifs.getNetworkInterfaces().wlan95;
	setWifiState({});
	restoreWifiRegistry(inherited);
});

test("a verification in flight at the confirmation cannot certify the Start, and the status keeps waiting", async () => {
	// The steering pass was planned before NM confirmed the AP...
	const inFlight = beginVerification();
	confirmActivation();
	expect(statusTransition()).toBe("activating");
	// ...and its readback completes afterwards for the same AP lifetime.
	completeVerification(inFlight);
	await Bun.sleep(600);
	expect(outcomes).toEqual([]);
	// The real status producer agrees with the fence: still waiting.
	expect(statusTransition()).toBe("activating");
	completeVerification(beginVerification());
	await Bun.sleep(600);
	expect(outcomes).toEqual([["start", "start", 95, { success: true }]]);
	expect(statusTransition()).toBeUndefined();
	expect(reconciles).toBeGreaterThan(0);
});

test("a name-only zone for an earlier AP lifetime never clears the status wait", async () => {
	// A zone of the same name verified for an older lifetime of wlan95.
	publishSteeringReadiness(
		ZONE,
		beginSteeringVerification(["wlan95"], () => LIFETIME - 1),
		() => LIFETIME - 1,
	);
	row.activeMode = "ap";
	row.activeConn = UUID;
	expect(statusTransition()).toBe("activating");
	completeVerification(beginVerification());
	expect(statusTransition()).toBeUndefined();
});

for (const reactivated of [false, true]) {
	test(`a same-profile ${reactivated ? "reactivation with a new active path cancels" : "activation that stays put completes"} the Start`, async () => {
		confirmActivation();
		await Bun.sleep(20);
		// NM deactivated and reactivated the same UUID on the retained wlan95:
		// the name, the profile, the netif lifetime and the row are unchanged.
		if (reactivated) activePath = PATH_2;
		completeVerification(beginVerification());
		await Bun.sleep(600);
		expect(outcomes).toEqual(
			reactivated ? [] : [["start", "start", 95, { success: true }]],
		);
	});
}

test("a replaced registry row cancels the Start", async () => {
	confirmActivation();
	await Bun.sleep(20);
	addWifiInterface(MAC, { ...row, hotspot: row.hotspot });
	completeVerification(beginVerification());
	await Bun.sleep(600);
	expect(outcomes).toEqual([]);
});

test("an already-up Start in the IP-poll gap (active connection, no conn yet) reaches verified", async () => {
	row.activeConn = UUID;
	expect(row.conn).toBeNull();
	expect(await startHotspotForInterface(MAC, row, deps())).toEqual({
		success: true,
	});
	expect(statusTransition()).toBe("activating");
	await Bun.sleep(20);
	expect(outcomes).toEqual([]);
	completeVerification(beginVerification());
	await Bun.sleep(600);
	expect(outcomes).toEqual([["start", "start", 95, { success: true }]]);
});

test("the IP-poll gap reaches pending at the deadline, not a cancellation", async () => {
	row.activeConn = UUID;
	let time = 0;
	const result = await awaitHotspotSteering(
		captureHotspotSteeringFence(row, UUID),
		steering,
		{
			now: () => time,
			wait: async (ms) => {
				time += ms;
			},
		},
	);
	expect(result).toEqual({
		success: true,
		pending: true,
		reason: "steering-readiness-timeout",
	});
});

test("an already-up AP that NM does not report active has no witness and publishes nothing", async () => {
	row.activeConn = UUID;
	activePath = undefined;
	await startHotspotForInterface(MAC, row, deps());
	completeVerification(beginVerification());
	await Bun.sleep(600);
	expect(outcomes).toEqual([]);
});

test("two retries against an already-up AP end with exactly one terminal, the latest", async () => {
	row.conn = UUID;
	row.activeConn = UUID;
	await startHotspotForInterface(MAC, row, deps("first"));
	await startHotspotForInterface(MAC, row, deps("second"));
	completeVerification(beginVerification());
	await Bun.sleep(600);
	expect(outcomes).toEqual([["second", "start", 95, { success: true }]]);
});

test("an already-up Start takes over an activation still awaiting NM confirmation", async () => {
	row.hotspot.transition = "activating";
	registerPendingConfirmation(
		{
			macAddress: MAC,
			uuid: UUID,
			ifname: "wlan95",
			activation: { profile: PROFILE, activePath: PATH_1 },
		},
		row,
		deps("first"),
	);
	// The device poll already sees the AP's connection before NM confirms.
	row.activeConn = UUID;
	await startHotspotForInterface(MAC, row, deps("second"));
	settlePending("wlan95", true);
	completeVerification(beginVerification());
	await Bun.sleep(600);
	expect(outcomes).toEqual([["second", "start", 95, { success: true }]]);
});
