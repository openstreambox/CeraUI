/*
    A station connect, password join or forget holds the adapter lock while its
    nmcli work runs, not only while it is being dispatched.

    The procedures used to release the lock as soon as the handler was started
    (`void handleWifi`), so a hotspot start or a mode restore was admitted on the
    same radio while NetworkManager was still activating the station. Whichever
    activation reached NetworkManager last won: the operator saw "connected",
    then the radio turned into an access point with no refusal anywhere.

    nmcli giving up (its `-w` deadline or the process deadline) does not cancel
    the daemon's activation either, so a refused join could complete later and
    undo whatever took the radio next. While the lock is still held, an
    activation of the requested network that is new since the attempt began is
    taken down by its active path, and one that completed meanwhile is reported
    as joined.
*/

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";

import { call } from "@orpc/server";

import type { MacAddress } from "../modules/network/network-manager.ts";
import * as networkManager from "../modules/network/network-manager.ts";
import { withDeviceLock } from "../modules/network/state/device-lock.ts";
import {
	getWifiState,
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import { setWifiJoinNmcliRunner } from "../modules/wifi/wifi.ts";
import * as wifiConnections from "../modules/wifi/wifi-connections.ts";
import { addWifiInterface } from "../modules/wifi/wifi-connections.ts";
import * as hotspotActivity from "../modules/wifi/wifi-hotspot-activity.ts";
import type { WifiInterfaceWithHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import { getWifiIdToMacAddress } from "../modules/wifi/wifi-interfaces.ts";
import * as diversity from "../modules/wifi/wifi-network-diversity.ts";
import {
	hotspotStartProcedure,
	wifiConnectNewProcedure,
	wifiConnectProcedure,
	wifiForgetProcedure,
} from "../rpc/procedures/wifi.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const MAC = "dc:a6:32:5e:11:02";
const MAC_B = "dc:a6:32:5e:11:03";
const IFNAME = "wlan0";
const IFNAME_B = "wlan1";
const DEVICE_ID = "0";
const SSID = "CeraNet";
const UUID = "4b1c2f0e-8d7a-4e43-9f11-2a6c5d8e9b01";
const PENDING = "9e0d1c2b-3a4f-4b5c-8d6e-7f8091a2b3c4";
const ACTIVE_PATH = "/org/freedesktop/NetworkManager/ActiveConnection/7";
const SUCCESSOR_PATH = "/org/freedesktop/NetworkManager/ActiveConnection/8";
const RUN_ID = "bus-id/:1.5";

type Activation = { uuid: string; path?: string; connected: boolean };
const IDLE: Activation = { uuid: "", connected: false };

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

/** Gates a test opened; teardown releases them so no test inherits a held lock. */
let openGates: (() => void)[] = [];
function gate<T>(value: T) {
	const d = deferred<T>();
	openGates.push(() => d.resolve(value));
	return d;
}

/** Every `wifi` frame the handlers sent to the requesting socket. */
let frames: Record<string, unknown>[] = [];
/** For each station result frame: was the radio's lock held when it was sent? */
let sentLocked: Promise<boolean>[] = [];

function makeContext(): RPCContext {
	const ws = {
		send: (raw: string) => {
			const message = JSON.parse(raw) as { wifi?: Record<string, unknown> };
			if (!message.wifi) return;
			frames.push(message.wifi);
			// A station result (not another request's busy refusal): was the
			// radio still held when it was sent? The busy check is synchronous.
			if (!("connect" in message.wifi || "new" in message.wifi)) return;
			sentLocked.push(
				withDeviceLock(MAC, async () => true).then((r) => !r.success),
			);
		},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

function makeInterface(
	id: number,
	ifname: string,
	saved: Record<string, string> = { [SSID]: UUID },
): WifiInterfaceWithHotspot {
	return {
		id,
		ifname,
		conn: null,
		hw: "Realtek RTL8812BU",
		available: new Map(),
		saved,
		savedAll: Object.fromEntries(
			Object.entries(saved).map(([ssid, uuid]) => [ssid, [uuid]]),
		),
		hotspot: { availableChannels: ["auto"], warnings: {} },
	};
}

/** Is this radio's adapter lock held right now? Takes and drops it if free. */
async function locked(mac: MacAddress = MAC): Promise<boolean> {
	return !(await withDeviceLock(mac, async () => true)).success;
}

/** Wait for `ready` on real time (timers and I/O included), failing after 2 s. */
async function until(ready: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!(await ready())) {
		if (Date.now() > deadline) throw new Error("condition not reached");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const hasFrame = (frame: Record<string, unknown>) => () =>
	frames.some((f) => JSON.stringify(f) === JSON.stringify(frame));

let inherited: ReturnType<typeof isolateWifiRegistry> = [];
let idMap: [string, MacAddress][] = [];
let state: ReturnType<typeof getWifiState> = {};
let scheduled: ReturnType<typeof spy>;
let spies: Mock<(...args: never[]) => unknown>[] = [];
function spy<T extends object, K extends keyof T>(
	target: T,
	key: K,
	// biome-ignore lint/suspicious/noExplicitAny: test doubles for module functions
	impl: (...args: any[]) => any,
) {
	// biome-ignore lint/suspicious/noExplicitAny: test doubles for module functions
	const s = spyOn(target, key as any).mockImplementation(impl as any);
	spies.push(s as unknown as Mock<(...args: never[]) => unknown>);
	return s;
}

/** The radio's current activation, as NetworkManager reports it. */
function activation(current: Activation) {
	spy(networkManager, "readNmDeviceActivation", async () => current);
}

/** nmcli gave up on the activation: the process deadline or its exit 3. */
function connectTimesOut() {
	spy(
		networkManager,
		"nmConnect",
		async (
			_uuid: string,
			_timeout?: number,
			_onActivated?: (path: string) => void,
			onTimeout?: () => void,
		) => {
			onTimeout?.();
			return false;
		},
	);
}

/** Records each teardown; asks the caller's re-check first, like the real one. */
/**
 * Records each teardown. `refuse` plays a teardown that found the activation
 * already completed (`pendingOnly`) and so did nothing.
 */
function teardowns(refuse = false) {
	const downs: {
		uuid: string;
		path: string;
		locked: boolean;
		pendingOnly?: boolean;
	}[] = [];
	spy(
		hotspotActivity,
		"nmDisconnectActivation",
		async (
			uuid: string,
			receipt: { path: string },
			_deps?: unknown,
			_permit?: unknown,
			_current?: unknown,
			options?: { pendingOnly?: boolean },
		) => {
			if (refuse) return false;
			downs.push({
				uuid,
				path: receipt.path,
				locked: await locked(),
				pendingOnly: options?.pendingOnly,
			});
			return true;
		},
	);
	return downs;
}

function observed(path: string, connected: boolean) {
	return spy(hotspotActivity, "observeHotspotActivation", async () => ({
		path,
		runId: RUN_ID,
		ifname: IFNAME,
		connected,
	}));
}

beforeEach(() => {
	inherited = isolateWifiRegistry();
	idMap = Object.entries(getWifiIdToMacAddress()) as [string, MacAddress][];
	state = getWifiState();
	const iface = makeInterface(0, IFNAME);
	addWifiInterface(MAC, iface);
	getWifiIdToMacAddress()[0] = MAC;
	setWifiState({ [MAC]: { ...iface, mode: "station" } });
	onWifiChange(() => {});
	frames = [];
	sentLocked = [];
	spies = [];
	openGates = [];
	spy(wifiConnections, "wifiUpdateScanResult", async () => true);
	scheduled = spy(wifiConnections, "wifiScheduleScanRefresh", () => {});
	spy(networkManager, "nmConnsGet", async () => []);
	spy(networkManager, "readNmDeviceActivation", async () => IDLE);
});

afterEach(async () => {
	try {
		for (const release of openGates) release();
		await until(async () => !(await locked()) && !(await locked(MAC_B)));
		// No station result of any test may leave while its radio is held.
		expect(await Promise.all(sentLocked)).not.toContain(true);
	} finally {
		for (const s of spies) s.mockRestore();
		setWifiJoinNmcliRunner(null);
		const ids = getWifiIdToMacAddress();
		for (const id of Object.keys(ids)) delete ids[Number(id)];
		for (const [id, mac] of idMap) ids[Number(id)] = mac;
		setWifiState(state);
		restoreWifiRegistry(inherited);
	}
});

describe("the adapter lock covers the station's nmcli work", () => {
	test("a saved Connect is answered at once and holds the radio until nmcli answers", async () => {
		const up = gate(false);
		const started = deferred<string | undefined>();
		spy(
			networkManager,
			"nmConnect",
			(
				_uuid: string,
				_t?: number,
				_a?: unknown,
				_o?: unknown,
				ifname?: string,
			) => {
				started.resolve(ifname);
				return up.promise;
			},
		);

		const reply = await call(
			wifiConnectProcedure,
			{ uuid: UUID },
			{ context: makeContext() },
		);
		expect(reply).toEqual({ success: true });
		// The activation is pinned to the radio the procedure locked.
		expect(await started.promise).toBe(IFNAME);

		// NetworkManager is still activating the station: a hotspot start on the
		// same radio is refused instead of taking it over.
		expect(await locked()).toBe(true);
		const start = await call(
			hotspotStartProcedure,
			{ device: DEVICE_ID },
			{ context: makeContext() },
		);
		expect(start).toEqual({ success: false, error: "DEVICE_BUSY" });

		up.resolve(true);
		await until(hasFrame({ connect: true, device: DEVICE_ID }));
		expect(await locked()).toBe(false);
	});

	test("the scan refresh after a Connect runs outside the lock", async () => {
		const refreshed = gate(true);
		spy(wifiConnections, "wifiUpdateScanResult", () => refreshed.promise);
		spy(networkManager, "nmConnect", async () => true);

		await call(
			wifiConnectProcedure,
			{ uuid: UUID },
			{ context: makeContext() },
		);
		await until(async () => !(await locked()));
		expect(frames).not.toContainEqual({ connect: true, device: DEVICE_ID });

		refreshed.resolve(true);
		await until(hasFrame({ connect: true, device: DEVICE_ID }));
	});

	test("a Connect of a profile two radios list locks and activates the same radio", async () => {
		// An unbound profile is listed on every radio; the one already on it wins.
		const b = makeInterface(1, IFNAME_B);
		b.conn = UUID;
		addWifiInterface(MAC_B, b);
		getWifiIdToMacAddress()[1] = MAC_B;
		const up = gate(true);
		const started = deferred<string | undefined>();
		spy(
			networkManager,
			"nmConnect",
			(
				_uuid: string,
				_t?: number,
				_a?: unknown,
				_o?: unknown,
				ifname?: string,
			) => {
				started.resolve(ifname);
				return up.promise;
			},
		);

		await call(
			wifiConnectProcedure,
			{ uuid: UUID },
			{ context: makeContext() },
		);
		expect(await started.promise).toBe(IFNAME_B);
		expect(await locked(MAC_B)).toBe(true);
		expect(await locked(MAC)).toBe(false);

		up.resolve(true);
		await until(hasFrame({ connect: true, device: "1" }));
	});

	test("a password join is answered at once and holds the radio until nmcli answers", async () => {
		const joined = gate(undefined);
		const calls: string[][] = [];
		setWifiJoinNmcliRunner(async (args) => {
			calls.push(args);
			await joined.promise;
			return { stdout: "", stderr: "Error: no network", exitCode: 10 };
		});
		spy(networkManager, "nmConnGetFields", async () => undefined);

		const reply = await call(
			wifiConnectNewProcedure,
			{ device: DEVICE_ID, ssid: "OtherNet", password: "supersecret" },
			{ context: makeContext() },
		);
		expect(reply).toEqual({ success: true });
		await until(() => calls.length === 1);
		expect(await locked()).toBe(true);

		joined.resolve(undefined);
		await until(hasFrame({ new: { error: "generic", device: 0 } }));
		expect(await locked()).toBe(false);
	});

	test("a join whose nmcli throws still ends in a terminal frame", async () => {
		setWifiJoinNmcliRunner(async () => {
			throw new Error("nmcli: secret detail");
		});
		spy(networkManager, "nmConnGetFields", async () => undefined);

		await call(
			wifiConnectNewProcedure,
			{ device: DEVICE_ID, ssid: "OtherNet", password: "supersecret" },
			{ context: makeContext() },
		);
		await until(hasFrame({ new: { error: "generic", device: 0 } }));
	});

	test("a Connect whose nmcli call throws still ends in a terminal frame", async () => {
		spy(networkManager, "nmConnect", async () => {
			throw new Error("nmcli: secret detail");
		});

		await call(
			wifiConnectProcedure,
			{ uuid: UUID },
			{ context: makeContext() },
		);
		await until(hasFrame({ connect: false, device: DEVICE_ID }));
		expect(await locked()).toBe(false);
	});

	test("Forget holds every listing radio until its profiles are deleted, then refreshes outside the lock", async () => {
		addWifiInterface(MAC_B, makeInterface(1, IFNAME_B));
		getWifiIdToMacAddress()[1] = MAC_B;
		const deleted = gate(true);
		const refreshed = gate([] as string[]);
		spy(networkManager, "nmConnGetFields", async () => ["infrastructure"]);
		const deletes: string[] = [];
		spy(networkManager, "nmConnDelete", (uuid: string) => {
			deletes.push(uuid);
			return deleted.promise;
		});
		spy(networkManager, "nmConnsGet", () => refreshed.promise);

		const reply = await call(
			wifiForgetProcedure,
			{ uuid: UUID },
			{ context: makeContext() },
		);
		expect(reply).toEqual({ success: true });
		await until(() => deletes.length === 1);
		expect(deletes).toEqual([UUID]);
		expect(await locked(MAC)).toBe(true);
		expect(await locked(MAC_B)).toBe(true);

		deleted.resolve(true);
		// The saved-list refresh is still waiting, and neither radio is held.
		await until(async () => !(await locked(MAC)) && !(await locked(MAC_B)));
		expect(scheduled).not.toHaveBeenCalled();
		refreshed.resolve([]);
		await until(() => scheduled.mock.calls.length > 0);
	});

	test("Forget also locks a radio that holds a deleted sibling only behind its own profile", async () => {
		const OWN = "0c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5";
		const b = makeInterface(1, IFNAME_B, { [SSID]: OWN });
		b.savedAll = { [SSID]: [OWN, UUID] };
		addWifiInterface(MAC_B, b);
		getWifiIdToMacAddress()[1] = MAC_B;
		const deleted = gate(false);
		spy(networkManager, "nmConnGetFields", async () => ["infrastructure"]);
		spy(networkManager, "nmConnDelete", () => deleted.promise);

		await call(wifiForgetProcedure, { uuid: UUID }, { context: makeContext() });
		await until(async () => await locked(MAC_B));
		expect(await locked(MAC)).toBe(true);
		deleted.resolve(false);
	});

	test("a slow refresh cannot let an older choice outrank a newer one on the radio", async () => {
		const SECOND = "5d6e7f80-91a2-4b3c-8d4e-5f60718293a4";
		const a = makeInterface(0, IFNAME, { [SSID]: UUID, Other: SECOND });
		addWifiInterface(MAC, a);
		const recorded: string[] = [];
		spy(diversity, "beginWifiOperatorChoice", () => ({
			release: () => {},
			record: async (uuid: string) => {
				recorded.push(uuid);
			},
		}));
		spy(networkManager, "nmConnect", async () => true);
		const firstRefresh = gate(true);
		let refreshes = 0;
		spy(wifiConnections, "wifiUpdateScanResult", () =>
			refreshes++ === 0 ? firstRefresh.promise : Promise.resolve(true),
		);

		await call(
			wifiConnectProcedure,
			{ uuid: UUID },
			{ context: makeContext() },
		);
		await until(async () => !(await locked()));
		await call(
			wifiConnectProcedure,
			{ uuid: SECOND },
			{ context: makeContext() },
		);
		await until(() => frames.length === 1);
		// The first Connect's refresh is still stalled, yet its choice came first.
		expect(recorded).toEqual([UUID, SECOND]);
		firstRefresh.resolve(true);
		await until(() => frames.length === 2);
	});
});

describe("a request nmcli gave up on cannot come back later", () => {
	test("a timed-out saved Connect takes its new activation down before releasing the radio", async () => {
		connectTimesOut();
		activation({ uuid: UUID, path: ACTIVE_PATH, connected: false });
		observed(ACTIVE_PATH, false);
		const downs = teardowns();

		await call(
			wifiConnectProcedure,
			{ uuid: UUID },
			{ context: makeContext() },
		);
		await until(hasFrame({ connect: false, device: DEVICE_ID }));

		expect(downs).toEqual([
			{ uuid: UUID, path: ACTIVE_PATH, locked: true, pendingOnly: true },
		]);
		expect(await locked()).toBe(false);
	});

	test("a timed-out saved Connect that completed meanwhile is reported as connected", async () => {
		connectTimesOut();
		activation({ uuid: UUID, path: ACTIVE_PATH, connected: true });
		observed(ACTIVE_PATH, true);
		const downs = teardowns();

		await call(
			wifiConnectProcedure,
			{ uuid: UUID },
			{ context: makeContext() },
		);
		await until(hasFrame({ connect: true, device: DEVICE_ID }));
		expect(downs).toEqual([]);
	});

	test("an activation that completes right before the teardown is reported, not undone", async () => {
		connectTimesOut();
		let reads = 0;
		spy(networkManager, "readNmDeviceActivation", async () => {
			reads++;
			return { uuid: UUID, path: ACTIVE_PATH, connected: reads > 1 };
		});
		observed(ACTIVE_PATH, false);
		const downs = teardowns(true);

		await call(
			wifiConnectProcedure,
			{ uuid: UUID },
			{ context: makeContext() },
		);
		await until(hasFrame({ connect: true, device: DEVICE_ID }));
		expect(downs).toEqual([]);
	});

	test("a successor activation of the same profile is not taken down", async () => {
		connectTimesOut();
		activation({ uuid: UUID, path: ACTIVE_PATH, connected: false });
		observed(SUCCESSOR_PATH, false);
		const downs = teardowns();

		await call(
			wifiConnectProcedure,
			{ uuid: UUID },
			{ context: makeContext() },
		);
		await until(hasFrame({ connect: false, device: DEVICE_ID }));
		expect(downs).toEqual([]);
	});

	for (const [label, result] of [
		[
			"its -w deadline (exit 3)",
			{ stdout: "", stderr: "Error: Timeout expired", exitCode: 3 },
		],
		[
			"the process deadline",
			{ stdout: "", stderr: "", exitCode: 143, timedOut: true },
		],
	] as const) {
		test(`a password join that nmcli abandoned at ${label} takes the requested network's activation down`, async () => {
			setWifiJoinNmcliRunner(async () => result);
			spy(
				networkManager,
				"nmConnGetFields",
				async (uuid: string, fields: readonly string[]) =>
					uuid === PENDING && fields[1] === "802-11-wireless.ssid"
						? ["infrastructure", "OtherNet"]
						: undefined,
			);
			activation({ uuid: PENDING, path: ACTIVE_PATH, connected: false });
			observed(ACTIVE_PATH, false);
			const downs = teardowns();

			await call(
				wifiConnectNewProcedure,
				{ device: DEVICE_ID, ssid: "OtherNet", password: "supersecret" },
				{ context: makeContext() },
			);
			await until(hasFrame({ new: { error: "generic", device: 0 } }));
			expect(downs).toEqual([
				{ uuid: PENDING, path: ACTIVE_PATH, locked: true, pendingOnly: true },
			]);
		});
	}

	test("a completed activation matched only by SSID is left alone and not reported as this join", async () => {
		setWifiJoinNmcliRunner(async () => ({
			stdout: "",
			stderr: "Error: Timeout expired",
			exitCode: 3,
		}));
		spy(networkManager, "nmConnGetFields", async () => [
			"infrastructure",
			"OtherNet",
		]);
		activation({ uuid: PENDING, path: ACTIVE_PATH, connected: true });
		observed(ACTIVE_PATH, true);
		const downs = teardowns();
		const bind = spy(
			networkManager,
			"nmConnSetWifiMacAddress",
			async () => true,
		);

		await call(
			wifiConnectNewProcedure,
			{ device: DEVICE_ID, ssid: "OtherNet", password: "supersecret" },
			{ context: makeContext() },
		);
		await until(hasFrame({ new: { error: "generic", device: 0 } }));
		expect(downs).toEqual([]);
		expect(bind).not.toHaveBeenCalled();
	});

	for (const [label, fields] of [
		["another network", ["infrastructure", "SomeoneElse"]],
		["an access point of the same name", ["ap", "OtherNet"]],
	] as const) {
		test(`an activation of ${label} is left alone after a join timed out`, async () => {
			setWifiJoinNmcliRunner(async () => ({
				stdout: "",
				stderr: "Error: Timeout expired",
				exitCode: 3,
			}));
			spy(networkManager, "nmConnGetFields", async () => [...fields]);
			activation({ uuid: PENDING, path: ACTIVE_PATH, connected: false });
			const observe = observed(ACTIVE_PATH, false);
			const downs = teardowns();

			await call(
				wifiConnectNewProcedure,
				{ device: DEVICE_ID, ssid: "OtherNet", password: "supersecret" },
				{ context: makeContext() },
			);
			await until(hasFrame({ new: { error: "generic", device: 0 } }));
			expect(observe).not.toHaveBeenCalled();
			expect(downs).toEqual([]);
		});
	}
});
