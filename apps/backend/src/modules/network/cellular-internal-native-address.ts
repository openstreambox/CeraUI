import { isIPv4 } from "node:net";
import type { CellularPhysicalLink } from "./cellular-host-identity.ts";
import { cellularPhysicalResourceState } from "./cellular-host-identity.ts";
import type { CellularIndexedIpEffect } from "./cellular-indexed-ip.ts";
import {
	type CellularIndexedIpIO,
	CellularIndexedIpState,
	cellularIndexedIpIO,
} from "./cellular-indexed-ip-state.ts";

/** Optional address step of the native host inverse. NetworkManager grants omit
 * ownedAddress entirely. Internal grants persist this physical tuple alongside
 * the routes; the caller journals the address cursor before calling apply.
 */
export interface InternalNativeAddressPlan {
	readonly input: { readonly iface: string; readonly ipv4: string };
	readonly ifindex: number;
	readonly bootId: string;
	readonly ownedAddress?: CellularPhysicalLink | undefined;
}
export function createInternalNativeAddressEffects(
	plan: InternalNativeAddressPlan,
	bootId: string,
	owned: () => boolean,
	io?: CellularIndexedIpIO,
):
	| {
			inspect(): ReturnType<CellularIndexedIpState["inspect"]>;
			apply(): Promise<void>;
			remove(): Promise<boolean>;
	  }
	| undefined {
	if (!plan.ownedAddress) return undefined;
	const physical = Object.freeze({ ...plan.ownedAddress }),
		sameBoot = plan.bootId === bootId;
	if (
		physical.ifname !== plan.input.iface ||
		Number(physical.ifindex) !== plan.ifindex ||
		!isIPv4(plan.input.ipv4) ||
		plan.input.ipv4 === "0.0.0.0"
	)
		throw new Error("Contradictory internal address authority");
	const effect: CellularIndexedIpEffect = {
		kind: "address",
		family: 4,
		address: plan.input.ipv4,
		prefix: 32,
	};
	const selected =
		io ??
		cellularIndexedIpIO(
			() => cellularPhysicalResourceState(physical, sameBoot),
			owned,
		);
	const guarded: CellularIndexedIpIO = {
		...selected,
		write: async (index, value, operation) =>
			owned() && (await selected.write(index, value, operation)) && owned(),
	};
	const address = new CellularIndexedIpState(
		{ name: physical.ifname, index: plan.ifindex },
		[effect],
		guarded,
	);
	return {
		inspect: async () => (owned() ? address.inspect(effect) : "foreign"),
		apply: async () => {
			if (!owned()) throw new Error("Internal address owner was released");
			await address.apply(effect);
		},
		remove: async () => owned() && (await address.remove(effect)) && owned(),
	};
}
