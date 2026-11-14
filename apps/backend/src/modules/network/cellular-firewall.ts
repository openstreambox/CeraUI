import { run, runWithStdin } from "../../helpers/run.ts";
import {
	type CellularFenceMode,
	type CellularPacketFence,
	cellularFenceDefinition,
	cellularFenceReplace,
	cellularFenceTable,
	inspectCellularFence,
} from "./cellular-packet-fence.ts";
import { isSafeIfname } from "./safe-ifname.ts";

export interface CellularFirewallIO {
	readonly read: (argv: string[]) => Promise<string>;
	readonly write: (text: string) => Promise<void>;
	readonly index: (name: string) => Promise<number | undefined>;
	readonly current: () => Promise<boolean>;
}
export function cellularFirewallIO(
	current: () => Promise<boolean>,
): CellularFirewallIO {
	return {
		current,
		index: async (name) => {
			if (!isSafeIfname(name)) return undefined;
			try {
				const rows: unknown = JSON.parse(
					await run("ip", ["-j", "link", "show", "dev", name], {
						timeout: 4000,
						maxBuffer: 16 * 1024,
					}),
				);
				if (
					!Array.isArray(rows) ||
					rows.length !== 1 ||
					rows[0]?.ifname !== name ||
					!Number.isInteger(rows[0]?.ifindex) ||
					rows[0].ifindex < 1 ||
					rows[0].ifindex > 0x7fffffff
				)
					return undefined;
				return rows[0].ifindex;
			} catch {
				return undefined;
			}
		},
		read: (argv) => run("nft", argv, { timeout: 4000, maxBuffer: 256 * 1024 }),
		write: async (text) => {
			await runWithStdin("nft", ["-f", "-"], text, {
				timeout: 4000,
				maxBuffer: 16 * 1024,
			});
		},
	};
}
/** Caller holds the slot's kernel lease and persists birth/inverse authority
 * before create. A same-looking existing table is not authority to adopt it.
 * Transitions verify the entire table, then replace only that table atomically.
 */
export class CellularFirewall {
	constructor(
		readonly input: CellularPacketFence,
		private readonly io: CellularFirewallIO,
	) {
		cellularFenceDefinition(input, "withdrawn");
	}
	async inspect(): Promise<CellularFenceMode | "absent" | "foreign"> {
		const table = cellularFenceTable(this.input.slot);
		const inventory: unknown = JSON.parse(
			await this.io.read(["--numeric", "--json", "list", "tables"]),
		);
		if (
			!inventory ||
			typeof inventory !== "object" ||
			!("nftables" in inventory) ||
			!Array.isArray(inventory.nftables)
		)
			throw new Error("Unknown firewall inventory");
		let matches = 0;
		for (const entry of inventory.nftables) {
			if (
				!entry ||
				typeof entry !== "object" ||
				Object.keys(entry).length !== 1
			)
				throw new Error("Malformed firewall inventory");
			if ("metainfo" in entry) continue;
			if (
				!("table" in entry) ||
				!entry.table ||
				typeof entry.table !== "object" ||
				typeof entry.table.family !== "string" ||
				typeof entry.table.name !== "string"
			)
				throw new Error("Incomplete firewall inventory");
			if (entry.table.family === "inet" && entry.table.name === table)
				matches++;
		}
		if (matches === 0) return "absent";
		if (matches !== 1) return "foreign";
		const raw: unknown = JSON.parse(
			await this.io.read([
				"--numeric",
				"--json",
				"list",
				"table",
				"inet",
				table,
			]),
		);
		// nft's JSON renderer can name an oif even with --numeric. Resolve only
		// this small table's explicit oif names, never treat a name as identity.
		const indexes: Record<string, number> = {};
		if (
			raw &&
			typeof raw === "object" &&
			"nftables" in raw &&
			Array.isArray(raw.nftables)
		) {
			for (const entry of raw.nftables)
				for (const expression of entry?.rule?.expr ?? []) {
					const match = expression?.match;
					if (
						match?.left?.meta?.key !== "oif" ||
						typeof match.right !== "string"
					)
						continue;
					const name = match.right;
					if (!isSafeIfname(name)) return "foreign";
					const first = await this.io.index(name),
						second = await this.io.index(name);
					if (!first || first !== second) return "foreign";
					indexes[name] = first;
				}
		}
		return inspectCellularFence(this.input, raw, indexes);
	}
	async create(mode: CellularFenceMode): Promise<void> {
		if (
			!(await this.io.current()) ||
			(await this.inspect()) !== "absent" ||
			!(await this.io.current())
		)
			throw new Error("Firewall birth slot unavailable");
		await this.io.write(cellularFenceDefinition(this.input, mode));
		if (!(await this.io.current()) || (await this.inspect()) !== mode)
			throw new Error("Firewall birth did not verify");
	}
	async transition(mode: CellularFenceMode): Promise<void> {
		const before = await this.inspect();
		if (
			before === "absent" ||
			before === "foreign" ||
			(mode !== "withdrawn" && !(await this.io.current()))
		)
			throw new Error("Firewall ownership changed");
		if (before !== mode)
			await this.io.write(cellularFenceReplace(this.input, mode));
		if ((await this.inspect()) !== mode)
			throw new Error("Firewall transition did not verify");
	}
	async remove(): Promise<boolean> {
		const before = await this.inspect();
		if (before === "absent") return true;
		if (before === "foreign") return false;
		// An old output-index fence remains ours after USB removal; no device or
		// global firewall policy is changed by deleting this exact owned table.
		await this.io.write(
			`delete table inet ${cellularFenceTable(this.input.slot)}\n`,
		);
		return (await this.inspect()) === "absent";
	}
}
