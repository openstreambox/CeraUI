import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PrivateStateStore } from "../../helpers/private-json-state.ts";
import { acquirePrivateStateLease } from "../../helpers/private-state-lease.ts";
import {
	type CellularClatSession,
	parseCellularClatBirthPlan,
} from "../network/cellular-clat-session.ts";
import { retainCellularClatSession } from "../network/cellular-clat-session-kernel.ts";
import {
	cellularPhysicalState,
	readCellularSysctl,
} from "../network/cellular-host-identity.ts";
import { CellularIpv6Bootstrap } from "../network/cellular-ipv6-bootstrap.ts";
import { CellularNativeHost } from "../network/cellular-native-host.ts";
import { cellularUplinkSlotKey } from "../network/cellular-native-host-plan.ts";
import {
	type CellularProbeDeps,
	probeCellularDns,
	probeCellularHttps,
} from "../network/cellular-path-probe.ts";
import type { CellularDataGrant } from "./cellular-grant.ts";
import { CellularRuntimeSession } from "./cellular-runtime-session.ts";

export interface CellularRuntimeKernelDeps {
	readonly store: PrivateStateStore;
	readonly bootId: string;
	readonly owned: () => boolean;
	readonly currentNow: () => boolean;
	/** Re-capture device+SIM, MM/NM grant and kernel source; compare generation. */
	readonly current: () => Promise<boolean>;
	readonly withdraw: () => void;
	readonly consumersReleased: () => Promise<boolean>;
	readonly reserve: (bytes: number) => Promise<boolean>;
	readonly probe?: CellularProbeDeps;
}
/** The returned wrapper must be retained by its caller before install. All
 * factories return an inert retained owner first. No failure catch releases a
 * lease after install has been submitted or forgets a durable inverse.
 */
export function createCellularRuntimeKernelSession(
	grant: CellularDataGrant,
	slot: number,
	owner: string,
	epoch: string,
	deps: CellularRuntimeKernelDeps,
): CellularRuntimeSession {
	let clat: CellularClatSession | undefined;
	const { probe: probeDeps, ...hostDeps } = deps;
	const currentNow = () => deps.owned() && deps.currentNow(),
		current = async () =>
			currentNow() && (await deps.current()) && currentNow(),
		base = { ...hostDeps, leases: deps.store, currentNow, current },
		leaseOwner = async <T extends { cleanup(): Promise<boolean> }>(
			make: (owned: () => boolean) => T,
		) => {
			const lease = await acquirePrivateStateLease(
				deps.store,
				cellularUplinkSlotKey(slot),
			);
			if (!lease) return undefined;
			let held = true;
			try {
				const host = make(() => held && deps.owned());
				return {
					host,
					cleanup: async () => {
						if (!(await host.cleanup())) return false;
						held = false;
						lease.release();
						return true;
					},
				};
			} catch (error) {
				// Construction has submitted no hardware or durable effect.
				held = false;
				lease.release();
				throw error;
			}
		};
	return new CellularRuntimeSession(grant, slot, epoch, {
		currentNow,
		current,
		withdraw: deps.withdraw,
		consumersReleased: deps.consumersReleased,
		dns: (path, signal) => probeCellularDns(path, probeDeps, signal),
		https: (path, signal) => probeCellularHttps(path, probeDeps, signal),
		bootstrap: async (consumersReleased) => {
			if (grant.family !== "ipv6" || !(await current())) return undefined;
			const retained = await leaseOwner(
				(owned) =>
					new CellularIpv6Bootstrap(
						{
							owner,
							epoch,
							slot,
							bootId: deps.bootId,
							physical: grant.physical,
							source: grant.source,
							gateway: grant.gateway,
							mtu: grant.mtu,
							dns: grant.dns,
						},
						{
							...base,
							owned,
							consumersReleased,
							probe: (path, signal) =>
								probeCellularDns(path, probeDeps, signal),
						},
					),
			);
			if (!retained) return undefined;
			return {
				install: () => retained.host.install(),
				discover: () => retained.host.discover(),
				cancelProbe: () => retained.host.cancelProbe(),
				cleanup: retained.cleanup,
			};
		},
		host: async (prefix, consumersReleased, cancelProbe) => {
			if (!(await current())) return undefined;
			if (grant.family === "ipv4") {
				const retained = await leaseOwner(
					(owned) =>
						new CellularNativeHost(
							{
								input: {
									owner,
									epoch,
									slot,
									iface: grant.physical.ifname,
									mtu: grant.mtu,
									ipv4: grant.source,
									...(grant.gateway ? { ipv4Gateway: grant.gateway } : {}),
								},
								ifindex: Number(grant.physical.ifindex),
								bootId: deps.bootId,
								dns: grant.dns,
							},
							{ ...base, owned, consumersReleased, cancelProbe },
						),
				);
				if (!retained) return undefined;
				const host = retained.host;
				return {
					binding: host.binding,
					dns: host.dns,
					install: () => host.install(),
					valid: () => host.valid(),
					prepareProbe: () => host.prepareProbe(),
					setReady: (ready) => host.setReady(ready),
					cancelProbe,
					cleanup: retained.cleanup,
				};
			}
			if (
				!prefix ||
				(await cellularPhysicalState(grant.physical)) !== "present"
			)
				return undefined;
			const globalForwarding = (
				await readFile("/proc/sys/net/ipv6/conf/all/forwarding", "ascii")
			).trim();
			if (globalForwarding !== "0" && globalForwarding !== "1")
				return undefined;
			const physicalBefore = {
				accept_ra: await readCellularSysctl(grant.physical, "accept_ra"),
				accept_ra_defrtr: await readCellularSysctl(
					grant.physical,
					"accept_ra_defrtr",
				),
				forwarding: await readCellularSysctl(grant.physical, "forwarding"),
				proxy_ndp: await readCellularSysctl(grant.physical, "proxy_ndp"),
				force_forwarding: await readCellularSysctl(
					grant.physical,
					"force_forwarding",
				),
			};
			clat = await retainCellularClatSession(
				parseCellularClatBirthPlan({
					input: {
						owner,
						epoch,
						slot,
						iface: grant.physical.ifname,
						mtu: grant.mtu,
						ipv6: grant.source,
						ipv6PrefixLength: grant.prefixLength,
						ipv6Gateway: grant.gateway,
						nat64: prefix,
					},
					physical: grant.physical,
					bootId: deps.bootId,
					globalForwarding,
					physicalBefore,
					tunEpoch: randomBytes(32).toString("hex"),
					birth: randomBytes(16).toString("hex"),
					dns: grant.dns,
				}),
				{ ...base, consumersReleased, cancelProbe },
			);
			return clat;
		},
		httpsPath: async (host) =>
			grant.family === "ipv4"
				? {
						source: host.binding.source,
						device: grant.physical.ifname,
						ifindex: Number(grant.physical.ifindex),
					}
				: clat?.sourcePath(),
	});
}
