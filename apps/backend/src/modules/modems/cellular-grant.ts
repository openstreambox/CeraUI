import { createHash } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import type { CellularPhysicalLink } from "../network/cellular-host-identity.ts";
import {
	type KernelAddress,
	selectIpv6Source,
} from "../network/ipv6-source.ts";
import { formatIpv6, parseIpv6 } from "../network/nat64.ts";
import type { CellularNmIpSnapshot } from "./cellular-nm-ip.ts";
import type { CellularNetworkTarget } from "./modems.ts";
import type { NativeBearerSnapshot } from "./native-bearer.ts";

type CellularGrantPlan = {
	readonly physical: CellularPhysicalLink;
	readonly source: string;
	readonly mtu: number;
	readonly dns: readonly string[];
} & (
	| { readonly family: "ipv4"; readonly gateway?: string }
	| {
			readonly family: "ipv6";
			readonly gateway: string;
			readonly prefixLength: 64;
	  }
);
export type CellularDataGrant = CellularGrantPlan & {
	readonly generation: string;
};
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Unknown cellular grant inventory");
	return value as Record<string, unknown>;
}
function ipv6(value: string) {
	const bytes = parseIpv6(value);
	if (!bytes || value.includes("%"))
		throw new Error("Invalid cellular IPv6 source");
	return formatIpv6(bytes);
}
function global6(value: string): boolean {
	const bytes = parseIpv6(value);
	return !!bytes && ((bytes[0] ?? 0) & 0xe0) === 0x20;
}
function same64(a: string, b: string): boolean {
	const first = parseIpv6(a),
		second = parseIpv6(b);
	return (
		!!first &&
		!!second &&
		first.slice(0, 8).every((byte, index) => byte === second[index])
	);
}
/** Join an actual connected modem grant, the active NM device+SIM profile's IP
 * lease and the current indexed kernel addresses. No address, resolver, gateway
 * or family is borrowed from the main route or another interface.
 */
