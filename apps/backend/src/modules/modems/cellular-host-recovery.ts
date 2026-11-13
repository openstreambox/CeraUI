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
	tryAcquireCellularRecovery,
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
function scopedRecoveryStore(store: PrivateStateStore): PrivateStateStore {
	// Runtime read failures keep the established per-slot fence; startup and
	// verification wrappers own global authority-fault publication.
	const { readFault: _readFault, ...scoped } = store;
	return scoped;
}
const isolated = new Map<number, CellularHostAuthority>();
/** Durable authority found in place of a quarantined slot's own. The slot stays
 * fenced under both, its cleanup stops (the retained owner has no authority
 * over the new record) and new streams are refused. Paths on other slots are
 * not withdrawn: their records were read in the same inventory and are intact. */
const displaced = new Map<number, CellularHostAuthority>();
/** What a quarantine was established for. A record's cursor and phase, and a
 * translated path's child record, are the slot's own cleanup progress. */
function authorityIdentity(row: CellularHostAuthority): string {
	const plan = row.kind === "clat" ? row.birth.plan : row.inverse.plan;
	return JSON.stringify([
		row.kind,
		row.slot,
		...(row.kind === "clat"
			? [row.birth.plan.input.owner, row.birth.plan.input.epoch]
			: [row.inverse.owner, row.inverse.epoch]),
		plan,
	]);
}
export function cellularRecoveryReservedSlots(): readonly number[] {
	return [...isolated.keys()];
}
export function hasIsolatedCellularRecovery(): boolean {
	return isolated.size > 0;
}
/** A quarantined slot whose durable authority was replaced holds new stream
 * starts, in the shape the start gate already refuses on. */
