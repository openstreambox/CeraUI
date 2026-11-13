import { afterEach, expect, test } from "bun:test";
import { installHeatWifiWake } from "../modules/wifi/heat-wifi-demand.ts";
import { withWifiAdapterLock } from "../modules/wifi/wifi-adapter-lock.ts";

afterEach(() => installHeatWifiWake(async () => undefined));
test("Wi-Fi admission waits for wake before mutation dispatch", async () => {
	const calls: string[] = [];
	let release = () => {};
	const gate = new Promise<void>((r) => {
		release = r;
	});
	installHeatWifiWake(async () => {
		calls.push("wake");
		await gate;
		calls.push("awake");
	});
	const result = withWifiAdapterLock("02:00:00:00:00:42", async () => {
		calls.push("dispatch");
	});
	await Promise.resolve();
	expect(calls).toEqual(["wake"]);
	const busy = await withWifiAdapterLock("02:00:00:00:00:42", async () => {
		throw Error("must not dispatch");
	});
	expect(busy.success).toBe(false);
	release();
	await result;
	expect(calls).toEqual(["wake", "awake", "dispatch"]);
});
test("wake failure prevents dispatch", async () => {
	installHeatWifiWake(async () => {
		throw Error("not awake");
	});
	let dispatched = false;
	await expect(
		withWifiAdapterLock("02:00:00:00:00:43", async () => {
			dispatched = true;
		}),
	).rejects.toThrow("not awake");
	expect(dispatched).toBe(false);
});

import {
	resetBondOptOut,
	setBondOptOut,
} from "../modules/network/network-interfaces.ts";
import {
	addWifiInterface,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";

test("bond demand wakes the corresponding adapter", async () => {
	const mac = "02:00:00:00:00:44";
	const keys: string[] = [];
	addWifiInterface(mac, {
		id: 44,
		ifname: "wlan-test44",
		hw: "USB",
		conn: null,
		activeConn: null,
		available: new Map(),
		saved: {},
		savedAll: {},
	});
	installHeatWifiWake(async (key) => {
		keys.push(key);
	});
	try {
		setBondOptOut("wlan-test44", false);
		expect(keys).toEqual([mac]);
		await Promise.resolve();
	} finally {
		removeWifiInterface(mac);
		resetBondOptOut();
	}
});
