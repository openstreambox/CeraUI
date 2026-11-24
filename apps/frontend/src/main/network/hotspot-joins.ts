/**
 * Who joined the box's Wi-Fi since this page started watching, from the hotspot
 * roster the device already broadcasts (`hotspot.clients`, read from the AP's
 * own station dump; a station still in the WPA handshake is not on it).
 *
 * Every reading belongs to one AP LIFETIME, and joins are counted only within
 * it. The wire carries no lifetime id, so a lifetime is what the status frames
 * show: a run of frames in which one device key carries a `hotspot` block (a
 * `hotspot` object means the AP is up) for the same AP identity. That identity
 * is what the wire exposes about the AP: the radio's `incarnation` (the radio
 * binding every hotspot RPC uses), the `mode` (`hotspot` = exclusive AP,
 * `station` + `hotspot` = AP beside a station leg, whose AP interface the wire
 * does not name), and, for an exclusive AP, `conn` (its NetworkManager profile
 * UUID; in hybrid `conn` is the station's and is ignored). `ifname` is not part
 * of it: a renamed interface under the same token is the same radio. A
 * lifetime ends when a frame shows the device without a `hotspot` block
 * (Stop), without the device at all (unplugged), or with another identity
 * (another radio under the same key, a replugged radio, the AP recreated in
 * another mode or from another profile). A Stop and Start that no frame ever
 * showed are invisible to the page.
 *
 * - The FIRST reading of each lifetime is the baseline: devices already on it
 *   when the page opened, or when that AP came up, are not announced. A new
 *   lifetime starts from nothing, so a reading of another radio or of an
 *   earlier lifetime is never diffed against this one's roster.
 * - Within a lifetime a device counts as new only the first time this page sees
 *   its address. A phone that drops and rejoins on the same AP is not "a new
 *   device".
 * - A live AP whose roster is absent (not read yet, or a read that failed)
 *   keeps what it has seen; absence of `clients` is not a Stop.
 * - The wire roster is capped at 32 rows; joins beyond the visible rows are not
 *   guessed from the count.
 * - Each join names the access point and lifetime it happened on, so a box with
 *   two hotspots never pins one's join on the other, and a join can never be
 *   claimed by a card showing a later AP.
 */
import type { WifiInterface, WifiStatus } from "@ceraui/rpc/schemas";

/** Addresses remembered per access point, oldest dropped first. */
export const HOTSPOT_SEEN_CAP = 256;

/**
 * The access point a join happened on: its device key and radio incarnation,
 * plus the page-local AP lifetime when known. A holder without `lifetime`
 * matches any lifetime of that radio; joins always carry one.
 */
export type HotspotOwner = {
	readonly device: string;
	readonly incarnation: string | undefined;
	readonly lifetime?: number | undefined;
};

/** New devices on one access point since the previous reading. */
export type HotspotJoinEvent = HotspotOwner & {
	readonly lifetime: number;
	readonly count: number;
};

export type HotspotJoinTracker = {
	/** One event per access point that gained devices since the previous reading. */
	observe(wifi: WifiStatus | undefined): readonly HotspotJoinEvent[];
	/**
	 * The current lifetime of `device`'s AP when `iface` describes that same
	 * AP, else `undefined` (no AP, not observed yet, or another AP).
	 */
	lifetimeOf(
		device: string,
		iface: WifiInterface | undefined,
	): number | undefined;
	/** A copy of the live APs' lifetimes, for a reactive holder. */
	lifetimes(): HotspotApLifetimes;
};

/** One live AP's lifetime and the identity it was opened for. */
export type HotspotApLifetime = {
	readonly identity: string;
	readonly conn: string;
	readonly lifetime: number;
};

export type HotspotApLifetimes = ReadonlyMap<string, HotspotApLifetime>;

export function sameHotspot(a: HotspotOwner, b: HotspotOwner): boolean {
	return (
		a.device === b.device &&
		a.incarnation === b.incarnation &&
		(a.lifetime === undefined ||
			b.lifetime === undefined ||
			a.lifetime === b.lifetime)
	);
}

/**
 * The AP identity the wire exposes for a row, without `conn`, or `undefined`
 * when the row has no live AP.
 */
export function hotspotApIdentity(
	iface: WifiInterface | undefined,
): string | undefined {
	if (!iface?.hotspot) return undefined;
	return `${iface.incarnation ?? ""}\u0000${iface.mode ?? ""}`;
}

/** An exclusive AP's profile UUID; `""` while unknown or for a hybrid AP. */
function apConn(iface: WifiInterface): string {
	return iface.mode === "hotspot" ? iface.conn : "";
}

type Lifetime = {
	readonly identity: string;
	conn: string;
	readonly lifetime: number;
	seen: Set<string> | undefined;
};

/**
 * Whether `iface` still describes `current`. A profile UUID that only became
 * known (`""` -> uuid, the AP's address landing a tick later) is the same AP; a
 * different known UUID is not.
 */
function sameLifetime(
	current: Pick<Lifetime, "identity" | "conn">,
	iface: WifiInterface,
): boolean {
	if (current.identity !== hotspotApIdentity(iface)) return false;
	const conn = apConn(iface);
	return current.conn === "" || conn === "" || current.conn === conn;
}

/** The lifetime in `lifetimes` of the AP `iface` shows on `device`, if any. */
export function hotspotLifetimeIn(
	lifetimes: HotspotApLifetimes,
	device: string,
	iface: WifiInterface | undefined,
): number | undefined {
	const ap = lifetimes.get(device);
	if (ap === undefined || iface === undefined) return undefined;
	return sameLifetime(ap, iface) ? ap.lifetime : undefined;
}

// Page-wide, so a lifetime token is never reused, even by a new tracker.
let lifetimes = 0;

export function createHotspotJoinTracker(): HotspotJoinTracker {
	const aps = new Map<string, Lifetime>();
	return {
		observe(wifi) {
			const events: HotspotJoinEvent[] = [];
			if (wifi === undefined) return events;
			for (const device of aps.keys())
				if (!Object.hasOwn(wifi, device)) aps.delete(device);
			for (const [device, iface] of Object.entries(wifi)) {
				const identity = hotspotApIdentity(iface);
				if (identity === undefined) {
					aps.delete(device);
					continue;
				}
				let ap = aps.get(device);
				if (ap === undefined || !sameLifetime(ap, iface)) {
					lifetimes += 1;
					ap = {
						identity,
						conn: apConn(iface),
						lifetime: lifetimes,
						seen: undefined,
					};
					aps.set(device, ap);
				}
				if (ap.conn === "") ap.conn = apConn(iface);
				const stations = iface.hotspot?.clients?.stations;
				if (stations === undefined) continue;
				const macs = stations.map((station) => station.mac.toLowerCase());
				const known = ap.seen;
				if (known === undefined) {
					ap.seen = new Set(macs.slice(-HOTSPOT_SEEN_CAP));
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
					events.push({
						device,
						incarnation: iface.incarnation,
						lifetime: ap.lifetime,
						count: joins,
					});
			}
			return events;
		},
		lifetimeOf(device, iface) {
			return hotspotLifetimeIn(aps, device, iface);
		},
		lifetimes() {
			return new Map(
				[...aps].map(([device, { identity, conn, lifetime }]) => [
					device,
					{ identity, conn, lifetime },
				]),
			);
		},
	};
}
