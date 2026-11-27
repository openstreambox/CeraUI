import { getConfig, saveConfig } from "../config.ts";
import type { PhysicalBondKeys } from "../modems/physical-identity.ts";
import { resolveBondPhysicalIdentity } from "../streaming/bond-entry.ts";
import {
	hasNetdevWitness,
	type NetdevWitness,
	netdevEvidenceContinues,
	onNetdevRetired,
	readNetdevWitness,
} from "./netdev-lifetime.ts";

/*
  A link with no physical identity (anchor `ifname`: an onboard radio, a
  PCIe or SDIO netdev) keeps the operator's bond toggle only for this process,
  under its name, together with the kernel netdev the toggle was set on.

  The toggle belongs to that netdev, not to the published row. A radio that
  loses its access point loses its row (RUNNING dropped) and is retired with
  it, then comes back on the next association: the same netdev, and the
  operator's "out of the bond" still holds. Another netdev under the name (a
  different radio plugged in, a re-enumeration) does not inherit it, whether or
  not a retirement was seen in between, because every read checks that the live
  netdev continues the recorded one (same ifindex or sysfs node, nothing
  different). A toggle recorded without kernel evidence keeps the old rule: it
  lasts until the name is retired.
*/
const sessionOptOut = new Map<string, NetdevWitness>();

export const bondPreferenceReaders = {
	witness: readNetdevWitness,
};

onNetdevRetired((ifname, _epoch, _fencePoll, _retired, replaced) => {
	const held = sessionOptOut.get(ifname);
	if (held === undefined) return;
	if (!replaced && hasNetdevWitness(held) && sessionOptOutHolds(ifname, held))
		return;
	sessionOptOut.delete(ifname);
});

/** The live netdev under `ifname` is still the one the toggle was set on. */
function sessionOptOutHolds(ifname: string, held: NetdevWitness): boolean {
	if (!hasNetdevWitness(held)) return true;
	const live = bondPreferenceReaders.witness(ifname);
	// An unreadable read is no evidence either way: the toggle stays.
	if (live.present === undefined && !hasNetdevWitness(live)) return true;
	return live.present !== false && netdevEvidenceContinues(held, live);
}

function hasSessionOptOut(ifname: string): boolean {
	const held = sessionOptOut.get(ifname);
	if (held === undefined) return false;
	if (sessionOptOutHolds(ifname, held)) return true;
	sessionOptOut.delete(ifname);
	return false;
}

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
		if (hasSessionOptOut(name) || (phase === "after" && name === target))
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
	if (hasSessionOptOut(ifname)) return true;
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return false;
	return hasStoredOptOut(identity, getConfig().bond_opt_out);
}

export function setPersistentBondOptOut(
	ifname: string,
	optOut: boolean,
): string | undefined {
	if (optOut) sessionOptOut.set(ifname, bondPreferenceReaders.witness(ifname));
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
