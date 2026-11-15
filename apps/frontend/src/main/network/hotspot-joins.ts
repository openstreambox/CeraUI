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
 */
import type { WifiStatus } from "@ceraui/rpc/schemas";

/** Addresses remembered per access point, oldest dropped first. */
export const HOTSPOT_SEEN_CAP = 256;

export type HotspotJoinTracker = {
	/** Returns how many new devices joined since the previous reading. */
	observe(wifi: WifiStatus | undefined): number;
};

export function createHotspotJoinTracker(): HotspotJoinTracker {
	const seen = new Map<string, Set<string>>();
	return {
		observe(wifi) {
			let joins = 0;
			for (const [device, iface] of Object.entries(wifi ?? {})) {
				const stations = iface.hotspot?.clients?.stations;
				if (stations === undefined) continue;
				const macs = stations.map((station) => station.mac.toLowerCase());
				const known = seen.get(device);
				if (known === undefined) {
					seen.set(device, new Set(macs.slice(-HOTSPOT_SEEN_CAP)));
					continue;
				}
				for (const mac of macs) {
					if (known.has(mac)) continue;
					known.add(mac);
					joins += 1;
					if (known.size > HOTSPOT_SEEN_CAP) {
						const oldest = known.values().next().value;
						if (oldest !== undefined) known.delete(oldest);
					}
				}
			}
			return joins;
		},
	};
}
