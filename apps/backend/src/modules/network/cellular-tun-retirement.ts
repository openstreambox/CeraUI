import { changeLinkByIndex } from "../../helpers/netlink-link.ts";
import { run } from "../../helpers/run.ts";
import {
	type CellularTunIdentity,
	type CellularTunIO,
	inspectCellularTun,
} from "./cellular-tun.ts";

export interface CellularTunReferences {
	readonly addresses: unknown;
	readonly routes4: unknown;
	readonly routes6: unknown;
	readonly rules4: unknown;
	readonly rules6: unknown;
	readonly nexthops: unknown;
	readonly firewall: unknown;
}
/** Destruction may implicitly erase another owner's addresses/routes. Refuse
 * every remaining reference, including multipath, indirect nexthops, numeric
 * nft interface indices and names. Unknown bounded inventory is never empty.
 */
export function cellularTunUnreferenced(
	tun: CellularTunIdentity,
	inventory: CellularTunReferences,
	/** Caller verified each complete owned definition before excluding it. */
	ownedFences: readonly string[] = [],
): boolean {
	try {
		const rows = (raw: unknown): Record<string, unknown>[] => {
			if (
				!Array.isArray(raw) ||
				raw.length > 4096 ||
				raw.some((row) => !row || typeof row !== "object" || Array.isArray(row))
			)
				throw new Error("Unknown TUN reference inventory");
			return raw;
		};
		const addresses = rows(inventory.addresses);
		if (
			addresses.length !== 1 ||
			addresses[0]?.ifname !== tun.name ||
			addresses[0]?.ifindex !== tun.index ||
			!Array.isArray(addresses[0].addr_info) ||
			addresses[0].addr_info.length !== 0
		)
			return false;
		const referenced = (value: unknown, depth = 0): boolean => {
			if (depth > 16) throw new Error("Unknown nested TUN reference");
			if (Array.isArray(value))
				return value.some((item) => referenced(item, depth + 1));
			if (!value || typeof value !== "object") return false;
			const row = value as Record<string, unknown>;
			let interfaceMatch = false;
			for (const key of ["dev", "iif", "oif", "iifname", "oifname"]) {
				if (!(key in row)) continue;
				const field = row[key];
				if (typeof field !== "string" && typeof field !== "number")
					throw new Error("Unknown TUN interface selector");
				if (field === tun.name || String(field) === String(tun.index))
					return true;
			}
			// nft's match expression puts the value beside the metadata key.
			if (
				"left" in row &&
				row.left &&
				typeof row.left === "object" &&
				"meta" in row.left
			) {
				const meta = row.left.meta;
				if (
					meta &&
					typeof meta === "object" &&
					"key" in meta &&
					["iif", "oif", "iifname", "oifname"].includes(String(meta.key))
				) {
					if (typeof row.right !== "number" && typeof row.right !== "string")
						return true;
					if (row.right === tun.name || String(row.right) === String(tun.index))
						return true;
					interfaceMatch = true;
				}
			}
			if (
				row.meta &&
				typeof row.meta === "object" &&
				"key" in row.meta &&
				["iif", "oif", "iifname", "oifname"].includes(String(row.meta.key))
			)
				return true;
			return Object.entries(row).some(
				([key, item]) =>
					!(interfaceMatch && key === "left") && referenced(item, depth + 1),
			);
		};
		for (const raw of [inventory.routes4, inventory.routes6])
			if (rows(raw).some((row) => typeof row.dst !== "string" || !row.dst))
				return false;
		for (const raw of [inventory.rules4, inventory.rules6])
			if (
				rows(raw).some(
					(row) => !Number.isInteger(row.priority) || Number(row.priority) < 0,
				)
			)
				return false;
		if (
			rows(inventory.nexthops).some(
				(row) =>
					!Number.isInteger(row.id) ||
					Number(row.id) < 1 ||
					!(
						typeof row.dev === "string" ||
						Array.isArray(row.group) ||
						row.blackhole === true
					),
			)
		)
			return false;
		for (const raw of [
			inventory.routes4,
			inventory.rules4,
			inventory.rules6,
			inventory.nexthops,
		])
			for (const row of rows(raw)) if (referenced(row)) return false;
		for (const row of rows(inventory.routes6)) {
			// IPv6 creates this exact per-link multicast route on our own TUN.
			// Quiescing the link removes it; no foreign unicast route is exempted.
			const builtin =
				[5, "5", "multicast"].includes(row.type as string | number) &&
				row.dst === "ff00::/8" &&
				row.dev === tun.name &&
				[255, "255", "local"].includes(row.table as string | number) &&
				[2, "2", "kernel"].includes(row.protocol as string | number) &&
				row.metric === 256 &&
				row.pref === "medium" &&
				Array.isArray(row.flags) &&
				(row.flags.length === 0 ||
					(row.flags.length === 1 && row.flags[0] === "linkdown")) &&
				Object.keys(row).every((key) =>
					[
						"type",
						"dst",
						"dev",
						"table",
						"protocol",
						"metric",
						"pref",
						"flags",
					].includes(key),
				);
			if (!builtin && referenced(row)) return false;
		}
		if (
			!inventory.firewall ||
			typeof inventory.firewall !== "object" ||
			!("nftables" in inventory.firewall)
		)
			return false;
		if (
			rows(inventory.firewall.nftables).some(
				(entry) =>
					Object.keys(entry).length !== 1 ||
					!Object.entries(entry).every(
						([key, value]) =>
							[
								"metainfo",
								"table",
								"chain",
								"rule",
								"set",
								"map",
								"element",
								"flowtable",
								"counter",
								"quota",
								"limit",
								"secmark",
								"synproxy",
								"ct helper",
								"ct timeout",
								"ct expectation",
							].includes(key) &&
							!!value &&
							typeof value === "object",
					),
			)
		)
			return false;
		return !referenced(
			rows(inventory.firewall.nftables).filter((entry) => {
				if (Object.keys(entry).length !== 1) return true;
				for (const kind of ["table", "chain", "rule"]) {
					const value = entry[kind];
					if (
						!value ||
						typeof value !== "object" ||
						!("family" in value) ||
						value.family !== "inet"
					)
						continue;
					const name =
						kind === "table" && "name" in value
							? value.name
							: "table" in value
								? value.table
								: undefined;
					if (typeof name === "string" && ownedFences.includes(name))
						return false;
				}
				return true;
			}),
		);
	} catch {
		return false;
	}
}
export async function readCellularTunReferences(
	tun: CellularTunIdentity,
): Promise<CellularTunReferences> {
	const read = async (args: string[]) =>
		JSON.parse(await run("ip", args, { timeout: 4000, maxBuffer: 256 * 1024 }));
	const [addresses, routes4, routes6, rules4, rules6, nexthops, firewall] =
		await Promise.all([
			read(["-j", "addr", "show", "dev", tun.name]),
			read(["-4", "-N", "-j", "route", "show", "table", "all"]),
			read(["-6", "-N", "-j", "route", "show", "table", "all"]),
			read(["-4", "-N", "-j", "rule", "show"]),
			read(["-6", "-N", "-j", "rule", "show"]),
			read(["-N", "-j", "nexthop", "show"]),
			run("nft", ["--numeric", "--json", "list", "ruleset"], {
				timeout: 4000,
				maxBuffer: 1024 * 1024,
			}).then(JSON.parse),
		]);
	return { addresses, routes4, routes6, rules4, rules6, nexthops, firewall };
}
export async function retireCellularTun(
	identity: {
		readonly slot: number;
		readonly owner: string;
		readonly epoch: string;
	},
	tun: CellularTunIdentity,
	io: CellularTunIO,
	writable: () => boolean,
): Promise<boolean> {
	const same = async () => {
		const observed = inspectCellularTun(
			await io.links(),
			identity.slot,
			identity.owner,
			identity.epoch,
		);
		return (
			typeof observed !== "string" &&
			observed.index === tun.index &&
			observed.persistent
		);
	};
	if (
		!writable() ||
		!(await same()) ||
		!cellularTunUnreferenced(tun, await readCellularTunReferences(tun)) ||
		!writable() ||
		!(await same())
	)
		return false;
	return (
		(await changeLinkByIndex(tun.index, { kind: "delete" }, writable)) &&
		inspectCellularTun(
			await io.links(),
			identity.slot,
			identity.owner,
			identity.epoch,
		) === "absent"
	);
}
