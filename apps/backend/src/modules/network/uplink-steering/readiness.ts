import type { ClientZone } from "./contracts.ts";

/*
  Client-zone readiness as last verified against the kernel.

  A verification is bound to the AP lifetime at its entry: when the desired
  state is built (before the async apply and readback) it takes a sequence
  number and the netif incarnation (kernel lifetime) of every interface. A zone
  is published as verified only when its incarnation after the readback equals
  the one at entry; a zone whose interface was replaced meanwhile is left out.
  A hotspot Start completes only on a zone whose verification STARTED after its
  own confirmation and names the same AP lifetime, so neither a zone verified
  for an earlier AP under the same name nor a readback already in flight at the
  confirmation certifies a new one. Without steering (a board without client
  internet) nothing waits.
*/

type VerifiedZone = {
	readonly ifname: string;
	readonly incarnation: number;
	readonly started: number;
};

/** Where a verification began: its sequence and the lifetimes it planned for. */
export type SteeringVerificationEntry = {
	readonly started: number;
	readonly incarnations: ReadonlyMap<string, number | undefined>;
};

let enabled = false;
let zones: readonly VerifiedZone[] = [];
let sequence = 0;

export function enableSteeringReadiness(): void {
	enabled = true;
	zones = [];
}

/** Take this at plan time, before any await that precedes the readback. */
export function beginSteeringVerification(
	ifnames: Iterable<string>,
	incarnationOf: (ifname: string) => number | undefined,
): SteeringVerificationEntry {
	sequence++;
	const incarnations = new Map<string, number | undefined>();
	for (const ifname of ifnames) incarnations.set(ifname, incarnationOf(ifname));
	return { started: sequence, incarnations };
}

/** A fence records this at confirmation; only later entries can certify it. */
export function steeringVerificationMark(): number {
	return sequence;
}

/**
 * Publish the zones a readback verified. Without an entry nothing is verified
 * (only clearing calls omit it); each zone must still have its entry lifetime.
 */
export function publishSteeringReadiness(
	next: readonly ClientZone[],
	entry?: SteeringVerificationEntry,
	incarnationOf: (ifname: string) => number | undefined = () => undefined,
): void {
	if (entry === undefined) {
		zones = [];
		return;
	}
	const verified: VerifiedZone[] = [];
	for (const { ifname } of next) {
		const incarnation = entry.incarnations.get(ifname);
		if (incarnation !== undefined && incarnationOf(ifname) === incarnation)
			verified.push({ ifname, incarnation, started: entry.started });
	}
	zones = verified;
}

export function steeringReadinessEnabled(): boolean {
	return enabled;
}

/** Status hint: is this AP lifetime still waiting for verified rules? */
export function hotspotSteeringPending(
	ifname: string,
	incarnation: number | undefined,
): boolean {
	return (
		enabled &&
		!(
			incarnation !== undefined &&
			zones.some(
				(zone) => zone.ifname === ifname && zone.incarnation === incarnation,
			)
		)
	);
}

/** Completion proof: a verification of exactly this AP lifetime begun after `since`. */
export function hotspotSteeringVerified(
	ifname: string,
	incarnation: number | undefined,
	since: number,
): boolean {
	if (!enabled) return true;
	return (
		incarnation !== undefined &&
		zones.some(
			(zone) =>
				zone.ifname === ifname &&
				zone.incarnation === incarnation &&
				zone.started > since,
		)
	);
}

export function resetSteeringReadinessForTest(): void {
	enabled = false;
	zones = [];
	sequence = 0;
}
