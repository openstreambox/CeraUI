import { createHash } from "node:crypto";
import { z } from "zod";
import { cellularClatHostPlanSchema } from "./cellular-clat-host-plan.ts";
import type {
	CellularIpEffect,
	CellularRoutePlan,
} from "./cellular-route-plan.ts";
import { formatIpv6, parseIpv6 } from "./nat64.ts";
import { isSafeIfname } from "./safe-ifname.ts";

const schema = z
	.object({
		owner: z.string().regex(/^[a-f0-9]{64}$/),
		epoch: z.string().min(1).max(256),
		slot: z.number().int().min(1).max(32),
		physical: cellularClatHostPlanSchema.shape.physical,
		bootId: cellularClatHostPlanSchema.shape.bootId,
		source: z.string().ipv6(),
		gateway: z.string().ipv6(),
		mtu: z.number().int().min(1280).max(9000),
		dns: z.array(z.string().ipv6()).min(1).max(4),
	})
	.strict();
type Parsed = z.infer<typeof schema>;
export type CellularIpv6BootstrapPlan = Readonly<
	Omit<Parsed, "physical" | "dns">
> & {
	readonly physical: Readonly<Parsed["physical"]>;
	readonly dns: readonly string[];
};
function address(text: string): string {
	if (text.includes("%")) throw new Error("Scoped bootstrap endpoint refused");
	const bytes = parseIpv6(text);
	if (
		!bytes?.some((byte) => byte !== 0) ||
		bytes[0] === 0xff ||
		bytes.slice(0, 12).every((byte) => byte === 0) ||
		(bytes.slice(0, 10).every((byte) => byte === 0) &&
			bytes[10] === 0xff &&
			bytes[11] === 0xff)
	)
		throw new Error("Invalid bootstrap IPv6 endpoint");
	return formatIpv6(bytes);
}
export function parseCellularIpv6BootstrapPlan(
	raw: unknown,
): CellularIpv6BootstrapPlan {
	const parsed = schema.parse(raw),
		source = address(parsed.source),
		bytes = parseIpv6(source),
		gateway = address(parsed.gateway),
		gatewayBytes = parseIpv6(gateway),
		dns = parsed.dns.map(address);
	if (
		!bytes ||
		((bytes[0] ?? 0) & 0xe0) !== 0x20 ||
		!gatewayBytes ||
		!(
			((gatewayBytes[0] ?? 0) & 0xe0) === 0x20 ||
			(gatewayBytes[0] === 0xfe && ((gatewayBytes[1] ?? 0) & 0xc0) === 0x80)
		) ||
		new Set(dns).size !== dns.length ||
		!isSafeIfname(parsed.physical.ifname) ||
		["lo", "all", "default"].includes(parsed.physical.ifname) ||
		Number(parsed.physical.ifindex) > 0x7fffffff
	)
		throw new Error("Invalid bootstrap grant identity");
	return Object.freeze({
		...parsed,
		source,
		gateway,
		physical: Object.freeze(parsed.physical),
		dns: Object.freeze(dns),
	});
}
export function cellularIpv6BootstrapKey(slot: number): string {
	if (!Number.isInteger(slot) || slot < 1 || slot > 32)
		throw new Error("Invalid bootstrap slot");
	return createHash("sha256")
		.update(`cellular-ipv6-bootstrap\0${slot}`)
		.digest("hex");
}
/** DNS-only source/device selectors occupy a separate protocol/table from the
 * final translator. No temporary default, main-table route or global resolver.
 */
export function cellularIpv6BootstrapRoutes(
	plan: CellularIpv6BootstrapPlan,
): CellularRoutePlan {
	const table = 260_000 + plan.slot,
		protocol = String(192 + plan.slot),
		effects: CellularIpEffect[] = [];
	const rule = (dns: string, terminal: boolean) => ({
		kind: "rule" as const,
		family: 6 as const,
		terminal,
		selector: [
			"priority",
			terminal ? "45" : "40",
			"from",
			`${plan.source}/128`,
			"to",
			`${dns}/128`,
			"iif",
			"lo",
			"oif",
			plan.physical.ifname,
			...(terminal ? ["unreachable"] : ["lookup", String(table)]),
			"protocol",
			protocol,
		],
	});
	for (const dns of plan.dns) effects.push(rule(dns, true));
	for (const dns of plan.dns)
		effects.push({
			kind: "route",
			family: 6,
			terminal: false,
			selector: [
				"table",
				String(table),
				`${dns}/128`,
				"via",
				plan.gateway,
				"dev",
				plan.physical.ifname,
				"onlink",
				"mtu",
				String(plan.mtu),
				"proto",
				protocol,
			],
		});
	for (const dns of plan.dns) effects.push(rule(dns, false));
	return {
		table,
		source: plan.source,
		device: plan.physical.ifname,
		translated: false,
		linkMtu: plan.mtu,
		mtu: plan.mtu,
		effects,
	};
}
export function cellularIpv6BootstrapSteps(
	plan: CellularIpv6BootstrapPlan,
): readonly string[] {
	return [
		"fence",
		...cellularIpv6BootstrapRoutes(plan).effects.map(
			(_effect, index) => `ip-${index}`,
		),
	];
}
