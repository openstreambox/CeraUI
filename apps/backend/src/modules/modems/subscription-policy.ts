/** Carrier policy is subscription evidence; hardware identity is never an input. */
import {
	type BearerIpFamilyDecision,
	resolveBearerIpFamily,
} from "./bearer-ip-family.ts";

export type RequestedFamily = "ipv4" | "ipv6" | "ipv4v6";
export type ObservedGrant = "none" | "ipv4" | "ipv6" | "ipv4v6";
export type TransportMode = "qmi" | "mbim" | "rndis";

export interface SubscriptionEvidence {
	readonly homePlmn?: string;
	readonly servingPlmn?: string;
	readonly spn?: string;
	readonly gid1?: string;
	/**
	 * `modem.3gpp.registration-state` as mmcli prints it. The serving network
	 * stands in for a missing home PLMN only while the modem reports a home
	 * registration: a roaming SIM must not adopt its host network's settings.
	 */
	readonly registration?: string;
	/** `modem.3gpp.eps.initial-bearer.settings.ip-type`; family evidence only. */
	readonly attachIpType?: string;
}

export interface CarrierPolicy {
	readonly key: string;
	readonly plmns: readonly string[];
	readonly gid1?: string;
	readonly spn?: string;
	readonly apn: string;
	readonly qualified: boolean;
}

const ATT = ["310280", "310410"];
const TMO = ["310240", "310260"];
export const CARRIER_POLICIES: readonly CarrierPolicy[] = [
	{
		key: "us-mobile-att",
		plmns: ATT,
		gid1: "20FF",
		apn: "ereseller",
		qualified: true,
	},
	{
		key: "us-mobile-tmo",
		plmns: TMO,
		gid1: "6910",
		apn: "fast.t-mobile.com",
		qualified: true,
	},
	{
		key: "us-mobile-att-spn",
		plmns: ATT,
		spn: "usmobile",
		apn: "ereseller",
		qualified: true,
	},
	{
		key: "verizon",
		plmns: ["310590", "310890", "311270", "311480", "312770"],
		apn: "vzwinternet",
		qualified: false,
	},
	{
		key: "t-mobile",
		plmns: TMO,
		apn: "fast.t-mobile.com",
		qualified: true,
	},
	{
		key: "att",
		plmns: ATT,
		apn: "broadband",
		qualified: true,
	},
];

export type SubscriptionDecision =
	| { readonly state: "unknown" }
	| {
			readonly state: "recognized" | "not-qualified";
			readonly policy: CarrierPolicy;
			readonly evidence: "home" | "serving-fallback";
	  };

function normalizedSpn(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function servingIsHome(registration: string | undefined): boolean {
	// "home", "home-sms-only", "home-csfb-not-preferred"; never "roaming*".
	return /^home(?:-|$)/.test(registration?.trim().toLowerCase() ?? "");
}

/**
 * A known (including unknown-to-us) home PLMN always wins over roaming. Without
 * one, the serving PLMN is used only on a home registration.
 */
export function selectSubscription(
	evidence: SubscriptionEvidence,
): SubscriptionDecision {
	const home = evidence.homePlmn?.trim();
	const hasHome = home !== undefined && home !== "" && home !== "--";
	const plmn = hasHome
		? home
		: servingIsHome(evidence.registration)
			? evidence.servingPlmn?.trim()
			: undefined;
	if (plmn === undefined || !/^\d{5,6}$/.test(plmn))
		return { state: "unknown" };
	const spn = normalizedSpn(evidence.spn ?? "");
	const gid = evidence.gid1?.trim().toUpperCase() ?? "";
	const policy = CARRIER_POLICIES.find(
		(row) =>
			row.plmns.includes(plmn) &&
			(row.gid1 === undefined || gid.startsWith(row.gid1)) &&
			(row.spn === undefined || spn === row.spn),
	);
	return policy === undefined
		? { state: "unknown" }
		: {
				state: policy.qualified ? "recognized" : "not-qualified",
				policy,
				evidence: hasHome ? "home" : "serving-fallback",
			};
}

/**
 * The bearer family comes from the one resolver the running profile
 * reconciliation already uses, so a planned profile and the live convergence
 * never disagree. This table only chooses the APN.
 */
export function subscriptionBearerFamily(
	evidence: SubscriptionEvidence,
): BearerIpFamilyDecision {
	return resolveBearerIpFamily({
		simOperatorCode: evidence.homePlmn,
		networkOperatorCode: evidence.servingPlmn,
		attachIpType: evidence.attachIpType,
	});
}

/** Translation follows the observed grant, never the requested PDP family. */
export function requiresClat(grant: ObservedGrant): boolean {
	return grant === "ipv6";
}
