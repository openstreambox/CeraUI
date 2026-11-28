import { getConfig, saveConfig } from "../config.ts";
import type { PhysicalBondKeys } from "../modems/physical-identity.ts";
import { resolveBondPhysicalIdentity } from "../streaming/bond-entry.ts";
import { onNetdevRetired } from "./netdev-lifetime.ts";

const sessionOptOut = new Set<string>();

onNetdevRetired((ifname) => sessionOptOut.delete(ifname));

export function bondPhysicalId(ifname: string): string | undefined {
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return undefined;
	return identity.linkId;
}

/**
 * Read-only view of the exclusion change a disable would make. A stable key
 * can exclude multiple live rows. Preferences are keyed by the exact link id
 * only: an older serial spelling is neither honoured nor migrated.
 */
export function previewBondOptOut(
	target: string,
	identity: PhysicalBondKeys | undefined,
) {
	const stored = getConfig().bond_opt_out;
	const next =
		identity === undefined || identity.anchor === "ifname"
			? stored
			: transitionExactOptOut(stored, identity.linkId, true);
	return (
		name: string,
		peer: PhysicalBondKeys | undefined,
		phase: "before" | "after",
	) => {
		if (sessionOptOut.has(name) || (phase === "after" && name === target))
			return true;
		return hasStoredOptOut(peer, phase === "after" ? next : stored);
	};
}

type ExactOptOut = NonNullable<ReturnType<typeof getConfig>["bond_opt_out"]>;

function hasStoredOptOut(
	identity: PhysicalBondKeys | undefined,
	stored: ExactOptOut | undefined,
): boolean {
	return (
		identity !== undefined &&
		identity.anchor !== "ifname" &&
		stored?.[identity.linkId] === true
	);
}

function transitionExactOptOut(
	stored: ExactOptOut | undefined,
	exact: string,
	optOut: boolean,
): ExactOptOut {
	const next = { ...stored };
	if (optOut) next[exact] = true;
	else delete next[exact];
	return next;
}

export function isBondOptedOut(ifname: string): boolean {
	if (sessionOptOut.has(ifname)) return true;
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return false;
	return hasStoredOptOut(identity, getConfig().bond_opt_out);
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
	const next = transitionExactOptOut(
		getConfig().bond_opt_out,
		physicalId,
		optOut,
	);
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
