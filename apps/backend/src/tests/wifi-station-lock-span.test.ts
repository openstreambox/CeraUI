/*
    A station connect, password join or forget holds the adapter lock until its
    nmcli work has answered, not only while it is being dispatched.

    The procedures used to release the lock as soon as the handler was started
    (`void handleWifi`), so a hotspot start or a mode restore was admitted on the
    same radio while NetworkManager was still activating the station. Whichever
    activation reached NetworkManager last won: the operator saw "connected",
    then the radio turned into an access point with no refusal anywhere.

    nmcli giving up (its `-w` deadline or the process deadline) does not cancel
    the daemon's activation either, so a refused join could complete later and
    undo whatever took the radio next. While the lock is still held, an
    activation of the requested network that is still pending is taken down by
    its active path, and one that completed meanwhile is reported as joined.
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

import * as networkManager from "../modules/network/network-manager.ts";
import { withDeviceLock } from "../modules/network/state/device-lock.ts";
import {
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import { setWifiJoinNmcliRunner } from "../modules/wifi/wifi.ts";
import * as wifiConnections from "../modules/wifi/wifi-connections.ts";
import { addWifiInterface } from "../modules/wifi/wifi-connections.ts";
import * as hotspotActivity from "../modules/wifi/wifi-hotspot-activity.ts";
import type { WifiInterfaceWithHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import { getWifiIdToMacAddress } from "../modules/wifi/wifi-interfaces.ts";
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
const IFNAME = "wlan0";
const DEVICE_ID = "0";
const SSID = "CeraNet";
const UUID = "4b1c2f0e-8d7a-4e43-9f11-2a6c5d8e9b01";
const ACTIVE_PATH = "/org/freedesktop/NetworkManager/ActiveConnection/7";
const RECEIPT = {
	path: ACTIVE_PATH,
	runId: "bus-id/:1.5",
	ifname: IFNAME,
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

/** Every `wifi` frame the handlers sent to the requesting socket. */
let frames: Record<string, unknown>[] = [];

