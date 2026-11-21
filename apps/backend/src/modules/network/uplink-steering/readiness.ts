import type { ClientZone } from "./contracts.ts";

/*
  Client-zone readiness as last verified against the kernel.

  Each publication records the verified zones together with the netif
  incarnation (kernel lifetime) each zone had when its rules were read back,
  and advances a generation. A hotspot Start completes only on a publication
  that came after its own confirmation and names the same AP lifetime, so a
  zone verified for an earlier AP under the same name never certifies a new
  one. Without steering (a board without client internet) nothing waits.
*/

type VerifiedZone = { readonly ifname: string; readonly incarnation?: number };

let enabled = false;
let zones: readonly VerifiedZone[] = [];
let generation = 0;

export function enableSteeringReadiness(): void {
	enabled = true;
	zones = [];
	generation++;
}

export function publishSteeringReadiness(
	next: readonly ClientZone[],
	incarnationOf: (ifname: string) => number | undefined = () => undefined,
): void {
	zones = next.map(({ ifname }) => {
		const incarnation = incarnationOf(ifname);
		return incarnation === undefined ? { ifname } : { ifname, incarnation };
	});
	generation++;
}

export function steeringReadinessEnabled(): boolean {
	return enabled;
}

export function steeringReadinessGeneration(): number {
	return generation;
}

/** Display hint only: is this AP interface still waiting for verified rules? */
export function hotspotSteeringPending(ifname: string): boolean {
	return enabled && !zones.some((zone) => zone.ifname === ifname);
}

/** Completion proof: a later verification of exactly this AP lifetime. */
export function hotspotSteeringVerified(
	ifname: string,
	incarnation: number | undefined,
	since: number,
): boolean {
	if (!enabled) return true;
	return (
		incarnation !== undefined &&
		generation > since &&
		zones.some(
			(zone) => zone.ifname === ifname && zone.incarnation === incarnation,
		)
	);
}

export function resetSteeringReadinessForTest(): void {
	enabled = false;
	zones = [];
	generation = 0;
}
