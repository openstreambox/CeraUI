/*
  WI-FI LINKS WHOSE RADIO HAS LOST ITS ACCESS POINT.

  The carrier watch (`wifi-carrier-watch.ts`) marks a Wi-Fi station here when
  the kernel has reported its carrier down for longer than the hold, and clears
  the mark once the carrier is back and has settled. The live bond publication
  (`streamloop/srtla-ip-preparation.ts`) leaves marked links out of the list it
  hands the sender, unless that would leave the list empty: a bond in which
  every link is marked keeps them all, so the sender keeps its connections for
  a radio that re-associates within a second or two.

  Nothing else reads it. Bond membership (`isBondCandidate`), the netif rows,
  bond toggles, radio identity and every other gate are untouched: a marked
  link is still a bond candidate, it just carries nothing while it is deaf.

  No imports: the watcher writes this, network-interfaces and the publication
  read it.
*/

const lost = new Set<string>();
const listeners = new Set<() => void>();

export function setWifiCarrierLost(ifname: string, value: boolean): void {
	if (ifname === "" || lost.has(ifname) === value) return;
	if (value) lost.add(ifname);
	else lost.delete(ifname);
	for (const listener of listeners) listener();
}

export function isWifiCarrierLost(ifname: string): boolean {
	return lost.has(ifname);
}

export function wifiCarrierLostIfnames(): readonly string[] {
	return [...lost];
}

/** Called after the set changed; the bond re-derives its members. */
export function onWifiCarrierLostChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Test-only: forget every mark without notifying. */
export function resetWifiCarrierLostForTest(): void {
	lost.clear();
}
