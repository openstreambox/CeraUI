import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "../../../tests/helpers/wifi-registry.ts";
import { withWifiAdapterLock } from "../../wifi/wifi-adapter-lock.ts";
import { addWifiInterface } from "../../wifi/wifi-connections.ts";
import type { WifiInterface } from "../../wifi/wifi-interfaces.ts";
import { withRadioLock } from "./radio-lock.ts";

const MAC = "aa:bb:cc:dd:ee:02";

let inherited: ReturnType<typeof isolateWifiRegistry>;

beforeEach(() => {
	inherited = isolateWifiRegistry();
	addWifiInterface(MAC, {
		id: 1,
		ifname: "wlan2",
		conn: null,
		hw: "radio 1",
		available: new Map(),
		saved: {},
		savedAll: {},
	} as WifiInterface);
});

afterEach(() => restoreWifiRegistry(inherited));

describe("coordinator actions under the adapter lock", () => {
	test("a free radio runs the action", async () => {
		expect(await withRadioLock("wlan2", async () => 7)).toEqual({
			ok: true,
			value: 7,
		});
	});

	test("a radio whose lock a hotspot change holds is refused without waiting", async () => {
		let inner: unknown;
		const outer = await withWifiAdapterLock(MAC, async () => {
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
});