function makeContext(): RPCContext {
	const ws = {
		send: (raw: string) => {
			const message = JSON.parse(raw) as { wifi?: Record<string, unknown> };
			if (message.wifi) frames.push(message.wifi);
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

function makeInterface(): WifiInterfaceWithHotspot {
	return {
		id: 0,
		ifname: IFNAME,
		conn: null,
		hw: "Realtek RTL8812BU",
		available: new Map(),
		saved: { [SSID]: UUID },
		savedAll: { [SSID]: [UUID] },
		hotspot: { availableChannels: ["auto"], warnings: {} },
	};
}

/** Is the radio's adapter lock held right now? Takes and drops it if free. */
async function radioLocked(): Promise<boolean> {
	return !(await withDeviceLock(MAC, async () => true)).success;
}

async function settle(): Promise<void> {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

let inherited: ReturnType<typeof isolateWifiRegistry> = [];
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

beforeEach(() => {
	inherited = isolateWifiRegistry();
	const iface = makeInterface();
	addWifiInterface(MAC, iface);
	getWifiIdToMacAddress()[0] = MAC;
	setWifiState({ [MAC]: { ...iface, mode: "station" } });
	onWifiChange(() => {});
	frames = [];
	spies = [];
	spy(wifiConnections, "wifiUpdateScanResult", async () => true);
	spy(wifiConnections, "wifiScheduleScanRefresh", () => {});
	spy(networkManager, "nmConnsGet", async () => []);
});

afterEach(() => {
	for (const s of spies) s.mockRestore();
	setWifiJoinNmcliRunner(null);
	delete getWifiIdToMacAddress()[0];
	setWifiState({});
	restoreWifiRegistry(inherited);
});

describe("the adapter lock covers the station's nmcli work", () => {
	test("a saved Connect is answered at once and holds the radio until nmcli answers", async () => {
		const up = deferred<boolean>();
		spy(networkManager, "nmConnect", () => up.promise);

		const reply = await call(
			wifiConnectProcedure,
			{ uuid: UUID },
			{ context: makeContext() },
		);
		expect(reply).toEqual({ success: true });
		await settle();

		// NetworkManager is still activating the station: a hotspot start on the
		// same radio is refused instead of taking it over.
		expect(await radioLocked()).toBe(true);
		const start = await call(
			hotspotStartProcedure,
			{ device: DEVICE_ID },
			{ context: makeContext() },
		);
		expect(start).toEqual({ success: false, error: "DEVICE_BUSY" });

		up.resolve(true);
		await settle();
		expect(frames).toContainEqual({ connect: true, device: DEVICE_ID });
		expect(await radioLocked()).toBe(false);
	});

	test("a password join is answered at once and holds the radio until nmcli answers", async () => {
		const joined = deferred<void>();
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
		await settle();
		expect(calls.length).toBe(1);
		expect(await radioLocked()).toBe(true);

		joined.resolve();
		await settle();
		expect(frames).toContainEqual({
			new: { error: "generic", device: 0 },
		});
		expect(await radioLocked()).toBe(false);
	});

	test("Forget holds the radio until its profiles are deleted", async () => {
		const deleted = deferred<boolean>();
		spy(networkManager, "nmConnGetFields", async () => ["infrastructure"]);
		const deletes: string[] = [];
		spy(networkManager, "nmConnDelete", (uuid: string) => {
			deletes.push(uuid);
			return deleted.promise;
		});

		const reply = await call(
			wifiForgetProcedure,
			{ uuid: UUID },
			{ context: makeContext() },
		);
		expect(reply).toEqual({ success: true });
		await settle();
		expect(deletes).toEqual([UUID]);
		expect(await radioLocked()).toBe(true);

		deleted.resolve(false);
		await settle();
		expect(await radioLocked()).toBe(false);
	});
});

describe("a request nmcli gave up on cannot come back later", () => {
	test("a timed-out saved Connect takes its pending activation down before releasing the radio", async () => {
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
		spy(networkManager, "readNmDeviceActivation", async () => ({
			uuid: UUID,
			path: ACTIVE_PATH,
			connected: false,
		}));
		spy(hotspotActivity, "observeHotspotActivation", async () => ({
			...RECEIPT,
			connected: false,
		}));
		const downs: { uuid: string; path: string; locked: boolean }[] = [];
		spy(
			hotspotActivity,
			"nmDisconnectActivation",
			async (uuid: string, receipt: { path: string }) => {
				downs.push({ uuid, path: receipt.path, locked: await radioLocked() });
				return true;
			},
		);

		await call(
			wifiConnectProcedure,
			{ uuid: UUID },
			{ context: makeContext() },
		);
		await settle();

		expect(downs).toEqual([{ uuid: UUID, path: ACTIVE_PATH, locked: true }]);
		expect(frames).toContainEqual({ connect: false, device: DEVICE_ID });
		expect(await radioLocked()).toBe(false);
	});

	test("a timed-out saved Connect that completed meanwhile is reported as connected", async () => {
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
		spy(networkManager, "readNmDeviceActivation", async () => ({
			uuid: UUID,
			path: ACTIVE_PATH,
			connected: true,
		}));
		spy(hotspotActivity, "observeHotspotActivation", async () => ({
			...RECEIPT,
			connected: true,
		}));
		const down = spy(
			hotspotActivity,
			"nmDisconnectActivation",
			async () => true,
		);

		await call(
			wifiConnectProcedure,
			{ uuid: UUID },
			{ context: makeContext() },
		);
		await settle();

		expect(down).not.toHaveBeenCalled();
		expect(frames).toContainEqual({ connect: true, device: DEVICE_ID });
	});

	test("a password join whose nmcli deadline expired takes the requested network's activation down", async () => {
		const PENDING = "9e0d1c2b-3a4f-4b5c-8d6e-7f8091a2b3c4";
		setWifiJoinNmcliRunner(async () => ({
			stdout: "",
			stderr: "Error: Timeout expired (15 seconds)",
			exitCode: 3,
		}));
		spy(
			networkManager,
			"nmConnGetFields",
			async (uuid: string, fields: readonly string[]) =>
				uuid === PENDING && fields[0] === "802-11-wireless.ssid"
					? ["OtherNet"]
					: undefined,
		);
		spy(networkManager, "readNmDeviceActivation", async () => ({
			uuid: PENDING,
			path: ACTIVE_PATH,
			connected: false,
		}));
		spy(hotspotActivity, "observeHotspotActivation", async () => ({
			...RECEIPT,
			connected: false,
		}));
		const downs: { uuid: string; locked: boolean }[] = [];
		spy(hotspotActivity, "nmDisconnectActivation", async (uuid: string) => {
			downs.push({ uuid, locked: await radioLocked() });
			return true;
		});

		await call(
			wifiConnectNewProcedure,
			{ device: DEVICE_ID, ssid: "OtherNet", password: "supersecret" },
			{ context: makeContext() },
		);
		await settle();

		expect(downs).toEqual([{ uuid: PENDING, locked: true }]);
		expect(frames).toContainEqual({ new: { error: "generic", device: 0 } });
	});

	test("an activation of another network is left alone after a join timed out", async () => {
		setWifiJoinNmcliRunner(async () => ({
			stdout: "",
			stderr: "Error: Timeout expired (15 seconds)",
			exitCode: 3,
		}));
		spy(networkManager, "nmConnGetFields", async () => ["SomeoneElse"]);
		spy(networkManager, "readNmDeviceActivation", async () => ({
			uuid: UUID,
			path: ACTIVE_PATH,
			connected: false,
		}));
		const observe = spy(
			hotspotActivity,
			"observeHotspotActivation",
			async () => ({ ...RECEIPT, connected: false }),
		);
		const down = spy(
			hotspotActivity,
			"nmDisconnectActivation",
			async () => true,
		);

		await call(
			wifiConnectNewProcedure,
			{ device: DEVICE_ID, ssid: "OtherNet", password: "supersecret" },
			{ context: makeContext() },
		);
		await settle();

		expect(observe).not.toHaveBeenCalled();
		expect(down).not.toHaveBeenCalled();
		expect(frames).toContainEqual({ new: { error: "generic", device: 0 } });
	});
});
