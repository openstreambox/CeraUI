import { run } from "../../helpers/run.ts";
import {
	type CellularIndexedIpEffect,
	changeCellularIndexedIp,
} from "./cellular-indexed-ip.ts";
import { formatIpv6, parseIpv4, parseIpv6 } from "./nat64.ts";
import { isSafeIfname } from "./safe-ifname.ts";

type State = "absent" | "owned" | "foreign";
export interface CellularIndexedIpIO {
	/** Fresh owner alias/index for a TUN, or USB instance/index for a modem. */
	readonly identity: () => Promise<
		"present" | "absent" | "foreign" | "unknown"
	>;
	readonly read: (argv: string[]) => Promise<string>;
	readonly write: (
		index: number,
		effect: CellularIndexedIpEffect,
		op: "add" | "del",
	) => Promise<boolean>;
}
export function cellularIndexedIpIO(
	identity: CellularIndexedIpIO["identity"],
	writable: () => boolean,
): CellularIndexedIpIO {
	return {
		identity,
		read: (argv) => run("ip", argv, { timeout: 4000, maxBuffer: 256 * 1024 }),
		write: (index, effect, op) =>
			changeCellularIndexedIp(index, effect, op, writable),
	};
}
function canonical(address: unknown, family: 4 | 6): string | undefined {
	if (typeof address !== "string" || address.includes("%")) return undefined;
	if (family === 4) return parseIpv4(address) ? address : undefined;
	const bytes = parseIpv6(address);
	return bytes ? formatIpv6(bytes) : undefined;
}
function rows(raw: string): Record<string, unknown>[] {
	const parsed: unknown = JSON.parse(raw);
	if (
		!Array.isArray(parsed) ||
		parsed.length > 4096 ||
		parsed.some((r) => !r || typeof r !== "object" || Array.isArray(r))
	)
		throw new Error("Unknown indexed IP inventory");
	return parsed;
}
/** Address/proxy inverse with exact readback. An existing matching tuple is not
 * birth authority; apply refuses it. The durable cursor supplies cleanup
 * authority, and the caller holds the instance/slot lease for the whole call.
 * These operations never flush addresses, neighbours or a routing table.
 */
export class CellularIndexedIpState {
	constructor(
		readonly link: { readonly name: string; readonly index: number },
		readonly effects: readonly CellularIndexedIpEffect[],
		private readonly io: CellularIndexedIpIO,
	) {
		if (
			!isSafeIfname(link.name) ||
			!Number.isInteger(link.index) ||
			link.index < 1 ||
			link.index > 0x7fffffff
		)
			throw new Error("Invalid indexed IP identity");
	}
	async inspect(effect: CellularIndexedIpEffect): Promise<State> {
		if (!this.effects.includes(effect))
			throw new Error("Unowned indexed IP effect");
		const identity = await this.io.identity();
		if (identity === "absent") return "absent";
		if (identity !== "present") return "foreign";
		const inventory = rows(
			await this.io.read(
				effect.kind === "proxy"
					? ["-6", "-j", "neigh", "show", "proxy"]
					: ["-j", "addr", "show"],
			),
		);
		if ((await this.io.identity()) !== "present") return "foreign";
		const address = canonical(effect.address, effect.family);
		if (!address) throw new Error("Invalid indexed IP selector");
		if (effect.kind === "proxy") {
			if (
				inventory.some(
					(row) => typeof row.dev !== "string" || !canonical(row.dst, 6),
				)
			)
				return "foreign";
			const found = inventory.filter(
				(row) =>
					row.dev === this.link.name && canonical(row.dst, 6) === address,
			);
			if (!found.length) return "absent";
			return found.length === 1 &&
				found[0]?.proxy === null &&
				Object.keys(found[0]).every((key) =>
					["dst", "dev", "proxy"].includes(key),
				)
				? "owned"
				: "foreign";
		}
		if (
			inventory.some(
				(row) =>
					!Number.isInteger(row.ifindex) ||
					Number(row.ifindex) < 1 ||
					Number(row.ifindex) > 0x7fffffff ||
					typeof row.ifname !== "string" ||
					!Array.isArray(row.addr_info),
			)
		)
			return "foreign";
		const links = inventory.filter((row) => row.ifindex === this.link.index);
		if (
			links.length !== 1 ||
			links[0]?.ifname !== this.link.name ||
			!Array.isArray(links[0]?.addr_info)
		)
			return "foreign";
		if (
			links[0].addr_info.some(
				(row) =>
					!row ||
					typeof row !== "object" ||
					!["inet", "inet6"].includes(row.family) ||
					!canonical(row.local, row.family === "inet" ? 4 : 6),
			)
		)
			return "foreign";
		const found = links[0].addr_info.filter(
			(row) =>
				row &&
				row.family === (effect.family === 4 ? "inet" : "inet6") &&
				canonical(row.local, effect.family) === address,
		);
		if (!found.length) return "absent";
		const row = found[0];
		if (
			found.length !== 1 ||
			!row ||
			row.prefixlen !== effect.prefix ||
			row.scope !== "global" ||
			row.noprefixroute !== true ||
			row.valid_life_time !== 0xffffffff ||
			row.preferred_life_time !== 0xffffffff ||
			(effect.family === 6 && row.nodad !== true)
		)
			return "foreign";
		return Object.keys(row).every((key) =>
			[
				"family",
				"local",
				"prefixlen",
				"scope",
				"label",
				"nodad",
				"noprefixroute",
				"valid_life_time",
				"preferred_life_time",
			].includes(key),
		) &&
			(row.label === undefined || row.label === this.link.name)
			? "owned"
			: "foreign";
	}
	async apply(effect: CellularIndexedIpEffect): Promise<void> {
		if (
			(await this.inspect(effect)) !== "absent" ||
			(await this.io.identity()) !== "present"
		)
			throw new Error("Indexed IP birth changed");
		if (
			!(await this.io.write(this.link.index, effect, "add")) ||
			(await this.inspect(effect)) !== "owned"
		)
			throw new Error("Indexed IP birth unconfirmed");
	}
	async remove(effect: CellularIndexedIpEffect): Promise<boolean> {
		const before = await this.inspect(effect);
		if (before === "absent") return true;
		if (before !== "owned" || (await this.io.identity()) !== "present")
			return false;
		if (!(await this.io.write(this.link.index, effect, "del"))) return false;
		return (await this.inspect(effect)) === "absent";
	}
}
