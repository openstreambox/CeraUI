/**
 * Who joined the box's Wi-Fi since this page started watching, from the hotspot
 * roster the device already broadcasts (`hotspot.clients`, read from the AP's
 * own station dump; a station still in the WPA handshake is not on it).
 *
 * - The FIRST reading of an access point is the baseline: devices already on it
 *   when the page opened (or when the hotspot came up) are not announced.
 * - A device counts as new only the first time this page sees its address on
 *   that access point. A phone that drops and rejoins, for example after a new
 *   password, is not "a new device".
 * - An access point whose roster is absent (stopped, not read yet) keeps what it
 *   has seen, so a restart of the hotspot never re-announces known phones.
 * - The wire roster is capped at 32 rows; joins beyond the visible rows are not
 *   guessed from the count.
 * - Each join names the access point it happened on (device key and radio
 *   incarnation), so a box with two hotspots never pins one's join on the other.
 */
import type { WifiStatus } from "@ceraui/rpc/schemas";

/** Addresses remembered per access point, oldest dropped first. */
export const HOTSPOT_SEEN_CAP = 256;

/** The access point a join happened on: its device key and radio incarnation. */
export type HotspotOwner = {
	readonly device: string;
	readonly incarnation: string | undefined;
};

/** New devices on one access point since the previous reading. */
export type HotspotJoinEvent = HotspotOwner & { readonly count: number };

export type HotspotJoinTracker = {
	/** One event per access point that gained devices since the previous reading. */
	observe(wifi: WifiStatus | undefined): readonly HotspotJoinEvent[];
};

export function sameHotspot(a: HotspotOwner, b: HotspotOwner): boolean {
	return a.device === b.device && a.incarnation === b.incarnation;
}

export function createHotspotJoinTracker(): HotspotJoinTracker {
	const seen = new Map<string, Set<string>>();
	return {
		observe(wifi) {
			const events: HotspotJoinEvent[] = [];
			for (const [device, iface] of Object.entries(wifi ?? {})) {
				const stations = iface.hotspot?.clients?.stations;
				if (stations === undefined) continue;
				const macs = stations.map((station) => station.mac.toLowerCase());
				const known = seen.get(device);
				if (known === undefined) {
					seen.set(device, new Set(macs.slice(-HOTSPOT_SEEN_CAP)));
					continue;
				}
				let joins = 0;
				for (const mac of macs) {
					if (known.has(mac)) continue;
					known.add(mac);
					joins += 1;
					if (known.size > HOTSPOT_SEEN_CAP) {
						const oldest = known.values().next().value;
						if (oldest !== undefined) known.delete(oldest);
					}
				}
				if (joins > 0)
					events.push({ device, incarnation: iface.incarnation, count: joins });
			}
			return events;
		},
	};
}
