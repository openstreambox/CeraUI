import { run } from "../../helpers/run.ts";
import {
	type CellularIpEffect,
	type CellularRoutePlan,
	cellularIpArgv,
} from "./cellular-route-plan.ts";

type Row = Record<string, unknown>;
function object(value: unknown): Row {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Unknown cellular IP inventory row");
	return value as Row;
}
function numeric(value: unknown): number {
	if (
		(typeof value !== "number" && typeof value !== "string") ||
		!/^\d+$/.test(String(value)) ||
		!Number.isSafeInteger(Number(value))
	)
		throw new Error("Unknown cellular IP numeric field");
	return Number(value);
}
function hostPrefix(value: unknown): string {
	if (typeof value !== "string")
		throw new Error("Unknown cellular IP selector");
	return value.replace(/\/(?:32|128)$/, "");
}
function normalize(
	raw: unknown,
	kind: "rule" | "route",
	family: 4 | 6,
	allowDetached: boolean,
): Row {
	const row = object(raw),
		result: Row = {};
	const allowed =
		kind === "rule"
			? [
					"priority",
					"src",
					"dst",
					"iif",
					"oif",
					"table",
					"protocol",
					"action",
					"iif_detached",
					"oif_detached",
				]
			: [
					"dst",
					"gateway",
					"dev",
					"protocol",
					"scope",
					"prefsrc",
					"flags",
					"metrics",
					"metric",
					"pref",
				];
	if (Object.keys(row).some((key) => !allowed.includes(key)))
		throw new Error("Foreign cellular IP attributes");
	for (const [key, value] of Object.entries(row)) {
		if (key === "iif_detached" || key === "oif_detached") {
			const selector = row[key.slice(0, 3)];
			if (
				!allowDetached ||
				value !== null ||
				typeof selector !== "string" ||
				!selector ||
				selector === "lo"
			)
				throw new Error("Unknown detached cellular selector");
			// iproute2's null marker reports a kernel-detached selector. It never
			// admits readiness; cleanup still requires the complete owned tuple.
		} else if (key === "flags") {
			if (
				!Array.isArray(value) ||
				value.some((flag) => flag !== "onlink") ||
				value.length > 1
			)
				throw new Error("Foreign cellular route flags");
			if (value.length) result.flags = value;
		} else if (key === "metrics") {
			if (!Array.isArray(value) || value.length !== 1)
				throw new Error("Foreign cellular route metrics");
			const metrics = object(value[0]);
			if (Object.keys(metrics).length !== 1 || !("mtu" in metrics))
				throw new Error("Foreign cellular route metrics");
			result.mtu = numeric(metrics.mtu);
		} else if (key === "metric" && family === 6 && value === 1024) {
			// iproute2's default IPv6 metric when no metric was requested.
		} else if (
			key === "pref" &&
			family === 6 &&
			(value === "medium" || value === "0" || value === 0)
		) {
			// Kernel default router preference, never another preference.
		} else if (
			key === "scope" &&
			(value === "link" || value === "253" || value === 253)
		) {
			result.scope = "link";
		} else if (
			key === "action" &&
			(value === "7" || value === 7 || value === "unreachable")
		)
			result.action = "unreachable";
		else if (["priority", "table", "protocol"].includes(key))
			result[key] = numeric(value);
		else if (["src", "dst", "prefsrc"].includes(key))
			result[key] = hostPrefix(value);
		else if (typeof value === "string") result[key] = value;
		else throw new Error("Unknown cellular IP field");
	}
	return result;
}
function expected(effect: CellularIpEffect): Row {
	const args = [...effect.selector],
		row: Row = {};
	if (effect.kind === "route") {
		if (args.shift() !== "table")
			throw new Error("Route outside a private table");
		numeric(args.shift());
		row.dst = hostPrefix(args.shift());
	} else row.src = "all";
	while (args.length) {
		const key = args.shift();
		if (key === "unreachable") {
			row.action = key;
			continue;
		}
		if (key === "onlink") {
			row.flags = ["onlink"];
			continue;
		}
		const value = args.shift();
		if (value === undefined) throw new Error("Incomplete cellular IP effect");
		if (key === "table" || key === "lookup") row.table = numeric(value);
		else if (
			key === "priority" ||
			key === "protocol" ||
			key === "proto" ||
			key === "mtu"
		)
			row[key === "proto" ? "protocol" : key] = numeric(value);
		else if (key === "from" || key === "to" || key === "src")
			row[key === "from" ? "src" : key === "to" ? "dst" : "prefsrc"] =
				hostPrefix(value);
		else if (key === "dev" || key === "oif" || key === "iif" || key === "via")
			row[key === "via" ? "gateway" : key] = value;
		else throw new Error("Unrecognized cellular IP effect");
	}
	if (effect.kind === "route" && effect.family === 4 && !row.gateway)
		row.scope = "link";
	return row;
}
function fingerprint(row: Row): string {
	return JSON.stringify(
		Object.entries(row).sort(([a], [b]) => a.localeCompare(b)),
	);
}
/** Exact row matcher for an inverse checkpoint; matching is not birth authority. */
export function cellularIpEffectMatches(
	effect: CellularIpEffect,
	raw: unknown,
): boolean {
	try {
		let row = object(raw);
		if (effect.kind === "route") {
			if (numeric(row.table) !== numeric(effect.selector[1])) return false;
			const { table: _table, ...rest } = row;
			row = rest;
		}
		return (
			fingerprint(normalize(row, effect.kind, effect.family, true)) ===
			fingerprint(expected(effect))
		);
	} catch {
		return false;
	}
}
export interface CellularIpIO {
	readonly read: (argv: string[]) => Promise<string>;
	readonly write: (argv: string[]) => Promise<void>;
	readonly current: () => Promise<boolean>;
}
export function cellularIpIO(current: () => Promise<boolean>): CellularIpIO {
	return {
		current,
		read: (argv) => run("ip", argv, { timeout: 4000, maxBuffer: 256 * 1024 }),
		write: async (argv) => {
			await run("ip", argv, { timeout: 4000, maxBuffer: 16 * 1024 });
		},
	};
}
/** Exact owned tuples only. Every route in the private table and every rule
 * with the reserved protocol must be recognized before any effect is removed.
 * Caller records birth first and holds the slot's kernel lease throughout.
 */
