/*
  HOW LONG THE SENDER HAS HELD EACH BOND ROW.

  The live bond's carrier rule (`streamloop/srtla-ip-preparation.ts`) counts a
  link as a backup for a Wi-Fi radio that lost its access point only when the
  sender's telemetry shows it carrying. Telemetry is keyed by interface, so
  right after an address change the interface's `carrying` can still describe
  the socket for the old address. This record says since when each `iface ip`
  row has been in every IP list that reached the sender.

  It is stamped in the writer's own settlement (`publishSrtlaBond`'s
  `onSettled`), so it follows publication order for every caller and for the
  writer's own republications after a failed or stuck write, and it uses the
  rows actually written and the time they settled, on a monotonic clock. A
  publication whose IP list did not reach disk changes nothing: the sender is
  still reading the previous list.

  No imports beyond the bond entry type: srtla writes this, the preparation
  reads it.
*/
import type { BondEntry } from "./bind-map.ts";

let clock: () => number = () => performance.now();
const heldSince = new Map<string, number>();

export const bondRowKey = (entry: Pick<BondEntry, "iface" | "ip">) =>
	`${entry.iface} ${entry.ip}`;

/** Monotonic milliseconds, the clock every age is measured on. */
export function bondRowClock(): number {
	return clock();
}

/** An IP list with these rows reached the sender now. */
export function noteBondRowsWritten(entries: readonly BondEntry[]): void {
	const at = clock();
	const keys = new Set(entries.map(bondRowKey));
	for (const key of [...heldSince.keys()])
		if (!keys.has(key)) heldSince.delete(key);
	for (const key of keys) if (!heldSince.has(key)) heldSince.set(key, at);
}

/** Since when `entry` has been in every IP list the sender read, if it is. */
export function bondRowHeldSince(
	entry: Pick<BondEntry, "iface" | "ip">,
): number | undefined {
	return heldSince.get(bondRowKey(entry));
}

export function resetBondRowAgesForTest(): void {
	heldSince.clear();
	clock = () => performance.now();
}

export function setBondRowClockForTest(fn: (() => number) | null): void {
	clock = fn ?? (() => performance.now());
}
