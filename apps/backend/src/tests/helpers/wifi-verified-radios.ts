import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
	removeWifiInterface,
} from "../../modules/wifi/wifi-connections.ts";
import type { WifiInterface } from "../../modules/wifi/wifi-interfaces.ts";
import { wifiRadioIdentity } from "../../modules/wifi/wifi-radio-identity.ts";
import { invalidateWifiRadioRow } from "../../modules/wifi/wifi-radio-publication.ts";
import type { RadioFixture } from "./wifi-radio-equivalence.ts";
import { fakeShadowSysfs } from "./wifi-radio-equivalence-shadow.ts";

export type SeedRadio = {
	readonly ifname: string;
	/** Permanent MAC the phy reports; undefined leaves the radio Limited. */
	readonly mac: string | undefined;
	readonly ifindex: number;
	readonly phy: number;
	readonly row?: Partial<WifiInterface>;
};

/**
 * Publish registry rows through the real identity producer, keyed the way
 * discovery keys them: a verified radio under its permanent MAC, a Limited one
 * under `limited:<ifindex>:<wiphy>`. Each call replaces the previous radios with
 * NEW row objects, which is what a replug looks like to the registry.
 */
export async function seedWifiRadios() {
	let fixtures: RadioFixture[] = [];
	let keys: string[] = [];
	const restoreSysfs = await fakeShadowSysfs(() => fixtures);
	const fixturesOf = (radios: readonly SeedRadio[]): RadioFixture[] =>
		radios.map((r) => ({
			ifname: r.ifname,
			operational: r.mac,
			permanent: r.mac,
			ifindex: r.ifindex,
			phy: r.phy,
			state: "disconnected",
		}));
	const publish = async (radios: readonly SeedRadio[]) => {
		for (const key of keys) removeWifiInterface(key);
		fixtures = fixturesOf(radios);
		const rows = radios.map(
			(r, index): WifiInterface =>
				({
					id: 40 + index,
					ifname: r.ifname,
					conn: null,
					hw: "Fixture",
					available: new Map(),
					saved: {},
					savedAll: {},
					...r.row,
				}) as WifiInterface,
		);
		await wifiRadioIdentity.discover(
			rows.map((row) => ({ ifname: row.ifname, row })),
		);
		keys = [];
		for (const row of rows) {
			const key = wifiRadioIdentity.state.rows.get(row.ifname)?.key;
			if (!key) throw new Error(`No identity for ${row.ifname}`);
			addWifiInterface(key, row);
			keys.push(key);
		}
		return Object.fromEntries(
			keys.map((key) => [key, getWifiInterfacesByMacAddress()[key]]),
		) as Record<string, WifiInterface>;
	};
	return {
		publish,
		/** Change what sysfs reports without a discovery pass publishing it. */
		sysfs(radios: readonly SeedRadio[]) {
			fixtures = fixturesOf(radios);
		},
		/** A discovery pass finished: the same row objects are republished. */
		async republish() {
			await wifiRadioIdentity.discover(
				Object.values(getWifiInterfacesByMacAddress()).map((row) => ({
					ifname: row.ifname,
					row,
				})),
			);
		},
		/** A discovery pass started: every row's publication is invalidated. */
		invalidate() {
			const observation = wifiRadioIdentity.captureObservation();
			for (const row of Object.values(getWifiInterfacesByMacAddress()))
				invalidateWifiRadioRow(row, observation);
		},
		async restore() {
			for (const key of keys) removeWifiInterface(key);
			keys = [];
			fixtures = [];
			await restoreSysfs();
		},
	};
}