export function captureCellularDataGrant(
	target: CellularNetworkTarget,
	bearer: NativeBearerSnapshot,
	nm: CellularNmIpSnapshot,
	raw: unknown,
): CellularDataGrant | undefined {
	if (bearer.iface !== target.ifname || !Array.isArray(raw) || raw.length !== 1)
		return undefined;
	const link = object(raw[0]);
	if (
		link.ifname !== target.ifname ||
		String(link.ifindex) !== target.ifindex ||
		!Number.isInteger(link.mtu) ||
		Number(link.mtu) < 576 ||
		Number(link.mtu) > 9000 ||
		!Array.isArray(link.flags) ||
		!link.flags.every((flag) => typeof flag === "string") ||
		!link.flags.includes("UP") ||
		!Array.isArray(link.addr_info) ||
		link.addr_info.length > 256
	)
		return undefined;
	const addresses: (KernelAddress & { local: string; prefixlen: number })[] =
		[];
	for (const rawAddress of link.addr_info) {
		const entry = object(rawAddress);
		if (
			(entry.family !== "inet" && entry.family !== "inet6") ||
			typeof entry.local !== "string" ||
			!Number.isInteger(entry.prefixlen) ||
			Number(entry.prefixlen) < 1 ||
			Number(entry.prefixlen) > (entry.family === "inet" ? 32 : 128) ||
			typeof entry.scope !== "string"
		)
			return undefined;
		if (
			entry.family === "inet"
				? !isIPv4(entry.local)
				: !isIPv6(entry.local) || entry.local.includes("%")
		)
			return undefined;
		for (const flag of [
			"tentative",
			"deprecated",
			"dadfailed",
			"temporary",
		] as const)
			if (entry[flag] !== undefined && typeof entry[flag] !== "boolean")
				return undefined;
		const preferred = entry.preferred_life_time;
		if (
			preferred !== undefined &&
			preferred !== "forever" &&
			(typeof preferred !== "number" ||
				!Number.isSafeInteger(preferred) ||
				preferred < 0)
		)
			return undefined;
		addresses.push({
			family: entry.family,
			local: entry.family === "inet6" ? ipv6(entry.local) : entry.local,
			prefixlen: Number(entry.prefixlen),
			scope: entry.scope,
			...(entry.tentative === true ? { tentative: true } : {}),
			...(entry.deprecated === true ? { deprecated: true } : {}),
			...(entry.dadfailed === true ? { dadfailed: true } : {}),
			...(entry.temporary === true ? { temporary: true } : {}),
			...(typeof preferred === "number"
				? { preferred_life_time: preferred }
				: {}),
		});
	}
	const physical = Object.freeze({
			ifname: target.ifname,
			ifindex: target.ifindex,
			usbDevice: target.usbDevice,
			netDevice: target.netDevice,
			generation: target.generation,
		}),
		healthy = (entry: KernelAddress) =>
			entry.scope === "global" &&
			!entry.tentative &&
			!entry.deprecated &&
			!entry.dadfailed &&
			entry.preferred_life_time !== 0,
		finish = (grant: CellularGrantPlan): CellularDataGrant =>
			Object.freeze({
				...grant,
				dns: Object.freeze([...grant.dns]),
				generation: createHash("sha256")
					.update(
						JSON.stringify([
							target.deviceId,
							target.simId,
							target.subscriber,
							target.equipment,
							target.sim.simInfo?.["sim.properties.operator-code"],
							target.sim.simInfo?.["sim.properties.operator-name"],
							target.sim.simInfo?.["sim.properties.gid1"],
							grant,
						]),
					)
					.digest("hex"),
			}) as CellularDataGrant;
	if (bearer.ipv4) {
		const candidates =
			nm.ipv4?.addresses.filter(
				(row) =>
					(!bearer.ipv4?.address || row.address === bearer.ipv4.address) &&
					addresses.some(
						(entry) =>
							entry.family === "inet" &&
							entry.local === row.address &&
							entry.prefixlen === row.prefix &&
							healthy(entry),
					),
			) ?? [];
		if (candidates.length !== 1) return undefined;
		const source = candidates[0]?.address;
		if (!source) return undefined;
		const first = Number(source.split(".")[0]);
		if (
			first === 0 ||
			first === 127 ||
			first >= 224 ||
			source.startsWith("169.254.")
		)
			return undefined;
		const gateway = nm.ipv4?.gateway ?? bearer.ipv4.gateway,
			dns = [...(nm.ipv4?.dns.length ? nm.ipv4.dns : bearer.ipv4.dns)]
				.filter(isIPv4)
				.slice(0, 4),
			mtu = Math.min(Number(link.mtu), bearer.ipv4.mtu ?? Number(link.mtu));
		if (
			!dns.length ||
			mtu < 576 ||
			gateway === source ||
			(gateway !== undefined && !isIPv4(gateway))
		)
			return undefined;
		return finish({
			family: "ipv4",
			physical,
			source,
			mtu,
			dns,
			...(gateway ? { gateway } : {}),
		});
	}
	// An unexplained host IPv4 lease is not an observed IPv6-only modem grant.
	if (nm.ipv4?.addresses.length || !bearer.ipv6 || !nm.ipv6) return undefined;
	const reported =
			bearer.ipv6.address && global6(bearer.ipv6.address)
				? ipv6(bearer.ipv6.address)
				: undefined,
		candidates = addresses.filter(
			(entry) =>
				entry.family === "inet6" &&
				healthy(entry) &&
				nm.ipv6?.addresses.some(
					(row) =>
						ipv6(row.address) === entry.local && row.prefix === entry.prefixlen,
				) &&
				(!reported ||
					bearer.ipv6?.prefix !== 64 ||
					same64(reported, entry.local)) &&
				(entry.prefixlen === 64 ||
					(bearer.ipv6?.prefix === 64 &&
						reported !== undefined &&
						same64(reported, entry.local))),
		),
		source = selectIpv6Source(candidates),
		gateway = nm.ipv6.gateway ?? bearer.ipv6.gateway,
		dns = [...(nm.ipv6.dns.length ? nm.ipv6.dns : bearer.ipv6.dns)]
			.filter((value) => isIPv6(value) && !value.includes("%"))
			.map(ipv6)
			.slice(0, 4),
		mtu = Math.min(Number(link.mtu), bearer.ipv6.mtu ?? Number(link.mtu));
	if (
		!source ||
		!gateway ||
		!isIPv6(gateway) ||
		gateway.includes("%") ||
		!dns.length ||
		mtu < 1280
	)
		return undefined;
	return finish({
		family: "ipv6",
		physical,
		source,
		gateway: ipv6(gateway),
		prefixLength: 64,
		mtu,
		dns,
	});
}
