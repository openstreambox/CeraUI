import { readFile } from "node:fs/promises";
import { logger } from "../../helpers/logger.ts";
import type { PrivateStateStore } from "../../helpers/private-json-state.ts";
import { acquirePrivateStateLease } from "../../helpers/private-state-lease.ts";
import { retainCellularClatSession } from "../network/cellular-clat-session-kernel.ts";
import {
	cellularConsumersAbsent,
	cellularConsumersAbsentWhile,
} from "../network/cellular-consumer-census.ts";
import {
	type CellularHostAuthority,
	inventoryCellularHosts,
} from "../network/cellular-host-inventory.ts";
import { CellularIpv6Bootstrap } from "../network/cellular-ipv6-bootstrap.ts";
import { CellularNativeHost } from "../network/cellular-native-host.ts";
import { cellularUplinkSlotKey } from "../network/cellular-native-host-plan.ts";
import { planCellularRoutes } from "../network/cellular-route-plan.ts";
import {
	cellularSourceExclusionInstalled,
	refreshCellularSourceExclusion,
	withdrawCellularSource,
} from "../network/cellular-source-state.ts";
import {
	type LifecycleLease,
	tryAcquireLifecycle,
} from "../streaming/lifecycle-admission.ts";
import { isRecoveryPending } from "../streaming/recovery-barrier.ts";
import {
	noteMutationJournalReadFault,
	withMutationJournalChange,
} from "./mutation-journal-revision.ts";

export function cellularHostStore(): PrivateStateStore {
	return {
		dir:
			process.env.CERALIVE_CELLULAR_HOST_STATE_DIR ??
			"/data/ceralive/cellular-host",
		change: withMutationJournalChange,
		readFault: noteMutationJournalReadFault,
	};
}
const isolated = new Map<number, CellularHostAuthority>();
export function cellularRecoveryReservedSlots(): readonly number[] {
	return [...isolated.keys()];
}
export function hasIsolatedCellularRecovery(): boolean {
	return isolated.size > 0;
}
export function cellularRecoveryExcludes(
	iface: string,
	source?: string,
): boolean {
	return [...isolated.values()].some((row) => {
		if (row.kind === "bootstrap")
			return (
				iface === row.inverse.plan.physical.ifname ||
				source === row.inverse.plan.source
			);
		if (row.kind === "native") {
			const input = row.inverse.plan.input;
			// Native fences and rules are output-device scoped. A different device
			// may legitimately have the same carrier-private address.
			return iface === input.iface;
		}
		const input = row.birth.plan.input,
			routes = planCellularRoutes(input);
		return (
			!routes ||
			iface === input.iface ||
			iface === routes.device ||
			(!!source && source === routes.source)
		);
	});
}
export async function isolateCellularHostAuthority(
	authority: CellularHostAuthority,
): Promise<boolean> {
	if (!cellularSourceExclusionInstalled()) return false;
	isolated.set(authority.slot, structuredClone(authority));
	refreshCellularSourceExclusion();
	return true;
}
function authorityIface(row: CellularHostAuthority): string {
	return row.kind === "bootstrap"
		? row.inverse.plan.physical.ifname
		: row.kind === "native"
			? row.inverse.plan.input.iface
			: row.birth.plan.input.iface;
}
export function cellularRecoveryStatus(iface: string): string | undefined {
	return [...recoveries.values()]
		.map((owner) => owner.status(iface))
		.find(Boolean)?.reason;
}
export function retryCellularHosts(
	iface?: string,
	presenceChanged = false,
): void {
	if (isRecoveryPending()) return;
	for (const owner of recoveries.values()) {
		if (iface || presenceChanged) owner.changed(iface);
		void owner.retry().catch(() => noteMutationJournalReadFault());
	}
}
type Retained = { readonly cleanup: () => Promise<boolean> };
export interface CellularHostRecoveryDeps {
	readonly store: PrivateStateStore;
	readonly now?: () => number;
	readonly bootId: () => Promise<string>;
	/** May retain a parsed, lease-owned path behind source exclusion. Unknown
	 * inventory, lost metadata or a contended lease cannot become scoped safety. */
	readonly isolate?: (authority: CellularHostAuthority) => Promise<boolean>;
	readonly retain: (
		authority: CellularHostAuthority,
		bootId: string,
	) => Promise<Retained | undefined>;
}
/** Startup and isolated withdrawal share the retained lease owner. Runtime
 * retries touch only quarantined slots, never newly installed active hosts. */
