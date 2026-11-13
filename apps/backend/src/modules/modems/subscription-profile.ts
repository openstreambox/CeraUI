import {
	type SubscriptionEvidence,
	selectSubscription,
} from "./subscription-policy.ts";

export interface ProfileIdentity {
	readonly deviceId: string;
	readonly simId: string;
}
export interface SubscriptionProfile extends ProfileIdentity {
	readonly uuid: string;
	readonly automatic: boolean;
}
export type SubscriptionProfilePlan =
	| {
			readonly action: "preserve";
			readonly reason:
				| "manual"
				| "unknown"
				| "not-qualified"
				| "identity-unresolved"
				| "identity-mismatch";
	  }
	| {
			readonly action: "reconcile" | "create";
			readonly fields: Readonly<Record<string, string>>;
			readonly policy: string;
	  };

/** NM settings follow the source-only IPv6 contract. No runtime writes. */
export function planSubscriptionProfile(
	identity: ProfileIdentity,
	subscription: SubscriptionEvidence,
	profile: SubscriptionProfile | undefined,
): SubscriptionProfilePlan {
	if (!identity.deviceId.trim() || !identity.simId.trim())
		return { action: "preserve", reason: "identity-unresolved" };
	if (
		profile &&
		(profile.deviceId !== identity.deviceId || profile.simId !== identity.simId)
	)
		return { action: "preserve", reason: "identity-mismatch" };
	if (profile?.automatic === false)
		return { action: "preserve", reason: "manual" };
	const decision = selectSubscription(subscription);
	if (decision.state !== "recognized")
		return { action: "preserve", reason: decision.state };
	const family = decision.policy.requestFamily;
	return {
		action: profile ? "reconcile" : "create",
		policy: decision.policy.key,
		fields: {
			"gsm.device-id": identity.deviceId,
			"gsm.sim-id": identity.simId,
			"gsm.apn": decision.policy.apn,
			"gsm.auto-config": "no",
			"ipv4.method": family === "ipv6" ? "disabled" : "auto",
			"ipv6.method": family === "ipv4" ? "ignore" : "auto",
			...(family === "ipv4"
				? {}
				: {
						"ipv6.never-default": "yes",
						"ipv6.ignore-auto-dns": "yes",
						"ipv6.ip6-privacy": "0",
					}),
		},
	};
}
