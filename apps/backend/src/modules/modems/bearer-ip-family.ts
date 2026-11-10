/*
  WHICH IP FAMILY A MODEM PROFILE ASKS THE NETWORK FOR.

  NetworkManager has no "PDP type" property on a gsm profile. It derives the
  bearer request from the two IP method settings:

      ipv4 enabled, ipv6 ignore/disabled  ->  IPv4 only
      ipv4 disabled, ipv6 enabled         ->  IPv6 only
      both enabled                        ->  IPv4v6 first, then a single family
                                              when the other one's `may-fail`
                                              allows it (the default)

  Every profile used to be created with `ipv6.method ignore`, i.e. IPv4 only. A
  carrier that runs its data network on IPv6 alone (IPv4 reached through NAT64)
  cannot give such a request a usable bearer: the modem registers, shows signal,
  and never connects.

  The policy here is deliberately narrow. A changed request can be refused on a
  SIM that works today, so dual-stack is asked for only on positive evidence:

  - the SIM or the serving network belongs to a carrier known to be IPv6-only;
  - the network itself negotiated an IPv6-only attach bearer.

  Everything else keeps the IPv4-only request it always had.
*/

import type { ConnectionUUID } from "../network/network-manager.ts";

export type BearerIpFamily = "ipv4" | "ipv4v6" | "ipv6";

export type BearerIpFamilySource = "default" | "operator" | "attach-bearer";

export type BearerIpFamilyDecision = {
	readonly family: BearerIpFamily;
	readonly source: BearerIpFamilySource;
};

/**
 * PLMNs (MCC+MNC) whose packet core is IPv6-only with NAT64/464XLAT.
 *
 * Membership means "an IPv4-only request is known not to work here", not "IPv6
 * is available": most carriers offer dual-stack and are intentionally absent.
 */
const IPV6_ONLY_OPERATORS: ReadonlySet<string> = new Set([
	// T-Mobile US
	"310160",
	"310200",
	"310210",
	"310220",
	"310230",
	"310240",
	"310250",
	"310260",
	"310270",
	"310310",
	"310490",
	"310660",
	"310800",
]);

export type BearerIpFamilyEvidence = {
	/** `sim.properties.operator-code`; some SIMs do not publish one. */
	readonly simOperatorCode?: string | undefined;
	/** `modem.3gpp.operator-code` of the network the modem is registered on. */
	readonly networkOperatorCode?: string | undefined;
	/** `modem.3gpp.eps.initial-bearer.settings.ip-type` as mmcli prints it. */
	readonly attachIpType?: string | undefined;
};

function isListed(code: string | undefined): boolean {
	return code !== undefined && IPV6_ONLY_OPERATORS.has(code.trim());
}

export function resolveBearerIpFamily(
	evidence: BearerIpFamilyEvidence,
): BearerIpFamilyDecision {
	if (
		isListed(evidence.simOperatorCode) ||
		isListed(evidence.networkOperatorCode)
	) {
		return { family: "ipv4v6", source: "operator" };
	}
	// An attach bearer the network granted as IPv6 alone is a statement by the
	// network. `ipv4v6` there says nothing either way: carriers with working
	// IPv4 report it too.
	if (evidence.attachIpType?.trim().toLowerCase() === "ipv6") {
		return { family: "ipv4v6", source: "attach-bearer" };
	}
	return { family: "ipv4", source: "default" };
}

export type BearerIpFamilyFields = {
	"ipv4.method": "auto" | "disabled";
	"ipv6.method": "auto" | "ignore";
	"ipv6.never-default"?: "yes";
	"ipv6.ip6-privacy"?: "0";
};

/**
 * The NetworkManager settings that produce a request for `family`.
 *
 * `ipv4` is the historical profile, unchanged. The other two add an IPv6
 * address WITHOUT an IPv6 default route in the main table: a cellular link that
 * suddenly became the system's only IPv6 default would attract management
 * traffic away from a wired or Wi-Fi uplink. Per-uplink IPv6 routing belongs to
 * whoever pins the stream sources, not to this profile. Temporary addresses
 * are off so the address a stream is bound to does not rotate underneath it.
 */
export function bearerIpFamilyFields(
	family: BearerIpFamily,
): BearerIpFamilyFields {
	if (family === "ipv4") {
		return { "ipv4.method": "auto", "ipv6.method": "ignore" };
	}
	return {
		"ipv4.method": family === "ipv6" ? "disabled" : "auto",
		"ipv6.method": "auto",
		"ipv6.never-default": "yes",
		"ipv6.ip6-privacy": "0",
	};
}

export type BearerIpFamilyConvergence =
	| "unchanged"
	| "updated"
	| "unreadable"
	| "failed";

export type BearerIpFamilyConvergeDeps = {
	readonly getFields: (
		uuid: ConnectionUUID,
		fields: readonly string[],
	) => Promise<readonly (string | undefined)[] | undefined>;
	readonly setFields: (
		uuid: ConnectionUUID,
		fields: Record<string, string>,
	) => Promise<boolean>;
};

/**
 * Bring an EXISTING profile to the decided family.
 *
 * Only the stored profile is written. Nothing is deactivated or reactivated:
 * NetworkManager reads these settings at its next activation, so a connected
 * bearer (and a stream riding it) is left alone, and a modem that is failing
 * to connect picks the new request up on its next attempt.
 *
 * A read that fails proves nothing about the profile, so it writes nothing.
 */
export async function convergeBearerIpFamily(
	uuid: ConnectionUUID,
	family: BearerIpFamily,
	deps: BearerIpFamilyConvergeDeps,
): Promise<BearerIpFamilyConvergence> {
	const wanted = bearerIpFamilyFields(family) as Record<string, string>;
	const names = Object.keys(wanted);
	const current = await deps.getFields(uuid, names);
	if (current === undefined || current.length < names.length) {
		return "unreadable";
	}
	// nmcli may decorate a numeric value ("0 (disabled)"); the first token is
	// the setting itself.
	const matches = names.every(
		(name, index) => current[index]?.trim().split(/\s+/)[0] === wanted[name],
	);
	if (matches) return "unchanged";
	return (await deps.setFields(uuid, wanted)) ? "updated" : "failed";
}
