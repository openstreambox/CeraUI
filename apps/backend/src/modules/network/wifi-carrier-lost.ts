/*
  WI-FI LINKS WHOSE RADIO HAS LOST ITS ACCESS POINT.

  The carrier watch (`wifi-carrier-watch.ts`) marks a Wi-Fi station here when
  the kernel has reported its carrier down for longer than the hold, and clears
  the mark once the carrier is back and has settled. The live bond publication
  (`streamloop/srtla-ip-preparation.ts`) leaves marked links out of the list it
  hands the sender on a live refresh, unless no other entry in that list can
  carry: then it keeps them all, so the sender keeps its connections for a
  radio that re-associates within a second or two.

  Nothing else reads it. Bond membership (`isBondCandidate`), the netif rows,
  bond toggles, radio identity and every other gate are untouched: a marked
  link is still a bond candidate, it just carries nothing while it is deaf.
  Only a live refresh applies it: a launch or a restoration publishes the
  bond as before, because nothing would bring a link left out there back.

  No imports: the watcher writes this, network-interfaces and the publication
  read it.
*/

const lost = new Map<string, number | undefined>();
const down = new Set<string>();
const listeners = new Set<() => void>();

/**
 * Mark (or clear) a link whose carrier stayed down past the hold. `ifindex`
 * binds the mark to the netdev it was set on, so another netdev that takes the
 * name never inherits it.
 */
export function setWifiCarrierLost(
	ifname: string,
	value: boolean,
	ifindex?: number,
): void {
	if (ifname === "") return;
	if (!value) {
		if (!lost.delete(ifname)) return;
	} else {
		if (lost.has(ifname) && lost.get(ifname) === ifindex) return;
		lost.set(ifname, ifindex);
	}
	for (const listener of listeners) listener();
}

/** The mark on `ifname`, with the ifindex it was set on, if any. */
export function wifiCarrierLostMark(
	ifname: string,
): { readonly ifindex: number | undefined } | undefined {
	return lost.has(ifname) ? { ifindex: lost.get(ifname) } : undefined;
}

export function wifiCarrierLostIfnames(): readonly string[] {
	return [...lost.keys()];
}

/**
 * The carrier is down right now (inside the hold or past it). Not notified:
 * it only stops such a link from counting as a survivor when a mark changes.
 */
export function setWifiCarrierDown(ifname: string, value: boolean): void {
	if (value) down.add(ifname);
	else down.delete(ifname);
}

export function isWifiCarrierDown(ifname: string): boolean {
	return down.has(ifname);
}

/** Called after the marks changed; the bond re-derives its members. */
export function onWifiCarrierLostChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Test-only: forget every mark without notifying. */
export function resetWifiCarrierLostForTest(): void {
	lost.clear();
	down.clear();
}
