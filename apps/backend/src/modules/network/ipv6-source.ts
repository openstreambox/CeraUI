/*
  WHICH IPv6 ADDRESS OF AN INTERFACE MAY SOURCE A STREAM, AND WHICH ADDRESS OF
  AN UPLINK (IPv4 OR IPv6) REACHES A GIVEN RECEIVER.

  Interface discovery has always kept one IPv4 address per netdev. An uplink
  whose carrier gives it IPv6 alone therefore has no source at all today. These
  functions are the family-aware half of that selection, kept pure so the
  choice can be tested without a kernel:

  - `selectIpv6Source` picks the one stable, routable IPv6 address of a netdev
    from `ip -json -6 address show` records;
  - `chooseUplinkSource` decides, per uplink, which family carries the stream
    to a receiver, and whether the destination must go through NAT64.

  One uplink contributes at most ONE source. A dual-stack modem's two addresses
  share a single bearer and fail together, so listing both would look like
  redundancy and deliver none.
*/

import { type Nat64Prefix, parseIpv6, synthesizeNat64 } from "./nat64.ts";

/** One `addr_info` entry of `ip -json address show`. */
export type KernelAddress = {
	readonly family?: string;
	readonly local?: string;
	readonly prefixlen?: number;
	readonly scope?: string;
	readonly tentative?: boolean;
	readonly dadfailed?: boolean;
	readonly deprecated?: boolean;
	readonly temporary?: boolean;
	readonly preferred_life_time?: number;
};

export type KernelInterfaceAddresses = {
	readonly ifname?: string;
	readonly addr_info?: readonly KernelAddress[];
};

function isRoutableUnicast(text: string): boolean {
	const bytes = parseIpv6(text);
	if (bytes === undefined) return false;
	// Only global unicast (2000::/3) can reach a receiver on the internet.
	// Unique-local, link-local, multicast, loopback and mapped forms cannot.
	return ((bytes[0] ?? 0) & 0xe0) === 0x20;
}

function usable(address: KernelAddress): address is KernelAddress & {
	local: string;
} {
	return (
		address.family === "inet6" &&
		typeof address.local === "string" &&
		address.scope === "global" &&
		address.tentative !== true &&
		address.dadfailed !== true &&
		address.deprecated !== true &&
		address.preferred_life_time !== 0 &&
		isRoutableUnicast(address.local)
	);
}

/**
 * The IPv6 source of one interface, or `undefined` when it has none.
 *
 * A stable address beats a temporary (privacy) one, because the latter is
 * rotated by the kernel while a stream is bound to it. The remaining tie is
 * broken on the address text: arbitrary, but identical on every read of an
 * unchanged interface, so the published source does not flap.
 */
export function selectIpv6Source(
	addresses: readonly KernelAddress[],
): string | undefined {
	const candidates = addresses.filter(usable);
	const stable = candidates.filter((address) => address.temporary !== true);
	const pool = stable.length > 0 ? stable : candidates;
	return pool.map((address) => address.local).sort()[0];
}

/** Per-interface IPv6 sources from a parsed `ip -json -6 address show`. */
export function ipv6SourcesByInterface(
	interfaces: readonly KernelInterfaceAddresses[],
): Record<string, string> {
	const sources: Record<string, string> = {};
	for (const entry of interfaces) {
		if (typeof entry.ifname !== "string") continue;
		const source = selectIpv6Source(entry.addr_info ?? []);
		if (source !== undefined) sources[entry.ifname] = source;
	}
	return sources;
}

export type UplinkAddresses = {
	readonly ipv4?: string | undefined;
	readonly ipv6?: string | undefined;
	/** NAT64 prefix discovered ON THIS UPLINK; never borrowed from another. */
	readonly nat64?: Nat64Prefix | undefined;
};

export type ReceiverAddresses = {
	readonly ipv4?: string | undefined;
	readonly ipv6?: string | undefined;
};

export type UplinkSource = {
	readonly source: string;
	readonly destination: string;
	readonly family: "ipv4" | "ipv6";
	readonly path: "native" | "nat64";
};

/**
 * The single (source, destination) pair this uplink uses toward a receiver.
 *
 * Order of preference:
 *
 * 1. IPv4 to IPv4 — what every uplink does today, so an uplink that has an
 *    IPv4 address behaves exactly as before whatever else it gained.
 * 2. IPv6 to the receiver's own IPv6 address — end to end, no translator.
 * 3. IPv6 through this uplink's NAT64 to the receiver's IPv4 address — the
 *    only way an IPv6-only carrier reaches an IPv4-only receiver.
 *
 * `undefined` means this uplink cannot reach this receiver; it must then be
 * left out of the bond rather than listed with a destination it cannot use.
 */
export function chooseUplinkSource(
	uplink: UplinkAddresses,
	receiver: ReceiverAddresses,
): UplinkSource | undefined {
	if (uplink.ipv4 !== undefined && receiver.ipv4 !== undefined) {
		return {
			source: uplink.ipv4,
			destination: receiver.ipv4,
			family: "ipv4",
			path: "native",
		};
	}
	if (uplink.ipv6 === undefined) return undefined;
	if (receiver.ipv6 !== undefined) {
		return {
			source: uplink.ipv6,
			destination: receiver.ipv6,
			family: "ipv6",
			path: "native",
		};
	}
	if (uplink.nat64 !== undefined && receiver.ipv4 !== undefined) {
		const destination = synthesizeNat64(uplink.nat64, receiver.ipv4);
		if (destination !== undefined) {
			return {
				source: uplink.ipv6,
				destination,
				family: "ipv6",
				path: "nat64",
			};
		}
	}
	return undefined;
}
