import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "../../../tests/helpers/wifi-registry.ts";
import {
	type SeedRadio,
	seedWifiRadios,
} from "../../../tests/helpers/wifi-verified-radios.ts";
import {
	wifiAdapterLockKeyForIfname,
	withWifiAdapterLock,
} from "../../wifi/wifi-adapter-lock.ts";
import {
	addWifiInterface,
	removeWifiInterface,
} from "../../wifi/wifi-connections.ts";
import type { WifiInterface } from "../../wifi/wifi-interfaces.ts";
import { admitRadio, withRadioLock } from "./radio-lock.ts";

const MAC = "02:00:00:00:c0:02";
const radio = (over: Partial<SeedRadio> = {}): SeedRadio => ({
	ifname: "wlan2",
	mac: MAC,
	ifindex: 31,
	phy: 3,
	...over,
});

let inherited: ReturnType<typeof isolateWifiRegistry>;
let seed: Awaited<ReturnType<typeof seedWifiRadios>>;

beforeEach(async () => {
	inherited = isolateWifiRegistry();
	seed = await seedWifiRadios();
	await seed.publish([radio()]);
});

afterEach(async () => {
	await seed.restore();
	restoreWifiRegistry(inherited);
});

describe("coordinator actions under the adapter lock", () => {
	test("a verified radio runs the action", async () => {
		expect(await withRadioLock("wlan2", async () => 7)).toEqual({
			ok: true,
			value: 7,
		});
	});

	test("a radio whose owner lock a hotspot change holds is refused without waiting", async () => {
		const owner = wifiAdapterLockKeyForIfname("wlan2") as string;
		let inner: unknown;
		const outer = await withWifiAdapterLock(owner, async () => {
			inner = await withRadioLock("wlan2", async () => "scanned");
			return true;
		});
		expect(outer.success).toBe(true);
		expect(inner).toEqual({ ok: false });
	});

	test("an unregistered radio is refused", async () => {
		let ran = false;
		expect(
			await withRadioLock("wlan9", async () => {
				ran = true;
			}),
		).toEqual({ ok: false });
		expect(ran).toBe(false);
	});

	test("a Limited radio (no permanent MAC) is refused", async () => {
		// A new radio whose phy reports no permanent MAC. (The same lifetime
		// would keep its earlier verified identity.)
		await seed.publish([radio({ mac: undefined, ifindex: 41, phy: 4 })]);
		expect(admitRadio("wlan2")).toBeUndefined();
		let ran = false;
		expect(
			await withRadioLock("wlan2", async () => {
				ran = true;
			}),
		).toEqual({ ok: false });
		expect(ran).toBe(false);
	});

	test("a radio whose publication a discovery pass invalidated is refused", async () => {
		seed.invalidate();
		expect(await withRadioLock("wlan2", async () => 1)).toEqual({ ok: false });
		await seed.republish();
		expect(await withRadioLock("wlan2", async () => 1)).toEqual({
			ok: true,
			value: 1,
		});
	});

	test("two registry rows under one name are refused", async () => {
		addWifiInterface("limited:99:9", {
			id: 99,
			ifname: "wlan2",
			conn: null,
			hw: "Fixture",
			available: new Map(),
			saved: {},
			savedAll: {},
		} as WifiInterface);
		try {
			expect(admitRadio("wlan2")).toBeUndefined();
		} finally {
			removeWifiInterface("limited:99:9");
		}
		expect(admitRadio("wlan2")).toBeDefined();
	});

	test("a radio replaced under the same name before the lock is refused", async () => {
		// Sysfs already shows a new lifetime (a replug); no discovery pass yet.
		seed.sysfs([radio({ ifindex: 32 })]);
		let ran = false;
		expect(
			await withRadioLock("wlan2", async () => {
				ran = true;
			}),
		).toEqual({ ok: false });
		expect(ran).toBe(false);
	});
});