export function cellularRecoveryStartBlock():
	| { readonly stableKey: string }
	| undefined {
	const slot = displaced.keys().next().value;
	return slot === undefined
		? undefined
		: { stableKey: `cellular-slot-${slot}-authority-changed` };
}
export function cellularRecoveryExcludes(
	iface: string,
	source?: string,
): boolean {
	return [...isolated.values(), ...displaced.values()].some((row) => {
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
export async function retryCellularHosts(
	iface?: string,
	presenceChanged = false,
): Promise<void> {
	if (isRecoveryPending()) return;
	if (iface || presenceChanged) {
		for (const owner of recoveries.values()) owner.changed(iface);
		return;
	}
	await Promise.all([...recoveries.values()].map((owner) => owner.retry()));
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
		{ delay: number; due: number; last: number; wake: number }
	>();
	private readonly busy = new Set<number>();
	constructor(private readonly deps: CellularHostRecoveryDeps) {}
	private now(): number {
		return this.deps.now?.() ?? performance.now();
	}
	status(iface: string): { reason: string } | undefined {
		for (const slot of this.retries.keys()) {
			if (!this.retained.has(slot)) continue;
			const fenced = isolated.get(slot),
				replaced = displaced.get(slot);
			if (
				(fenced && authorityIface(fenced) === iface) ||
				(replaced && authorityIface(replaced) === iface)
			)
				return {
					reason: replaced ? "authority-changed" : "withdrawal-incomplete",
				};
		}
		return undefined;
	}
	changed(iface?: string): void {
		for (const row of isolated.values()) {
			const retry = this.retries.get(row.slot);
			if (retry && (!iface || authorityIface(row) === iface)) {
				retry.wake++;
				retry.due = Math.min(
					retry.due,
					Math.max(this.now(), retry.last + 1000),
				);
			}
		}
	}
	/** Judge a fenced slot against a fresh read of its record. Only another
	 * identity is a change: the slot's own cleanup moves cursor and phase and
	 * finally removes the record. The verdict is slot-scoped and never raises
	 * the global barrier, so nothing here can strand it. */
	private confirm(
		slot: number,
		row: CellularHostAuthority | undefined,
	): boolean {
		const fenced = isolated.get(slot);
		if (!fenced) return true;
		if (!row || authorityIdentity(row) === authorityIdentity(fenced)) {
			if (displaced.delete(slot)) {
				refreshCellularSourceExclusion();
				logger.warn(
					"Quarantined cellular authority is its own again; cleanup resumes",
					{ module: "modems", slot, iface: authorityIface(fenced) },
				);
			}
			return true;
		}
		const known = displaced.get(slot);
		if (!known || authorityIdentity(known) !== authorityIdentity(row)) {
			displaced.set(slot, structuredClone(row));
			refreshCellularSourceExclusion();
			logger.error(
				"Quarantined cellular authority was replaced; the slot stays fenced, cleanup is held and new streams are refused",
				{
					module: "modems",
					slot,
					iface: authorityIface(fenced),
					replacedBy: authorityIface(row),
				},
			);
		}
		return false;
	}
	private release(slot: number): void {
		this.retained.delete(slot);
		this.retries.delete(slot);
		const fenced = isolated.delete(slot),
			replaced = displaced.delete(slot);
		if (fenced || replaced) refreshCellularSourceExclusion();
	}
	async retry(): Promise<void> {
		await Promise.all(
			[...this.retries].map(async ([slot, retry]) => {
				if (this.busy.has(slot) || retry.due > this.now()) return;
				this.busy.add(slot);
				const wake = retry.wake;
				retry.last = this.now();
				try {
					// Runtime I/O faults retain the existing scoped fence. Startup and
					// verify still report unreadable global authority through their owner.
					await this.replay(slot);
				} catch (error) {
					logger.warn(
						"Cellular recovery retry failed; path remains quarantined",
						{ module: "modems", slot, error },
					);
					this.defer(slot, retry.last);
				} finally {
					const next = this.retries.get(slot);
					if (next && retry.wake !== wake)
						next.due = Math.min(next.due, retry.last + 1000);
					this.busy.delete(slot);
				}
			}),
		);
	}
	private defer(slot: number, last = this.now()): void {
		const before = this.retries.get(slot);
		const delay = Math.min((before?.delay ?? 500) * 2, 60_000);
		this.retries.set(slot, {
			delay,
			due: this.now() + delay,
			last,
			wake: before?.wake ?? 0,
		});
	}

	async replay(onlySlot?: number): Promise<void> {
		const rows = (
			await inventoryCellularHosts(
				onlySlot === undefined
					? this.deps.store
					: scopedRecoveryStore(this.deps.store),
			)
		).filter((row) => onlySlot === undefined || row.slot === onlySlot);
		for (const [slot, owner] of this.retained) {
			if (onlySlot !== undefined && slot !== onlySlot) continue;
			if (rows.some((row) => row.slot === slot)) continue;
			this.confirm(slot, undefined);
			// Resume only the retained object's absence/directory-ack tail. Actual host
			// owners refuse this path if any kernel resource remains without authority.
			if (!(await owner.cleanup()))
				throw new Error("Retained cellular recovery lost its authority");
			this.release(slot);
		}
		if (!rows.length) return;
		const bootId = await this.deps.bootId();
		if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId))
			throw new Error("Cellular recovery boot identity unavailable");
		let incomplete = false;
		for (const row of rows) {
			try {
				// A retained owner cleans up only the authority it was retained for.
				if (!this.confirm(row.slot, row)) {
					incomplete = true;
					continue;
				}
				let owner = this.retained.get(row.slot);
				if (!owner) {
					owner = await this.deps.retain(row, bootId);
					if (owner) this.retained.set(row.slot, owner);
				}
				if (!owner || !(await owner.cleanup())) {
					incomplete = true;
					continue;
				}
				this.release(row.slot);
				if (onlySlot !== undefined) return;
			} catch (error) {
				if (onlySlot !== undefined) throw error;
				incomplete = true;
			}
		}
		const remaining = (
			await inventoryCellularHosts(
				onlySlot === undefined
					? this.deps.store
					: scopedRecoveryStore(this.deps.store),
			)
		).filter((row) => onlySlot === undefined || row.slot === onlySlot);
		if (remaining.length && this.deps.isolate) {
			for (const row of remaining) {
				if (displaced.has(row.slot)) {
					// Still fenced under the identity it was quarantined for; the
					// replacement is never adopted as that identity.
					this.defer(row.slot, this.retries.get(row.slot)?.last);
					continue;
				}
				const observed = rows.find((before) => before.slot === row.slot);
				if (
					!observed ||
					authorityIdentity(observed) !== authorityIdentity(row) ||
					!this.retained.has(row.slot) ||
					!(await this.deps.isolate(row))
				)
					throw new Error("Cellular recovery cannot establish path isolation");
				this.defer(row.slot, this.retries.get(row.slot)?.last);
				const delay = this.retries.get(row.slot)?.delay;
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
	/** Runtime fault reconciliation is read-only; it never rolls an active path
	 * back. It fails on unreadable authority only. A fenced slot is judged by the
	 * rule its retry uses, on this fresh read, and stays slot-scoped: the barrier
	 * this check lowers also holds the retries, so a verdict only a retry could
	 * revise would keep it raised until restart. */
	async verify(): Promise<void> {
		const rows = await inventoryCellularHosts(this.deps.store);
		for (const slot of isolated.keys())
			if (this.retained.has(slot))
				this.confirm(
					slot,
					rows.find((row) => row.slot === slot),
				);
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
	let startupAttempt = true;
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
			consumersReleased: async (): Promise<boolean> => {
				if (startupAttempt)
					return consumersReleased
						? consumersReleased()
						: cellularConsumersAbsent();
				if (!cleanupLease) {
					const admission = tryAcquireCellularRecovery();
					if (!admission.admitted) return false;
					cleanupLease = admission.lease;
				}
				return consumersReleased
					? consumersReleased()
					: cellularConsumersAbsentWhile(() => !!cleanupLease && deps.owned());
			},
		};
	const attempt = async (cleanup: () => Promise<boolean>) => {
		startupAttempt = isRecoveryPending();
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
	const store = scopedRecoveryStore(cellularHostStore());
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
