import { getConfig, saveConfig } from "../config.ts";
import { resolveBondPhysicalIdentity } from "../streaming/bond-entry.ts";

let heatRest: string | null = null;
export function setHeatBondRest(name: string | null): void {
	heatRest = name;
}
/** Out of the bond for heat this session, not by the operator's choice. */
export function isHeatResting(ifname: string): boolean {
	return heatRest === ifname;
}

const sessionOptOut = new Set<string>();

export function bondPhysicalId(ifname: string): string | undefined {
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return undefined;
	return identity.linkId;
}

export function isBondOptedOut(ifname: string): boolean {
	if (heatRest === ifname || sessionOptOut.has(ifname)) return true;
	const physicalId = bondPhysicalId(ifname);
	return (
		physicalId !== undefined && getConfig().bond_opt_out?.[physicalId] === true
	);
}

export function setPersistentBondOptOut(
	ifname: string,
	optOut: boolean,
): string | undefined {
	if (optOut) sessionOptOut.add(ifname);
	else sessionOptOut.delete(ifname);
	const physicalId = bondPhysicalId(ifname);
	if (physicalId === undefined) return undefined;

	const next = { ...getConfig().bond_opt_out };
	if (optOut) next[physicalId] = true;
	else delete next[physicalId];
	getConfig().bond_opt_out = Object.keys(next).length === 0 ? undefined : next;
	saveConfig();
	return physicalId;
}

export function resetPersistentBondOptOutForTest(): void {
	sessionOptOut.clear();
	getConfig().bond_opt_out = undefined;
}

export function resetSessionBondOptOutForTest(): void {
	sessionOptOut.clear();
}
