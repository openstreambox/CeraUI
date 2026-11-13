import { run } from "../../helpers/run.ts";
import type { CellularRoutePlan } from "./cellular-route-plan.ts";
import { formatIpv6, parseIpv4, parseIpv6 } from "./nat64.ts";
import { isSafeIfname } from "./safe-ifname.ts";

export interface CellularAllocationInventory {
	readonly addresses: unknown;
	readonly routes4: unknown;
	readonly routes6: unknown;
	readonly proxies6: unknown;
}
export type CellularAllocationState = "clear" | "occupied" | "unknown";
/** Observed modem delegation, retained in the birth plan and revalidated by
 * current(). A kernel host /128 alone never establishes a usable /64.
 */
export interface CellularDelegationEvidence {
	readonly source: string;
	readonly prefixLength: number;
}
type Row = Record<string, unknown>;
function rows(raw: unknown): Row[] {
	if (
		!Array.isArray(raw) ||
		raw.length > 4096 ||
		raw.some((row) => !row || typeof row !== "object" || Array.isArray(row))
	)
		throw new Error("Unknown allocation inventory");
	return raw;
}
function network(
	value: unknown,
	family: 4 | 6,
): { bytes: Uint8Array; prefix: number } {
	if (typeof value !== "string" || value.includes("%"))
		throw new Error("Unknown allocation prefix");
	const [address, length, extra] = value.split("/"),
		limit = family === 4 ? 32 : 128,
		bytes = family === 4 ? parseIpv4(address ?? "") : parseIpv6(address ?? ""),
		prefix = length === undefined ? limit : Number(length);
	if (
		!bytes ||
		extra !== undefined ||
		(length !== undefined && !/^(0|[1-9]\d{0,2})$/.test(length)) ||
		!Number.isInteger(prefix) ||
		prefix < 0 ||
		prefix > limit
	)
		throw new Error("Unknown allocation prefix");
	return { bytes, prefix };
}
function contains(
	net: ReturnType<typeof network>,
	address: Uint8Array,
): boolean {
	for (let bit = 0; bit < net.prefix; bit++) {
		const mask = 1 << (7 - (bit % 8)),
			at = Math.floor(bit / 8);
		if (((net.bytes[at] ?? 0) & mask) !== ((address[at] ?? 0) & mask))
			return false;
	}
	return true;
}
function equal6(value: unknown, address: string): boolean {
	if (typeof value !== "string" || value.includes("%")) return false;
	const bytes = parseIpv6(value);
	return !!bytes && formatIpv6(bytes) === address;
}
/** Baseline only, before creating a TUN, global-source guard or source fence.
 * A connected carrier IPv6 /64 or exact host /128 backed by observed modem
 * delegation is expected; another link/subnet, explicit host
 * route, existing source address or proxy is not ours to override. Defaults
 * remain outside this allocation check. Unknown inventory grants no permission.
 */
export function inspectCellularClatAllocation(
	plan: CellularRoutePlan,
	physical: string,
	inventory: CellularAllocationInventory,
	delegation?: CellularDelegationEvidence,
): CellularAllocationState {
	if (!plan.translated || !plan.tun || !plan.mapped || !isSafeIfname(physical))
		throw new Error("Translated allocation required");
	const source = parseIpv4(plan.source),
		mapped = parseIpv6(plan.mapped);
	if (!source || !mapped) throw new Error("Invalid translated allocation");
	try {
		const delegated = delegation
			? network(`${delegation.source}/${delegation.prefixLength}`, 6)
			: undefined;
		if (
			delegated &&
			(delegated.prefix !== 64 ||
				((delegated.bytes[0] ?? 0) & 0xe0) !== 0x20 ||
				!contains(delegated, mapped))
		)
			return "unknown";
		let carrierPrefix = false;
		const links = rows(inventory.addresses),
			indices = new Set<number>(),
			names = new Set<string>();
		for (const link of links) {
			if (
				!Number.isInteger(link.ifindex) ||
				Number(link.ifindex) < 1 ||
				Number(link.ifindex) > 0x7fffffff ||
				typeof link.ifname !== "string" ||
				!isSafeIfname(link.ifname) ||
				!Array.isArray(link.addr_info) ||
				link.addr_info.length > 256 ||
				indices.has(Number(link.ifindex)) ||
				names.has(link.ifname)
			)
				return "unknown";
			indices.add(Number(link.ifindex));
			names.add(link.ifname);
			if (link.ifname === plan.tun) return "occupied";
			for (const address of rows(link.addr_info)) {
				if (
					!["inet", "inet6"].includes(String(address.family)) ||
					typeof address.local !== "string" ||
					!Number.isInteger(address.prefixlen)
				)
					return "unknown";
				const family = address.family === "inet" ? 4 : 6,
					net = network(`${address.local}/${address.prefixlen}`, family);
				if (
					family === 6 &&
					link.ifname === physical &&
					((net.prefix === 64 && contains(net, mapped)) ||
						(net.prefix === 128 &&
							delegated &&
							equal6(address.local, formatIpv6(delegated.bytes))))
				)
					carrierPrefix = true;
				if (
					family === 4
						? contains(net, source)
						: equal6(address.local, plan.mapped) ||
							(link.ifname !== physical && contains(net, mapped))
				)
					return "occupied";
			}
		}
		if (!names.has(physical) || !carrierPrefix) return "unknown";
		for (const row of rows(inventory.routes4)) {
			if (row.prefsrc === plan.source) return "occupied";
			if (row.dst === "default") continue;
			const net = network(row.dst, 4);
			if (net.prefix !== 0 && contains(net, source)) return "occupied";
		}
		for (const row of rows(inventory.routes6)) {
			if (equal6(row.prefsrc, plan.mapped) || equal6(row.gateway, plan.mapped))
				return "occupied";
			if (row.dst === "default") continue;
			const net = network(row.dst, 6);
			if (net.prefix === 0 || !contains(net, mapped)) continue;
			if (
				net.prefix !== 64 ||
				row.dev !== physical ||
				![2, "2", "kernel"].includes(row.protocol as string | number) ||
				row.gateway !== undefined ||
				row.nhid !== undefined ||
				row.multipath !== undefined ||
				(row.type !== undefined && row.type !== "unicast")
			)
				return "occupied";
		}
		for (const row of rows(inventory.proxies6)) {
			if (
				typeof row.dev !== "string" ||
				typeof row.dst !== "string" ||
				row.dst.includes("%") ||
				!parseIpv6(row.dst)
			)
				return "unknown";
			if (equal6(row.dst, plan.mapped)) return "occupied";
		}
		return "clear";
	} catch {
		return "unknown";
	}
}
export async function readCellularClatAllocation(
	plan: CellularRoutePlan,
	physical: string,
	current: () => Promise<boolean>,
	delegation?: CellularDelegationEvidence,
): Promise<CellularAllocationState> {
	if (!(await current())) return "unknown";
	try {
		const read = async (argv: string[]) =>
			JSON.parse(
				await run("ip", argv, { timeout: 4000, maxBuffer: 256 * 1024 }),
			);
		const [addresses, routes4, routes6, proxies6] = await Promise.all([
			read(["-j", "addr", "show"]),
			read(["-4", "-N", "-j", "route", "show", "table", "all"]),
			read(["-6", "-N", "-j", "route", "show", "table", "all"]),
			read(["-6", "-j", "neigh", "show", "proxy"]),
		]);
		return (await current())
			? inspectCellularClatAllocation(
					plan,
					physical,
					{ addresses, routes4, routes6, proxies6 },
					delegation,
				)
			: "unknown";
	} catch {
		return "unknown";
	}
}
