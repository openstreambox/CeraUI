import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readPrivateJson } from "../../helpers/private-json-state.ts";
import { acquirePrivateStateLease } from "../../helpers/private-state-lease.ts";
import { readCellularClatAllocation } from "./cellular-clat-allocation.ts";
import { CellularClatHost } from "./cellular-clat-host.ts";
import type { CellularClatHostPlan } from "./cellular-clat-host-plan.ts";
import { createCellularClatKernelEffects } from "./cellular-clat-kernel-effects.ts";
import {
	type CellularClatBirthPlan,
	CellularClatSession,
	parseCellularClatBirthPlan,
} from "./cellular-clat-session.ts";
import { CellularFirewall, cellularFirewallIO } from "./cellular-firewall.ts";
import { CellularForwardFence } from "./cellular-forward-fence.ts";
import {
	cellularPhysicalState,
	readCellularSysctl,
} from "./cellular-host-identity.ts";
import { CellularIpState, cellularIpIO } from "./cellular-ip-state.ts";
import { planCellularRoutes } from "./cellular-route-plan.ts";
import { cellularTunIO, createCellularTun } from "./cellular-tun.ts";
import {
	cellularTunUnreferenced,
	readCellularTunReferences,
	retireCellularTun,
} from "./cellular-tun-retirement.ts";

export interface CellularClatSessionKernelDeps {
	readonly store: { readonly dir: string };
	readonly leases: { readonly dir: string };
	readonly bootId: string;
	/** The retained actor, independent of the current grant observation. */
	readonly owned: () => boolean;
	readonly currentNow: () => boolean;
	readonly current: () => Promise<boolean>;
	readonly withdraw: () => void;
	readonly cancelProbe: () => void;
	readonly consumersReleased: () => Promise<boolean>;
}
/** A caller must retain the returned owner even when install throws. No catch
 * releases a lease or removes birth authority after an uncertain kernel reply.
 * Recovery constructs this same owner and calls cleanup; it never calls install.
 */
export async function retainCellularClatSession(
	raw: CellularClatBirthPlan,
	deps: CellularClatSessionKernelDeps,
): Promise<CellularClatSession | undefined> {
	const plan = parseCellularClatBirthPlan(raw),
		routes = planCellularRoutes(plan.input);
	if (!routes?.translated || !routes.mapped || !routes.nat64)
		throw new Error("CLAT kernel grant required");
	const key = createHash("sha256")
			.update(`cellular-uplink-slot\0${plan.input.slot}`)
			.digest("hex"),
		lease = await acquirePrivateStateLease(deps.leases, key);
	if (!lease) return undefined;
	let held = true,
		withdrawn = false,
		session: CellularClatSession;
	const owned = () => held && deps.owned(),
		currentNow = () =>
			owned() && deps.currentNow() && session.installingAllowed,
		current = async () =>
			currentNow() && (await deps.current()) && currentNow(),
		writable = () => owned() && plan.bootId === deps.bootId,
		tunIO = cellularTunIO(current, currentNow),
		withdraw = () => {
			if (!withdrawn) {
				withdrawn = true;
				deps.withdraw();
			}
		};
	try {
		session = new CellularClatSession(plan, {
			...deps,
			owned,
			preflight: async () => {
				if (
					!(await current()) ||
					(await readPrivateJson(deps.store, key)) ||
					(await readCellularClatAllocation(
						routes,
						plan.physical.ifname,
						current,
					)) !== "clear"
				)
					return false;
				if (
					(
						await readFile("/proc/sys/net/ipv6/conf/all/forwarding", "utf8")
					).trim() !== plan.globalForwarding
				)
					return false;
				if ((await cellularPhysicalState(plan.physical)) !== "present")
					return false;
				for (const k of [
					"accept_ra",
					"accept_ra_defrtr",
					"forwarding",
					"proxy_ndp",
					"force_forwarding",
				] as const)
					if (
						(await readCellularSysctl(plan.physical, k)) !==
						plan.physicalBefore[k]
					)
						return false;
				// A future TUN index is irrelevant to an absent table baseline. It is
				// never adopted; the child reconstructs both tables with the born index.
				const futureIndex = Number(plan.physical.ifindex) === 1 ? 2 : 1,
					nft = cellularFirewallIO(current),
					output = new CellularFirewall(
						{
							owner: plan.input.owner,
							slot: plan.input.slot,
							source: routes.source,
							ifindex: futureIndex,
							translated: true,
							dns: [],
						},
						nft,
					),
					forward = new CellularForwardFence(
						{
							owner: plan.input.owner,
							slot: plan.input.slot,
							tunIndex: futureIndex,
							physicalIndex: Number(plan.physical.ifindex),
							mapped: routes.mapped as string,
							nat64: routes.nat64 as string,
							isolatePhysical: true,
						},
						nft,
					),
					ip = new CellularIpState(routes, cellularIpIO(current));
				if (
					(await output.inspect()) !== "absent" ||
					(await forward.inspect()) !== "absent"
				)
					return false;
				for (const effect of routes.effects)
					if ((await ip.inspect(effect)) !== "absent") return false;
				return current();
			},
			links: tunIO.links,
			createTun: () =>
				createCellularTun(
					plan.input.slot,
					plan.input.owner,
					plan.tunEpoch,
					tunIO,
				),
			unreferenced: async (tun) =>
				cellularTunUnreferenced(tun, await readCellularTunReferences(tun)),
			deleteTun: (tun) =>
				retireCellularTun(
					{
						slot: plan.input.slot,
						owner: plan.input.owner,
						epoch: plan.tunEpoch,
					},
					tun,
					tunIO,
					writable,
				),
			child: (captured: CellularClatHostPlan) =>
				new CellularClatHost(captured, {
					...deps,
					owned,
					currentNow,
					current,
					withdraw,
					effects: (authority, route, guard) =>
						createCellularClatKernelEffects(authority, route, guard, {
							store: deps.store,
							bootId: deps.bootId,
						}),
				}),
			withdraw,
			release: () => {
				held = false;
				lease.release();
			},
		});
		return session;
	} catch (error) {
		held = false;
		lease.release();
		throw error;
	}
}
