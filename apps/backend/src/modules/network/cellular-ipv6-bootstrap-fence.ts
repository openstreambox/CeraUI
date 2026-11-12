import {
	type CellularFirewallIO,
	CellularOwnedNftTable,
} from "./cellular-firewall.ts";
import type { CellularIpv6BootstrapPlan } from "./cellular-ipv6-bootstrap-plan.ts";
import { canonicalCellularNft } from "./cellular-packet-fence.ts";

type Mode = "probe" | "withdrawn";
const table = (plan: CellularIpv6BootstrapPlan) =>
	`ceracell_bootstrap_${plan.slot}`;
export function cellularIpv6BootstrapDefinition(
	plan: CellularIpv6BootstrapPlan,
	mode: Mode,
): string {
	const selector = `ip6 saddr ${plan.source} meta oif ${Number(plan.physical.ifindex)}`,
		rules = [
			// Neighbour discovery is host control traffic needed to resolve the grant's
			// gateway. Neither DNS nor arbitrary ICMP echo is admitted while withdrawing.
			`${selector} icmpv6 type 135 return`,
			`${selector} icmpv6 type 136 return`,
		];
	if (mode === "probe")
		for (const dns of plan.dns)
			rules.push(`${selector} ip6 daddr ${dns} udp dport 53 return`);
	rules.push(`${selector} counter drop`);
	return `table inet ${table(plan)} {\n comment "cellular-${plan.owner}"\n chain output {\n type filter hook output priority -151; policy accept;\n ${rules.map((rule) => `${rule};`).join("\n ")}\n }\n}\n`;
}
function inventory(plan: CellularIpv6BootstrapPlan, mode: Mode): unknown[] {
	const name = table(plan),
		base = { family: "inet", table: name, chain: "output" },
		rows: unknown[] = [
			{ table: { family: "inet", name, comment: `cellular-${plan.owner}` } },
			{
				chain: {
					family: "inet",
					table: name,
					name: "output",
					type: "filter",
					hook: "output",
					prio: -151,
					policy: "accept",
				},
			},
		];
	const match = (left: unknown, right: unknown) => ({
			match: { op: "==", left, right },
		}),
		payload = (protocol: string, field: string, right: unknown) =>
			match({ payload: { protocol, field } }, right),
		selector = () => [
			payload("ip6", "saddr", plan.source),
			match({ meta: { key: "oif" } }, Number(plan.physical.ifindex)),
		],
		rule = (expr: unknown[]) => rows.push({ rule: { ...base, expr } });
	for (const type of [135, 136])
		rule([...selector(), payload("icmpv6", "type", type), { return: null }]);
	if (mode === "probe")
		for (const dns of plan.dns)
			rule([
				...selector(),
				payload("ip6", "daddr", dns),
				payload("udp", "dport", 53),
				{ return: null },
			]);
	rule([...selector(), { counter: { packets: 0, bytes: 0 } }, { drop: null }]);
	return rows;
}
export class CellularIpv6BootstrapFence extends CellularOwnedNftTable<Mode> {
	constructor(plan: CellularIpv6BootstrapPlan, io: CellularFirewallIO) {
		super(
			{
				table: table(plan),
				withdrawn: "withdrawn",
				definition: (mode) => cellularIpv6BootstrapDefinition(plan, mode),
				replace: (mode) =>
					`delete table inet ${table(plan)}\n${cellularIpv6BootstrapDefinition(plan, mode)}`,
				inspect: (raw, indexes) => {
					if (
						!raw ||
						typeof raw !== "object" ||
						Object.keys(raw).length !== 1 ||
						!("nftables" in raw) ||
						!Array.isArray(raw.nftables)
					)
						return "foreign";
					const entries = raw.nftables.filter(
							(row: unknown) =>
								!(
									row &&
									typeof row === "object" &&
									Object.keys(row).length === 1 &&
									"metainfo" in row
								),
						),
						actual = JSON.stringify(canonicalCellularNft(entries, "", indexes));
					for (const mode of ["probe", "withdrawn"] as const)
						if (
							actual ===
							JSON.stringify(canonicalCellularNft(inventory(plan, mode)))
						)
							return mode;
					return "foreign";
				},
			},
			io,
		);
	}
}