export class CellularIpState {
	constructor(
		readonly plan: CellularRoutePlan,
		private readonly io: CellularIpIO,
	) {}
	async inspect(
		effect: CellularIpEffect,
		allowDetached = false,
	): Promise<"absent" | "owned" | "foreign"> {
		if (!this.plan.effects.includes(effect))
			throw new Error("Unowned cellular IP effect");
		const family = effect.family,
			protocol = expected(effect).protocol;
		const [routeText, ruleText] = await Promise.all([
			this.io.read([`-${family}`, "-N", "-j", "route", "show", "table", "all"]),
			this.io.read([`-${family}`, "-N", "-j", "rule", "show"]),
		]);
		const routes: unknown = JSON.parse(routeText),
			rules: unknown = JSON.parse(ruleText);
		if (!Array.isArray(routes) || !Array.isArray(rules))
			throw new Error("Unknown cellular IP inventory");
		const known = this.plan.effects.filter((entry) => entry.family === family),
			counts = new Map<string, number>();
		try {
			for (const [kind, rows] of [
				["route", routes],
				["rule", rules],
			] as const)
				for (const entry of rows) {
					let raw = entry;
					if (kind === "route") {
						const row = object(raw);
						if (Number(row.table) !== this.plan.table) continue;
						const { table: _table, ...rest } = row;
						raw = rest;
					}
					if (kind === "rule" && Number(object(raw).protocol) !== protocol)
						continue;
					const value = fingerprint(
						normalize(raw, kind, family, allowDetached),
					);
					if (
						!known.some(
							(entry) =>
								entry.kind === kind && fingerprint(expected(entry)) === value,
						)
					)
						return "foreign";
					const key = `${kind}:${value}`,
						count = (counts.get(key) ?? 0) + 1;
					if (count > 1) return "foreign";
					counts.set(key, count);
				}
		} catch {
			return "foreign";
		}
		return counts.has(`${effect.kind}:${fingerprint(expected(effect))}`)
			? "owned"
			: "absent";
	}
	async apply(effect: CellularIpEffect): Promise<void> {
		if (
			!(await this.io.current()) ||
			(await this.inspect(effect)) !== "absent" ||
			!(await this.io.current())
		)
			throw new Error("Cellular IP birth changed");
		await this.io.write(cellularIpArgv(effect, "add"));
		if (!(await this.io.current()) || (await this.inspect(effect)) !== "owned")
			throw new Error("Cellular IP effect did not verify");
	}
	async remove(effect: CellularIpEffect): Promise<boolean> {
		const before = await this.inspect(effect, true);
		if (before === "absent") return true;
		if (before !== "owned") return false;
		await this.io.write(cellularIpArgv(effect, "del"));
		return (await this.inspect(effect, true)) === "absent";
	}
}
