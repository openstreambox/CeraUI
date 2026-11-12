import { createHash } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import {
	formatIpv6,
	formatNat64Prefix,
	parseIpv6,
	parseNat64Prefix,
} from "./nat64.ts";
import { isSafeIfname } from "./safe-ifname.ts";

export const CELLULAR_ROUTE_LOOKUP_PRIORITY = 50;
export const CELLULAR_ROUTE_GUARD_PRIORITY = 60;
export const cellularRouteProtocol = (slot: number) => String(128 + slot);
export interface CellularRouteInput {
	readonly owner: string;
	readonly epoch: string;
	readonly slot: number;
	readonly iface: string;
	readonly mtu: number;
	readonly ipv4?: string;
	readonly ipv4Gateway?: string;
	readonly ipv6?: string;
	readonly ipv6PrefixLength?: number;
	readonly ipv6Gateway?: string;
	readonly nat64?: string;
}
export interface CellularIpEffect {
	readonly kind: "rule" | "route";
	readonly family: 4 | 6;
	/** Complete exact selector, shared by add/show/delete. Never a table flush. */
	readonly selector: readonly string[];
	readonly terminal: boolean;
}
export interface CellularRoutePlan {
	readonly table: number;
	readonly source: string;
	readonly device: string;
	readonly translated: boolean;
	readonly tun?: string;
	readonly mapped?: string;
	readonly nat64?: string;
	readonly mtu: number;
	readonly effects: readonly CellularIpEffect[];
}
function native4(value: string): boolean {
	const first = Number(value.split(".")[0]);
	return (
		isIPv4(value) &&
		first > 0 &&
		first !== 127 &&
		first < 224 &&
		!value.startsWith("169.254.")
	);
}
function global6(value: string): boolean {
	const bytes = parseIpv6(value);
	return !!bytes && ((bytes[0] ?? 0) & 0xe0) === 0x20;
}
/** Only source/device-specific local traffic enters these tables. LAN and main
 * defaults are outside the plan. Every lookup precedes every terminal guard,
 * including when two native grants contain the same carrier-NAT address.
 * Priorities precede the existing source/mark steering rules at 100/110.
 * A slot-specific protocol tags otherwise identical duplicate-source guards.
 */
