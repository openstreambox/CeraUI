import { type SharingPolicy, sharingPolicySchema } from "@ceraui/rpc/schemas";
import type { SteeringUplink } from "./contracts.ts";

export const DEFAULT_SHARING_POLICY: SharingPolicy = {
	mode: "automatic",
	priorities: { wired: 0, cellular: 0, wifi: 0 },
	administrativelyDown: [],
};

export function sharingUplinkKind(
	ifname: string,
): "wired" | "cellular" | "wifi" {
	if (ifname.startsWith("wl")) return "wifi";
	if (/^(ww|ppp|usb)/.test(ifname)) return "cellular";
	return "wired";
}

/** Exclusions retire flows; priority-only changes retain support for old marks. */
export function applySharingPolicy<
	T extends { readonly uplink: SteeringUplink },
>(candidates: readonly T[], policy: SharingPolicy): T[] {
	const eligible = candidates.filter(({ uplink }) => {
		if (policy.administrativelyDown.includes(uplink.ifname)) return false;
		const kind = sharingUplinkKind(uplink.ifname);
		return policy.mode === "automatic" || policy.mode === `${kind}-only`;
	});
	const best = Math.min(
		...eligible
			.filter(({ uplink }) => uplink.selectable && uplink.weight > 0)
			.map(({ uplink }) => policy.priorities[sharingUplinkKind(uplink.ifname)]),
	);
	return eligible.map((candidate) => {
		const selected =
			policy.priorities[sharingUplinkKind(candidate.uplink.ifname)] === best;
		return {
			...candidate,
			uplink: {
				...candidate.uplink,
				selectable: candidate.uplink.selectable && selected,
				weight: selected ? candidate.uplink.weight : 0,
			},
		};
	});
}

/** One in-memory policy; mutations serialize through the existing coordinator. */
export class SharingPolicyOwner {
	#desired = sharingPolicySchema.parse(DEFAULT_SHARING_POLICY);
	#tail: Promise<unknown> = Promise.resolve();
	get(): SharingPolicy {
		return structuredClone(this.#desired);
	}
	set(
		input: SharingPolicy,
		reconcile: () => Promise<void>,
	): Promise<SharingPolicy> {
		const next = sharingPolicySchema.parse(input);
		const operation = this.#tail.then(async () => {
			this.#desired = next;
			await reconcile();
			return this.get();
		});
		this.#tail = operation.catch(() => undefined);
		return operation;
	}
}
export const sharingPolicyOwner = new SharingPolicyOwner();