export class CellularHostRecovery {
	private readonly retained = new Map<number, Retained>();
	private readonly retries = new Map<
		number,
		{ reason: string; delay: number; due: number }
	>();
	private readonly busy = new Set<number>();
	constructor(private readonly deps: CellularHostRecoveryDeps) {}
	private now(): number {
		return this.deps.now?.() ?? performance.now();
	}
	status(iface: string): { reason: string } | undefined {
		const row = [...isolated.values()].find(
			(row) => authorityIface(row) === iface && this.retained.has(row.slot),
		);
		return row ? this.retries.get(row.slot) : undefined;
	}
	changed(iface?: string): void {
		for (const row of isolated.values()) {
			const retry = this.retries.get(row.slot);
			if (retry && (!iface || authorityIface(row) === iface)) retry.due = 0;
		}
	}
	async retry(): Promise<void> {
		await Promise.all(
			[...this.retries].map(async ([slot, retry]) => {
				if (this.busy.has(slot) || retry.due > this.now()) return;
				this.busy.add(slot);
				try {
					const rows = await inventoryCellularHosts(this.deps.store);
					const row = rows.find((row) => row.slot === slot);
					if (row && JSON.stringify(row) !== JSON.stringify(isolated.get(slot)))
						throw new Error("Quarantined cellular authority changed");
					await this.replay(slot);
				} finally {
					this.busy.delete(slot);
				}
			}),
		);
	}
	async replay(onlySlot?: number): Promise<void> {
		const rows = (await inventoryCellularHosts(this.deps.store)).filter(
			(row) => onlySlot === undefined || row.slot === onlySlot,
		);
		for (const [slot, owner] of this.retained) {
			if (onlySlot !== undefined && slot !== onlySlot) continue;
			if (rows.some((row) => row.slot === slot)) continue;
			// Resume only the retained object's absence/directory-ack tail. Actual host
			// owners refuse this path if any kernel resource remains without authority.
			if (!(await owner.cleanup()))
				throw new Error("Retained cellular recovery lost its authority");
			this.retained.delete(slot);
			this.retries.delete(slot);
			if (isolated.delete(slot)) refreshCellularSourceExclusion();
		}
		if (!rows.length) return;
		const bootId = await this.deps.bootId();
		if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId))
			throw new Error("Cellular recovery boot identity unavailable");
		let incomplete = false;
		for (const row of rows) {
			try {
				let owner = this.retained.get(row.slot);
				if (!owner) {
					owner = await this.deps.retain(row, bootId);
					if (owner) this.retained.set(row.slot, owner);
				}
				if (!owner || !(await owner.cleanup())) {
					incomplete = true;
					continue;
				}
				this.retained.delete(row.slot);
				this.retries.delete(row.slot);
				if (isolated.delete(row.slot)) refreshCellularSourceExclusion();
				if (onlySlot !== undefined) return;
			} catch {
				incomplete = true;
			}
		}
		const remaining = (await inventoryCellularHosts(this.deps.store)).filter(
			(row) => onlySlot === undefined || row.slot === onlySlot,
		);
		if (remaining.length && this.deps.isolate) {
			for (const row of remaining) {
				const observed = rows.find((before) => before.slot === row.slot);
				if (
					!observed ||
					observed.kind !== row.kind ||
					JSON.stringify(
						observed.kind === "clat"
							? observed.birth.plan
							: observed.inverse.plan,
					) !==
						JSON.stringify(
							row.kind === "clat" ? row.birth.plan : row.inverse.plan,
						) ||
					!this.retained.has(row.slot) ||
					!(await this.deps.isolate(row))
				)
					throw new Error("Cellular recovery cannot establish path isolation");
				const delay = Math.min(
					(this.retries.get(row.slot)?.delay ?? 500) * 2,
					60_000,
				);
				this.retries.set(row.slot, {
					reason: "withdrawal-incomplete",
					delay,
					due: this.now() + delay,
				});
				logger.warn("Cellular host quarantined; withdrawal will retry", {
					module: "modems",
					iface: authorityIface(row),
					slot: row.slot,
					reason: "withdrawal-incomplete",
					retryMs: delay,
				});
			}
			return;
		}
		if (incomplete || remaining.length)
			throw new Error("Cellular host withdrawal incomplete");
	}
	/** Runtime fault reconciliation is read-only; it never rolls an active path back. */
	async verify(): Promise<void> {
		const rows = await inventoryCellularHosts(this.deps.store);
		for (const [slot, authority] of isolated) {
			if (!this.retained.has(slot)) continue;
			if (
				JSON.stringify(rows.find((row) => row.slot === slot)) !==
				JSON.stringify(authority)
			)
				throw new Error("Quarantined cellular authority changed");
		}
	}
}
export async function retainCellularHostInverse(
	authority: CellularHostAuthority,
	bootId: string,
	store: PrivateStateStore,
	consumersReleased?: () => Promise<boolean>,
): Promise<Retained | undefined> {
	if (!isRecoveryPending())
		throw new Error("Cellular recovery barrier unavailable");
	let cleanupLease: LifecycleLease | undefined;
	const input =
			authority.kind === "bootstrap"
				? {
						owner: authority.inverse.plan.owner,
						epoch: authority.inverse.plan.epoch,
						iface: authority.inverse.plan.physical.ifname,
					}
				: authority.kind === "native"
					? authority.inverse.plan.input
					: authority.birth.plan.input,
		withdraw = () => {
			withdrawCellularSource(input.owner, input.epoch, input.iface);
		},
		deps = {
			store,
			leases: store,
			bootId,
			owned: () =>
				isRecoveryPending() ||
				(cellularSourceExclusionInstalled() && isolated.has(authority.slot)),
			currentNow: () => false,
			current: async () => false,
			withdraw,
			cancelProbe: () => {
				/* Startup replay precedes managed probe admission. */
			},
			consumersReleased:
				consumersReleased ??
				(async (): Promise<boolean> => {
					if (isRecoveryPending()) return cellularConsumersAbsent();
					if (!cleanupLease) {
						const admission = tryAcquireLifecycle("modem-transition");
						if (!admission.admitted) return false;
						cleanupLease = admission.lease;
					}
					return cellularConsumersAbsentWhile(
						() => !!cleanupLease && deps.owned(),
					);
				}),
		};
	const attempt = async (cleanup: () => Promise<boolean>) => {
		try {
			return await cleanup();
		} finally {
			cleanupLease?.release();
			cleanupLease = undefined;
		}
	};
	if (authority.kind === "clat") {
		const host = await retainCellularClatSession(authority.birth.plan, deps);
		return host ? { cleanup: () => attempt(() => host.cleanup()) } : undefined;
	}
	const lease = await acquirePrivateStateLease(
		store,
		cellularUplinkSlotKey(authority.slot),
	);
	if (!lease) return undefined;
	let held = true;
	try {
		const guarded = { ...deps, owned: () => held && deps.owned() };
		const host =
			authority.kind === "bootstrap"
				? new CellularIpv6Bootstrap(authority.inverse.plan, {
						...guarded,
						reserve: async () => false,
					})
				: new CellularNativeHost(authority.inverse.plan, guarded);
		return {
			cleanup: () =>
				attempt(async () => {
					if (!(await host.cleanup())) return false;
					held = false;
					lease.release();
					return true;
				}),
		};
	} catch (error) {
		held = false;
		lease.release();
		throw error;
	}
}
const recoveries = new Map<string, CellularHostRecovery>();
function recovery() {
	const store = cellularHostStore();
	let owner = recoveries.get(store.dir);
	if (!owner) {
		owner = new CellularHostRecovery({
			store,
			bootId: async () =>
				(await readFile("/proc/sys/kernel/random/boot_id", "ascii")).trim(),
			retain: (authority, bootId) =>
				retainCellularHostInverse(authority, bootId, store),
			isolate: isolateCellularHostAuthority,
		});
		recoveries.set(store.dir, owner);
	}
	return owner;
}
export async function replayCellularHosts(): Promise<void> {
	try {
		await recovery().replay();
	} catch (error) {
		noteMutationJournalReadFault();
		throw error;
	}
}
export async function verifyCellularHosts(): Promise<void> {
	try {
		await recovery().verify();
	} catch (error) {
		noteMutationJournalReadFault();
		throw error;
	}
}
