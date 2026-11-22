import { getConfig, saveConfig } from "../config.ts";
import {
	listPresentPhysicalDevices,
	type PhysicalDeviceRecord,
} from "../modems/physical-identity.ts";
import { resolveBondPhysicalIdentity } from "../streaming/bond-entry.ts";

const sessionOptOut = new Set<string>();

export function bondPhysicalId(ifname: string): string | undefined {
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return undefined;
	return identity.linkId;
}

function serialAliases(identity: PhysicalDeviceRecord): string[] {
	return [identity.legacyLinkId, identity.serialLinkId].filter(
		(id): id is string => id !== undefined && id !== identity.linkId,
	);
}

export function isBondOptedOut(ifname: string): boolean {
	if (sessionOptOut.has(ifname)) return true;
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return false;
	const stored = getConfig().bond_opt_out;
	return (
		stored?.[identity.linkId] === true ||
		serialAliases(identity).some((id) => stored?.[id] === true)
	);
}

export function setPersistentBondOptOut(
	ifname: string,
	optOut: boolean,
): string | undefined {
	if (optOut) sessionOptOut.add(ifname);
	else sessionOptOut.delete(ifname);
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return undefined;
	const physicalId = identity.linkId;
	const next = { ...getConfig().bond_opt_out };
	for (const alias of new Set(serialAliases(identity))) {
		if (next[alias] !== true) continue;
		for (const present of listPresentPhysicalDevices()) {
			if (
				present.anchor !== "ifname" &&
				serialAliases(present).includes(alias)
			) {
				next[present.linkId] = true;
			}
		}
		delete next[alias];
	}
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
