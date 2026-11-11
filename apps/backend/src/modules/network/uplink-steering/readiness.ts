import type { ClientZone } from "./contracts.ts";

let zones: readonly ClientZone[] = [];
export function enableSteeringReadiness(): void {
	zones = [];
}
export function publishSteeringReadiness(next: readonly ClientZone[]): void {
	zones = next;
}
export function hotspotSteeringPending(ifname: string): boolean {
	return !zones.some((zone) => zone.ifname === ifname);
}
