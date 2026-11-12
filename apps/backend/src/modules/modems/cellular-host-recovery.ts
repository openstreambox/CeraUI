import { readFile } from "node:fs/promises";
import type { PrivateStateStore } from "../../helpers/private-json-state.ts";
import { acquirePrivateStateLease } from "../../helpers/private-state-lease.ts";
import { retainCellularClatSession } from "../network/cellular-clat-session-kernel.ts";
import { cellularConsumersAbsent } from "../network/cellular-consumer-census.ts";
import {
	type CellularHostAuthority,
	inventoryCellularHosts,
} from "../network/cellular-host-inventory.ts";
import { CellularIpv6Bootstrap } from "../network/cellular-ipv6-bootstrap.ts";
import { CellularNativeHost } from "../network/cellular-native-host.ts";
import { cellularUplinkSlotKey } from "../network/cellular-native-host-plan.ts";
import { withdrawCellularSource } from "../network/cellular-source-state.ts";
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
type Retained = { readonly cleanup: () => Promise<boolean> };
export interface CellularHostRecoveryDeps {
	readonly store: PrivateStateStore;
	readonly bootId: () => Promise<string>;
	readonly retain: (
		authority: CellularHostAuthority,
		bootId: string,
	) => Promise<Retained | undefined>;
}
/** Called only by the existing startup replay owner. No new retry timer and no
 * install/advance path; interrupted effects can only be fenced and withdrawn.
 * The same kernel slot lease stays retained after every uncertain cleanup.
 */
export class CellularHostRecovery {
	private readonly retained = new Map<number, Retained>();
	constructor(private readonly deps: CellularHostRecoveryDeps) {}
	async replay(): Promise<void> {
		const rows = await inventoryCellularHosts(this.deps.store);
		for (const [slot, owner] of this.retained) {
			if (rows.some((row) => row.slot === slot)) continue;
			// Resume only the retained object's absence/directory-ack tail. Actual host
			// owners refuse this path if any kernel resource remains without authority.
			if (!(await owner.cleanup()))
				throw new Error("Retained cellular recovery lost its authority");
			this.retained.delete(slot);
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
			} catch {
				incomplete = true;
			}
		}
		if (incomplete || (await inventoryCellularHosts(this.deps.store)).length)
			throw new Error("Cellular host withdrawal incomplete");
	}
	/** Runtime fault reconciliation is read-only; it never rolls an active path back. */
	async verify(): Promise<void> {
		await inventoryCellularHosts(this.deps.store);
	}
}
async function retain(
	authority: CellularHostAuthority,
	bootId: string,
	store: PrivateStateStore,
): Promise<Retained | undefined> {
	if (!isRecoveryPending())
		throw new Error("Cellular recovery barrier unavailable");
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
			owned: isRecoveryPending,
			currentNow: () => false,
			current: async () => false,
			withdraw,
			cancelProbe: () => {
				/* Startup replay precedes managed probe admission. */
			},
			consumersReleased: cellularConsumersAbsent,
		};
	if (authority.kind === "clat")
		return retainCellularClatSession(authority.birth.plan, deps);
	const lease = await acquirePrivateStateLease(
		store,
		cellularUplinkSlotKey(authority.slot),
	);
	if (!lease) return undefined;
	let held = true;
	try {
		const guarded = { ...deps, owned: () => held && isRecoveryPending() };
		const host =
			authority.kind === "bootstrap"
				? new CellularIpv6Bootstrap(authority.inverse.plan, {
						...guarded,
						reserve: async () => false,
					})
				: new CellularNativeHost(authority.inverse.plan, guarded);
		return {
			cleanup: async () => {
				if (!(await host.cleanup())) return false;
				held = false;
				lease.release();
				return true;
			},
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
			retain: (authority, bootId) => retain(authority, bootId, store),
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
