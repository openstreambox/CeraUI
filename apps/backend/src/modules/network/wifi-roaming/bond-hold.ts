/**
 * Interfaces the two-radio search keeps out of the SRTLA bond while it scans
 * or joins with them. The bond-membership rule consults this set, and a live
 * stream republishes its link list when it changes.
 */
const held = new Set<string>();
const listeners = new Set<() => void>();

function changed(): void {
	for (const listener of listeners) {
		try {
			listener();
		} catch {
			// A failing listener must not stop the others or the caller.
		}
	}
}

export function holdOutOfBond(ifname: string): void {
	if (held.has(ifname)) return;
	held.add(ifname);
	changed();
}

export function releaseBondHold(ifname: string): void {
	if (!held.delete(ifname)) return;
	changed();
}

export function isHeldOutOfBond(ifname: string): boolean {
	return held.has(ifname);
}

/** Subscribe to hold changes; returns the unsubscribe function. */
export function onBondHoldChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Test seam: forget every hold and listener. */
export function resetBondHoldsForTest(): void {
	held.clear();
	listeners.clear();
}
