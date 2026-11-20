/*
  withRadioLock on a radio whose lock owner is a composite `mac@...` hotspot
  owner. It must run under that owner (so a hotspot change holding it excludes
  the coordinator) and refuse while the owner is held.
*/
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { seedWifiRadios } from "../../../tests/helpers/wifi-verified-radios.ts";
import * as credentials from "../../wifi/hotspot-credentials.ts";
import {
	ownsWifiAdapterLock,
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "../../wifi/wifi-adapter-lock.ts";
import type { WifiInterface } from "../../wifi/wifi-interfaces.ts";
import { withRadioLock } from "./radio-lock.ts";

const A = "02:00:00:00:a0:01";
const COMPOSITE = `${A}@usb-1`;
const HOTSPOT = "00000000-0000-4000-8000-0000000000c1";
let seeded: Awaited<ReturnType<typeof seedWifiRadios>>;

beforeEach(async () => {
	spyOn(credentials, "getHotspotCredentialOwners").mockImplementation(
		(uuid?: string) => (uuid === HOTSPOT ? [COMPOSITE] : []),
	);
	seeded = await seedWifiRadios();
	await seeded.publish([
		{
			ifname: "wlA",
			mac: A,
			ifindex: 21,
			phy: 1,
			row: {
				saved: {},
				savedAll: {},
				hotspot: { conn: HOTSPOT },
			} as Partial<WifiInterface>,
		},
	]);
});
afterEach(async () => {
	await seeded.restore();
	(
		credentials.getHotspotCredentialOwners as unknown as { mockRestore(): void }
	).mockRestore();
});

test("a composite-owner radio runs under its composite lock", async () => {
	expect(wifiAdapterLockKey(A)).toBe(COMPOSITE);
	const r = await withRadioLock("wlA", async () =>
		ownsWifiAdapterLock(COMPOSITE),
	);
	expect(r).toEqual({ ok: true, value: true });
});

test("a hotspot change holding the composite owner excludes the coordinator", async () => {
	let inner: unknown;
	let ran = false;
	await withWifiAdapterLock(COMPOSITE, async () => {
		inner = await withRadioLock("wlA", async () => {
			ran = true;
		});
	});
	expect(ran).toBe(false);
	expect(inner).toEqual({ ok: false });
});
