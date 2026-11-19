/**
 * Radios the roaming coordinator owns. Other automation that moves Wi-Fi
 * radios between networks (the preferred-network recovery check, for one)
 * must leave these alone while the coordinator runs, so that two owners never
 * act on one radio.
 */
let owned: ReadonlySet<string> = new Set();

export function setCoordinatorOwnedRadios(ifnames: Iterable<string>): void {
	owned = new Set(ifnames);
}

export function isCoordinatorOwnedRadio(ifname: string): boolean {
	return owned.has(ifname);
}
