/** Carrier policy is subscription evidence; hardware identity is never an input. */
export type RequestedFamily = "ipv4" | "ipv6" | "ipv4v6";
export type ObservedGrant = "none" | "ipv4" | "ipv6" | "ipv4v6";
export type TransportMode = "qmi" | "mbim" | "rndis";

export interface SubscriptionEvidence {
	readonly homePlmn?: string;
	readonly servingPlmn?: string;
	readonly spn?: string;
	readonly gid1?: string;
}

export interface CarrierPolicy {
	readonly key: string;
	readonly plmns: readonly string[];
	readonly gid1?: string;
	readonly spn?: string;
	readonly apn: string;
	readonly requestFamily: RequestedFamily;
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
		requestFamily: "ipv4v6",
		qualified: true,
	},
	{
		key: "us-mobile-tmo",
		plmns: TMO,
		gid1: "6910",
		apn: "fast.t-mobile.com",
		requestFamily: "ipv4v6",
		qualified: true,
	},
	{
		key: "us-mobile-att-spn",
		plmns: ATT,
		spn: "usmobile",
		apn: "ereseller",
		requestFamily: "ipv4v6",
		qualified: true,
	},
	{
		key: "verizon",
		plmns: ["310590", "310890", "311270", "311480", "312770"],
		apn: "vzwinternet",
		requestFamily: "ipv4v6",
		qualified: false,
	},
	{
		key: "t-mobile",
		plmns: TMO,
		apn: "fast.t-mobile.com",
		requestFamily: "ipv4v6",
		qualified: true,
	},
	{
		key: "att",
		plmns: ATT,
		apn: "broadband",
		requestFamily: "ipv4v6",
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

/** A known (including unknown-to-us) home PLMN always wins over roaming. */
export function selectSubscription(
	evidence: SubscriptionEvidence,
): SubscriptionDecision {
	const home = evidence.homePlmn?.trim();
	const hasHome = home !== undefined && home !== "" && home !== "--";
	const plmn = hasHome ? home : evidence.servingPlmn?.trim();
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

/** Serving-network recognition is diagnostic only. Automatic APN, attach and
 * call policy requires subscription home identity, including reseller evidence.
 * An unreadable home code must not turn roaming into a different carrier.
 */
export function selectAutomaticSubscription(
	evidence: SubscriptionEvidence,
): SubscriptionDecision {
	const decision = selectSubscription(evidence);
	return decision.state !== "unknown" && decision.evidence !== "home"
		? { state: "unknown" }
		: decision;
}

/** Translation follows the observed grant, never the requested PDP family. */
export function requiresClat(grant: ObservedGrant): boolean {
	return grant === "ipv6";
}
