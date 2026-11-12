import {
	type CellularFirewallIO,
	CellularOwnedNftTable,
} from "./cellular-firewall.ts";
import {
	canonicalCellularNft,
	cellularFenceTable,
} from "./cellular-packet-fence.ts";
import {
	formatIpv6,
	formatNat64Prefix,
	parseIpv6,
	parseNat64Prefix,
} from "./nat64.ts";

export interface CellularForwardFenceInput {
	readonly owner: string;
	readonly slot: number;
	readonly tunIndex: number;
	readonly physicalIndex: number;
	readonly mapped: string;
	readonly nat64: string;
	/** Global host-mode baseline had no forwarding on this ingress. Constrain
	 * the new per-link router before enabling force_forwarding. A different
	 * global/shared policy requires withdrawal and fresh owner reconciliation.
	 */
	readonly isolatePhysical: boolean;
}
export type CellularForwardMode = "active" | "withdrawn";
function table(input: CellularForwardFenceInput): string {
	cellularFenceTable(input.slot);
	return `ceracell_forward_${input.slot}`;
}
function validate(input: CellularForwardFenceInput) {
	const mapped = !input.mapped.includes("%") && parseIpv6(input.mapped),
		prefix = !input.nat64.includes("%") && parseNat64Prefix(input.nat64);
	if (
		!/^[a-f0-9]{64}$/.test(input.owner) ||
		!mapped ||
		((mapped[0] ?? 0) & 0xe0) !== 0x20 ||
		!prefix ||
		[input.tunIndex, input.physicalIndex].some(
			(n) => !Number.isInteger(n) || n < 1 || n > 0x7fffffff,
		) ||
		input.tunIndex === input.physicalIndex ||
		typeof input.isolatePhysical !== "boolean"
	)
		throw new Error("Invalid cellular forwarding fence");
	return {
		mapped: formatIpv6(mapped),
		nat64: formatNat64Prefix(prefix),
		prefix,
	};
}
export function cellularForwardDefinition(
	input: CellularForwardFenceInput,
	mode: CellularForwardMode,
): string {
	const { mapped, nat64 } = validate(input),
		rules: string[] = [];
	if (mode === "active") {
		rules.push(
			`meta iif ${input.tunIndex} meta oif ${input.physicalIndex} ip6 saddr ${mapped} ip6 daddr ${nat64} return`,
		);
		// Router ICMP errors need not originate inside the NAT64 prefix.
		rules.push(
			`meta iif ${input.physicalIndex} meta oif ${input.tunIndex} ip6 daddr ${mapped} return`,
		);
	}
	rules.push(`meta iif ${input.tunIndex} counter drop`);
	rules.push(
		input.isolatePhysical
			? `meta nfproto ipv6 meta iif ${input.physicalIndex} counter drop`
			: `meta iif ${input.physicalIndex} ip6 daddr ${mapped} counter drop`,
	);
	return `table inet ${table(input)} {\n comment "cellular-${input.owner}"\n chain forward {\n type filter hook forward priority -150; policy accept;\n ${rules.map((rule) => `${rule};`).join("\n ")}\n }\n}\n`;
}
function match(left: unknown, right: unknown) {
	return { match: { op: "==", left, right } };
}
const device = (key: "iif" | "oif", index: number) =>
	match({ meta: { key } }, index);
const address = (field: "saddr" | "daddr", right: unknown) =>
	match({ payload: { protocol: "ip6", field } }, right);
export function cellularForwardInventory(
	input: CellularForwardFenceInput,
	mode: CellularForwardMode,
): unknown[] {
	const { mapped, prefix } = validate(input),
		name = table(input),
		base = { family: "inet", table: name, chain: "forward" },
		rows: unknown[] = [
			{ table: { family: "inet", name, comment: `cellular-${input.owner}` } },
			{
				chain: {
					family: "inet",
					table: name,
					name: "forward",
					type: "filter",
					hook: "forward",
					prio: -150,
					policy: "accept",
				},
			},
		],
		rule = (expr: unknown[]) => rows.push({ rule: { ...base, expr } }),
		drop = [{ counter: { packets: 0, bytes: 0 } }, { drop: null }];
	if (mode === "active") {
		rule([
			device("iif", input.tunIndex),
			device("oif", input.physicalIndex),
			address("saddr", mapped),
			address("daddr", {
				prefix: { addr: formatIpv6(prefix.bytes), len: prefix.length },
			}),
			{ return: null },
		]);
		rule([
			device("iif", input.physicalIndex),
			device("oif", input.tunIndex),
			address("daddr", mapped),
			{ return: null },
		]);
	}
	rule([device("iif", input.tunIndex), ...drop]);
	rule(
		input.isolatePhysical
			? [
					match({ meta: { key: "nfproto" } }, 10),
					device("iif", input.physicalIndex),
					...drop,
				]
			: [device("iif", input.physicalIndex), address("daddr", mapped), ...drop],
	);
	return rows;
}
function inspect(
	input: CellularForwardFenceInput,
	raw: unknown,
	indexes: Readonly<Record<string, number>>,
): CellularForwardMode | "foreign" {
	if (
		!raw ||
		typeof raw !== "object" ||
		Object.keys(raw).length !== 1 ||
		!("nftables" in raw) ||
		!Array.isArray(raw.nftables)
	)
		return "foreign";
	const rows = raw.nftables.filter(
			(row) =>
				!(
					row &&
					typeof row === "object" &&
					Object.keys(row).length === 1 &&
					"metainfo" in row
				),
		),
		actual = JSON.stringify(canonicalCellularNft(rows, "", indexes));
	for (const mode of ["active", "withdrawn"] as const)
		if (
			actual ===
			JSON.stringify(
				canonicalCellularNft(cellularForwardInventory(input, mode)),
			)
		)
			return mode;
	return "foreign";
}
/** Owned per-uplink forward policy, installed before per-link routing is
 * enabled. RETURN never bypasses a different firewall owner's veto.
 */
export class CellularForwardFence extends CellularOwnedNftTable<CellularForwardMode> {
	constructor(
		readonly input: CellularForwardFenceInput,
		io: CellularFirewallIO,
	) {
		super(
			{
				table: table(input),
				withdrawn: "withdrawn",
				definition: (mode) => cellularForwardDefinition(input, mode),
				replace: (mode) =>
					`delete table inet ${table(input)}\n${cellularForwardDefinition(input, mode)}`,
				inspect: (raw, indexes) => inspect(input, raw, indexes),
			},
			io,
		);
	}
}
