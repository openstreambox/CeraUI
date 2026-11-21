/**
 * One name per bonded link, shared by Live, the HUD, Network and the hotspot
 * radio picker.
 *
 * The same link used to read `usb0` on Live, a model and serial number on the
 * Network modem card and "HomeNetwork" in Bonded Links. A streamer names
 * links by what they are, so the name leads with that and the interface id
 * stays available as a secondary detail:
 *
 * - a modem: "SIM 1 · Northwind" (its place among the box's modems and the
 *   operator it is registered on), or "SIM 1" without an operator;
 * - a Wi-Fi radio joined to a network: "Wi-Fi · HomeNetwork";
 * - a Wi-Fi radio named after its MAC (`wlx…`): "USB Wi-Fi (2f27)" while it
 *   has no network;
 * - a USB network device (`usb*`, RNDIS or CDC tethering): "USB tether", which
 *   says nothing about what is on the other end;
 * - anything else: the existing type label ("Ethernet", "Ethernet 2", "Wi-Fi 1").
 *
 * Pure and rune-free: the caller passes the current modem and Wi-Fi snapshots.
 */
import { m } from "@ceraui/i18n/svelte";
import type { ModemList, WifiStatus } from "@ceraui/rpc/schemas";

import { networkRename } from "./NetworkHelper";

const MAC_NAMED_WIFI = /^wlx[0-9a-f]{12}$/;

export interface LinkNameSources {
	readonly modems?: ModemList | undefined;
	readonly wifi?: WifiStatus | undefined;
}

/** The modems in a stable order (by interface id), so "SIM 1" stays SIM 1. */
function modemOrder(modems: ModemList | undefined): string[] {
	return Object.entries(modems ?? {})
		.map(([key, modem]) => modem.ifname || key)
		.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

export function linkName(ifname: string, sources: LinkNameSources): string {
	const modem = Object.entries(sources.modems ?? {}).find(
		([key, entry]) => (entry.ifname || key) === ifname,
	)?.[1];
	if (modem) {
		const n = modemOrder(sources.modems).indexOf(ifname) + 1;
		const operator = modem.status?.network?.trim();
		return operator
			? m["networking.linkName.simOperator"]({ n, operator })
			: m["networking.linkName.sim"]({ n });
	}

	const radio = Object.entries(sources.wifi ?? {}).find(
		([key, entry]) => (entry.ifname || key) === ifname,
	)?.[1];
	if (radio || ifname.startsWith("wl")) {
		const ssid = radio?.available?.find((network) => network.active)?.ssid;
		if (ssid) return m["networking.linkName.wifiNetwork"]({ network: ssid });
		if (MAC_NAMED_WIFI.test(ifname)) {
			return m["networking.linkName.usbWifi"]({ id: ifname.slice(-4) });
		}
	}

	if (/^usb\d+$/.test(ifname)) return m["networking.linkName.usbTether"]();
	return networkRename(ifname);
}

/** A namer bound to one snapshot, for lists. */
export function linkNamer(
	sources: LinkNameSources,
): (ifname: string) => string {
	return (ifname) => linkName(ifname, sources);
}
