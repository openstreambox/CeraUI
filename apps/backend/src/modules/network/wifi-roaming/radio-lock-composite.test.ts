/*
  withRadioLock on a radio whose hotspot profile names a composite `mac@...`
  credential owner. Hotspot operations on the radio and the coordinator must
  serialize on one key: the coordinator runs under the key a hotspot change on
  that radio takes (`wifiAdapterLockKey`), and refuses while that key is held.
  With upstream's adapter identity a verified radio's lock domain is its
  permanent MAC; a credential owner no longer splits it.
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

test("a radio with a composite-owner hotspot runs under the key hotspot changes take", async () => {
	const owner = wifiAdapterLockKey(A);
	expect(owner).toBe(A);
	const r = await withRadioLock("wlA", null, async () =>
		ownsWifiAdapterLock(owner),
	);
	expect(r).toEqual({ ok: true, value: true });
});

test("a hotspot change holding that radio's key excludes the coordinator", async () => {
	let inner: unknown;
	let ran = false;
	await withWifiAdapterLock(wifiAdapterLockKey(A), async () => {
		inner = await withRadioLock("wlA", null, async () => {
			ran = true;
		});
	});
	expect(ran).toBe(false);
	expect(inner).toEqual({ ok: false });
});
