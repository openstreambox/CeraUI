import { isIPv4 } from "node:net";
export interface CellularPacketFence {
	readonly owner: string;
	readonly slot: number;
	readonly source: string;
	readonly ifindex: number;
	readonly translated: boolean;
	readonly dns: readonly string[];
}
export type CellularFenceMode = "probe" | "ready" | "withdrawn";
export function cellularFenceTable(slot: number): string {
	if (!Number.isInteger(slot) || slot < 1 || slot > 32)
		throw new Error("Invalid cellular fence slot");
	return `ceracell_${slot}`;
}
/** Output fencing is independent of FIB error actions: Linux can deliberately
 * fall back to an on-link route for SO_BINDTODEVICE sockets after a FIB error.
 * No accepting rule overrides another firewall owner's policy.
 */
export function cellularFenceDefinition(
	input: CellularPacketFence,
	mode: CellularFenceMode,
): string {
	if (
		!/^[a-f0-9]{64}$/.test(input.owner) ||
		!isIPv4(input.source) ||
		!Number.isInteger(input.ifindex) ||
		input.ifindex < 1 ||
		input.dns.length > 4 ||
		input.dns.some((address) => !isIPv4(address))
	)
		throw new Error("Invalid cellular packet fence");
	const table = cellularFenceTable(input.slot),
		rules: string[] = [];
	// Duplicate native carrier addresses remain independent: each native fence
	// follows the kernel device index. Translator source slots are unique.
	const selector = `ip saddr ${input.source}${input.translated ? "" : ` meta oif ${input.ifindex}`}`;
	const bound = `${selector}${input.translated ? ` meta oif ${input.ifindex}` : ""}`;
	if (mode === "probe") {
		rules.push(`${bound} ip daddr 1.1.1.1 tcp dport 443 return`);
		for (const dns of input.dns)
			rules.push(`${bound} ip daddr ${dns} udp dport 53 return`);
	}
	if (mode !== "ready") rules.push(`${selector} counter drop`);
	return `table inet ${table} {\n comment "cellular-${input.owner}"\n chain output {\n type filter hook output priority -150; policy accept;\n ${rules.map((rule) => `${rule};`).join("\n ")}\n }\n}\n`;
}

function fenceMatches(input: CellularPacketFence, bound: boolean): unknown[] {
	const match = (left: unknown, right: unknown) => ({
		match: { op: "==", left, right },
	});
	return [
		match({ payload: { protocol: "ip", field: "saddr" } }, input.source),
		...(!input.translated || bound
			? [match({ meta: { key: "oif" } }, input.ifindex)]
			: []),
	];
}
/** Expected semantic inventory, independent of dynamic kernel handles/counters. */
export function cellularFenceInventory(
	input: CellularPacketFence,
	mode: CellularFenceMode,
): unknown[] {
	cellularFenceDefinition(input, mode);
	const table = cellularFenceTable(input.slot),
		base = { family: "inet", table, chain: "output" },
		entries: unknown[] = [
			{
				table: {
					family: "inet",
					name: table,
					comment: `cellular-${input.owner}`,
				},
			},
			{
				chain: {
					family: "inet",
					table,
					name: "output",
					type: "filter",
					hook: "output",
					prio: -150,
					policy: "accept",
				},
			},
		];
	if (mode === "probe") {
		for (const [address, protocol, port] of [
			["1.1.1.1", "tcp", 443],
			...input.dns.map((address) => [address, "udp", 53]),
		] as const)
			entries.push({
				rule: {
					...base,
					expr: [
						...fenceMatches(input, true),
						{
							match: {
								op: "==",
								left: { payload: { protocol: "ip", field: "daddr" } },
								right: address,
							},
						},
						{
							match: {
								op: "==",
								left: { payload: { protocol, field: "dport" } },
								right: port,
							},
						},
						{ return: null },
					],
				},
			});
	}
	if (mode !== "ready")
		entries.push({
			rule: {
				...base,
				expr: [
					...fenceMatches(input, false),
					{ counter: { packets: 0, bytes: 0 } },
					{ drop: null },
				],
			},
		});
	return entries;
}
function canonical(
	value: unknown,
	parent = "",
	indexes: Readonly<Record<string, number>> = {},
): unknown {
	if (Array.isArray(value))
		return value.map((item) => canonical(item, "", indexes));
	if (!value || typeof value !== "object") return value;
	let record: object = value;
	if (
		parent === "match" &&
		"left" in value &&
		value.left &&
		typeof value.left === "object" &&
		"meta" in value.left &&
		value.left.meta &&
		typeof value.left.meta === "object" &&
		"key" in value.left.meta &&
		value.left.meta.key === "oif" &&
		"right" in value &&
		typeof value.right === "string" &&
		indexes[value.right] !== undefined
	)
		record = { ...value, right: indexes[value.right] };
	return Object.fromEntries(
		Object.entries(record)
			.filter(
				([key]) =>
					!(key === "handle" && ["table", "chain", "rule"].includes(parent)),
			)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => [
				key,
				parent === "counter" &&
				(key === "packets" || key === "bytes") &&
				typeof entry === "number" &&
				Number.isSafeInteger(entry) &&
				entry >= 0
					? 0
					: canonical(entry, key, indexes),
			]),
	);
}
/** A matching comment alone is never removal authority. Reject extra chains,
 * rules, expressions or table attributes; preserve foreign edits in place.
 */
export function inspectCellularFence(
	input: CellularPacketFence,
	raw: unknown,
	indexes: Readonly<Record<string, number>> = {},
): CellularFenceMode | "foreign" {
	if (
		!raw ||
		typeof raw !== "object" ||
		Object.keys(raw).length !== 1 ||
		!("nftables" in raw) ||
		!Array.isArray(raw.nftables)
	)
		return "foreign";
	const entries = raw.nftables.filter(
		(entry: unknown) =>
			!(
				entry &&
				typeof entry === "object" &&
				Object.keys(entry).length === 1 &&
				"metainfo" in entry
			),
	);
	const actual = JSON.stringify(canonical(entries, "", indexes));
	for (const mode of ["probe", "ready", "withdrawn"] as const)
		if (
			actual === JSON.stringify(canonical(cellularFenceInventory(input, mode)))
		)
			return mode;
	return "foreign";
}
export function cellularFenceReplace(
	input: CellularPacketFence,
	mode: CellularFenceMode,
): string {
	// The caller must positively verify the complete existing owned table before
	// replacing it. The deletion and replacement commit in one nft transaction.
	return `delete table inet ${cellularFenceTable(input.slot)}\n${cellularFenceDefinition(input, mode)}`;
}