export function planCellularRoutes(
	input: CellularRouteInput,
): CellularRoutePlan | undefined {
	if (
		!/^[a-f0-9]{64}$/.test(input.owner) ||
		!input.epoch ||
		!isSafeIfname(input.iface) ||
		!Number.isInteger(input.slot) ||
		input.slot < 1 ||
		input.slot > 32 ||
		!Number.isInteger(input.mtu) ||
		input.mtu < 1280 ||
		input.mtu > 9000
	)
		throw new Error("Invalid cellular route identity");
	if (input.ipv4 !== undefined && !native4(input.ipv4))
		throw new Error("Invalid native grant");
	const table = 250_000 + input.slot;
	const protocol = cellularRouteProtocol(input.slot);
	const effects: CellularIpEffect[] = [];
	const rule = (family: 4 | 6, selector: readonly string[], terminal = false) =>
		effects.push({
			kind: "rule",
			family,
			terminal,
			selector: [...selector, "protocol", protocol],
		});
	const route = (family: 4 | 6, selector: readonly string[]) =>
		effects.push({
			kind: "route",
			family,
			terminal: false,
			selector: ["table", String(table), ...selector, "proto", protocol],
		});
	const source = input.ipv4 ?? `198.18.255.${input.slot}`;
	const translated = input.ipv4 === undefined;
	const tun = `cclat${input.slot}`,
		device = translated ? tun : input.iface;
	let mapped: string | undefined, prefix: string | undefined;
	if (translated) {
		if (
			!input.ipv6 ||
			!global6(input.ipv6) ||
			input.ipv6PrefixLength !== 64 ||
			!input.ipv6Gateway ||
			!isIPv6(input.ipv6Gateway) ||
			!input.nat64
		)
			return undefined;
		const nat64 = parseNat64Prefix(input.nat64),
			bytes = parseIpv6(input.ipv6);
		if (!nat64 || !bytes) return undefined;
		prefix = formatNat64Prefix(nat64);
		const host = createHash("sha256")
			.update(`${input.owner}\0${input.epoch}\0clat`)
			.digest();
		bytes.set(host.subarray(0, 8), 8);
		bytes[8] = (bytes[8] ?? 0) & 0xfd;
		mapped = formatIpv6(bytes);
		if (mapped === formatIpv6(parseIpv6(input.ipv6) ?? new Uint8Array()))
			throw new Error("Translator/source address collision");
	}
	// A rule alone cannot suppress IPv4's explicit-oif on-link fallback.
	// The separately owned packet fence closes before these resources withdraw.
	// Install terminal guards first; remove them last, after sender withdrawal.
	rule(
		4,
		[
			"priority",
			String(CELLULAR_ROUTE_GUARD_PRIORITY),
			"from",
			`${source}/32`,
			"iif",
			"lo",
			...(translated ? [] : ["oif", input.iface]),
			"unreachable",
		],
		true,
	);
	if (
		input.ipv6 &&
		global6(input.ipv6) &&
		input.ipv6Gateway &&
		isIPv6(input.ipv6Gateway)
	) {
		const v6 = formatIpv6(parseIpv6(input.ipv6) ?? new Uint8Array());
		rule(
			6,
			[
				"priority",
				String(CELLULAR_ROUTE_GUARD_PRIORITY),
				"from",
				`${v6}/128`,
				"iif",
				"lo",
				"oif",
				input.iface,
				"unreachable",
			],
			true,
		);
		route(6, [
			"default",
			"via",
			input.ipv6Gateway,
			"dev",
			input.iface,
			"onlink",
			"mtu",
			String(input.mtu),
		]);
		rule(6, [
			"priority",
			String(CELLULAR_ROUTE_LOOKUP_PRIORITY),
			"from",
			`${v6}/128`,
			"iif",
			"lo",
			"oif",
			input.iface,
			"lookup",
			String(table),
		]);
	}
	if (mapped && prefix) {
		rule(
			6,
			[
				"priority",
				String(CELLULAR_ROUTE_GUARD_PRIORITY),
				"from",
				`${mapped}/128`,
				"iif",
				tun,
				"unreachable",
			],
			true,
		);
		rule(
			6,
			[
				"priority",
				String(CELLULAR_ROUTE_GUARD_PRIORITY),
				"to",
				`${mapped}/128`,
				"iif",
				input.iface,
				"unreachable",
			],
			true,
		);
		// The return /128 lives only in the private table. The ingress selector
		// reaches it without installing a global destination route in main.
		route(6, [`${mapped}/128`, "dev", tun]);
		rule(6, [
			"priority",
			String(CELLULAR_ROUTE_LOOKUP_PRIORITY),
			"from",
			`${mapped}/128`,
			"iif",
			tun,
			"lookup",
			String(table),
		]);
		rule(6, [
			"priority",
			String(CELLULAR_ROUTE_LOOKUP_PRIORITY),
			"to",
			`${mapped}/128`,
			"iif",
			input.iface,
			"lookup",
			String(table),
		]);
	}
	const gateway = !translated && input.ipv4Gateway;
	if (gateway && !native4(gateway)) throw new Error("Invalid grant gateway");
	const mtu = translated ? Math.max(1260, input.mtu - 20) : input.mtu;
	route(4, [
		"default",
		...(gateway ? ["via", gateway, "onlink"] : []),
		"dev",
		device,
		"src",
		source,
		"mtu",
		String(mtu),
	]);
	rule(4, [
		"priority",
		String(CELLULAR_ROUTE_LOOKUP_PRIORITY),
		"from",
		`${source}/32`,
		"iif",
		"lo",
		"oif",
		device,
		"lookup",
		String(table),
	]);
	// Kernel guards exist before addresses or translator packets can be used.
	effects.sort((a, b) => Number(b.terminal) - Number(a.terminal));
	return {
		table,
		source,
		device,
		translated,
		mtu,
		effects,
		...(translated && mapped && prefix ? { tun, mapped, nat64: prefix } : {}),
	};
}
export function cellularIpArgv(
	effect: CellularIpEffect,
	operation: "add" | "del",
): string[] {
	return [`-${effect.family}`, effect.kind, operation, ...effect.selector];
}
