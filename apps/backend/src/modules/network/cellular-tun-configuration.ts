import { changeLinkByIndex } from "../../helpers/netlink-link.ts";
import {
	type CellularScopedSysctl,
	type CellularScopedSysctlValue,
	compareAndSetScopedCellularSysctl,
	readScopedCellularSysctl,
} from "./cellular-host-identity.ts";
import { type CellularTunIO, inspectCellularTun } from "./cellular-tun.ts";

export interface CellularTunConfiguration {
	readonly slot: number;
	readonly owner: string;
	readonly epoch: string;
	readonly index: number;
	readonly linkMtu: number;
}
const settings: readonly (readonly [
	CellularScopedSysctl,
	CellularScopedSysctlValue,
])[] = [
	["accept_ra", "0"],
	["accept_ra_defrtr", "0"],
	["autoconf", "0"],
	["addr_gen_mode", "1"],
	["accept_dad", "0"],
	["disable_ipv6", "0"],
	["forwarding", "1"],
	["force_forwarding", "1"],
];
async function view(plan: CellularTunConfiguration, io: CellularTunIO) {
	if (
		!Number.isInteger(plan.index) ||
		plan.index < 1 ||
		plan.index > 0x7fffffff ||
		!Number.isInteger(plan.linkMtu) ||
		plan.linkMtu < 1280 ||
		plan.linkMtu > 9000
	)
		throw new Error("Invalid translator configuration identity");
	const links = await io.links(),
		identity = inspectCellularTun(links, plan.slot, plan.owner, plan.epoch);
	if (
		typeof identity === "string" ||
		identity.index !== plan.index ||
		!identity.persistent
	)
		return undefined;
	const row = Array.isArray(links)
		? links.find(
				(entry) =>
					entry.ifindex === plan.index && entry.ifname === identity.name,
			)
		: undefined;
	if (!row || !Number.isInteger(row.mtu) || !Array.isArray(row.flags))
		return undefined;
	return { identity, mtu: Number(row.mtu), up: row.flags.includes("UP") };
}
/** Initial configuration of a freshly owned TUN. The parent inverse records
 * birth/configuration before entry and retains its lease across every await.
 * Forward confinement must already exist before force_forwarding is enabled.
 * No physical carrier interface or global/default sysctl is configured here.
 */
export async function configureCellularTun(
	plan: CellularTunConfiguration,
	io: CellularTunIO,
	writable: () => boolean,
): Promise<boolean> {
	const current = async () =>
		writable() &&
		(await io.current()) &&
		!!(await view(plan, io)) &&
		writable();
	if (!(await current())) return false;
	const link = { ifname: `cclat${plan.slot}`, current, writable };
	for (const [key, desired] of settings) {
		const before = await readScopedCellularSysctl(link, key);
		if (
			before === undefined ||
			!(await compareAndSetScopedCellularSysctl(link, key, before, desired))
		)
			return false;
	}
	if (
		!(await current()) ||
		!(await changeLinkByIndex(
			plan.index,
			{ kind: "mtu", mtu: plan.linkMtu },
			writable,
		)) ||
		!(await current()) ||
		!(await changeLinkByIndex(plan.index, { kind: "up", up: true }, writable))
	)
		return false;
	return verifyCellularTunConfiguration(plan, io, writable);
}
export async function verifyCellularTunConfiguration(
	plan: CellularTunConfiguration,
	io: CellularTunIO,
	writable: () => boolean,
): Promise<boolean> {
	const current = async () =>
		writable() &&
		(await io.current()) &&
		!!(await view(plan, io)) &&
		writable();
	if (!(await current())) return false;
	const state = await view(plan, io);
	if (!state?.up || state.mtu !== plan.linkMtu) return false;
	const link = { ifname: state.identity.name, current, writable };
	for (const [key, desired] of settings)
		if ((await readScopedCellularSysctl(link, key)) !== desired) return false;
	const final = await view(plan, io);
	return !!final?.up && final.mtu === plan.linkMtu && (await current());
}

/** Inverse after sockets, translator and owned addresses/routes are gone.
 * The caller proves no foreign TUN resources before entry, retains its birth
 * lease and supplies identity-only cleanup IO. Quiesce before removing forward
 * confinement; an interrupted inverse can repeat these indexed operations.
 */
export async function quiesceCellularTun(
	plan: CellularTunConfiguration,
	io: CellularTunIO,
	writable: () => boolean,
): Promise<boolean> {
	const current = async () =>
		writable() &&
		(await io.current()) &&
		!!(await view(plan, io)) &&
		writable();
	if (!(await current())) return false;
	const link = { ifname: `cclat${plan.slot}`, current, writable },
		force = await readScopedCellularSysctl(link, "force_forwarding");
	if (
		(force !== "0" && force !== "1") ||
		!(await compareAndSetScopedCellularSysctl(
			link,
			"force_forwarding",
			force,
			"0",
		)) ||
		!(await current()) ||
		!(await changeLinkByIndex(plan.index, { kind: "up", up: false }, writable))
	)
		return false;
	const state = await view(plan, io);
	return (
		!!state &&
		!state.up &&
		(await readScopedCellularSysctl(link, "force_forwarding")) === "0" &&
		(await current())
	);
}
