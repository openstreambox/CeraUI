/*
  LINKS A DEAD-BEARER RECONNECT HAS STARTED TAKING DOWN.

  The reconnect (`modems/dead-bearer-recovery.ts`) holds the lifecycle
  interlock while its link goes down, but only for a bounded time: a Stream
  Start waits for that hold, so it cannot last as long as NetworkManager may
  take. The link is marked here from the moment the hold is taken until
  NetworkManager shows the device has left the connection, and
  `isBondCandidate` refuses a marked link. A `down` that timed out, or a
  backend that restarted mid-teardown and found the device still deactivating,
  therefore leaves the link out of the bond until a later status poll reads it
  settled. A CLAT translator rides the same bearer; `isBondCandidate` checks
  the TUN's modem, so marking the modem's interface covers both.

  No imports: network-interfaces reads this, and the modem side writes it.
*/

const pending = new Set<string>();
const listeners = new Set<() => void>();

export function setLinkTeardownPending(
	ifnames: readonly string[],
	value: boolean,
): void {
	let changed = false;
	for (const ifname of ifnames) {
		if (ifname === "" || pending.has(ifname) === value) continue;
		if (value) pending.add(ifname);
		else pending.delete(ifname);
		changed = true;
	}
	if (changed) for (const listener of listeners) listener();
}

export function isLinkTeardownPending(ifname: string): boolean {
	return pending.has(ifname);
}

export function linkTeardownPendingIfnames(): readonly string[] {
	return [...pending];
}

/** Called after the set changed; the bond re-derives its members. */
export function onLinkTeardownPendingChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Test-only: forget every mark without notifying. */
export function resetLinkTeardownPendingForTest(): void {
	pending.clear();
}
