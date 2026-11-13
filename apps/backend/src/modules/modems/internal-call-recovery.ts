import type { PrivateStateStore } from "../../helpers/private-json-state.ts";
import { acquirePrivateStateLease } from "../../helpers/private-state-lease.ts";
import { cellularConsumersAbsent } from "../network/cellular-consumer-census.ts";
import {
	type CellularHandoffIO,
	CellularHostHandoff,
	cellularHandoffIO,
} from "../network/cellular-host-handoff.ts";
import { cellularPhysicalResourceState } from "../network/cellular-host-identity.ts";
import { inventoryCellularHosts } from "../network/cellular-host-inventory.ts";
import {
	acquireCellularNmControl,
	type CellularNmControl,
} from "../network/cellular-nm-control.ts";
import { withdrawCellularSource } from "../network/cellular-source-state.ts";
import { isRecoveryPending } from "../streaming/recovery-barrier.ts";
import { cellularHostStore } from "./cellular-host-recovery.ts";
import {
	accessInternalCallAuthority,
	type InternalCallAuthority,
	internalCallAuthorityKey,
	listInternalCallAuthorities,
} from "./internal-call-authority.ts";
import { InternalCallAuthoritySession } from "./internal-call-authority-session.ts";
import {
	internalCallSubscriptionKey,
	internalCallUnitKey,
} from "./internal-call-unit.ts";
import { withdrawInternalCall } from "./internal-call-withdrawal.ts";
import { accessInternalContextAuthority } from "./internal-context-authority.ts";
import {
	defaultInternalContextAccess,
	type InternalContextEffectsDeps,
	parkChangedInternalContextEffects,
	restoreInternalContextEffects,
} from "./internal-context-effects.ts";
import {
	acquireCellularControl,
	type CellularControl,
	type CellularControlTarget,
	findCellularControlUnit,
} from "./modems.ts";
import {
	commitMutationEntry,
	journalNow,
	nextEntry,
	readMutationEntry,
} from "./mutation-journal.ts";
import { withHeldJournalKey } from "./mutation-journal-retirement.ts";
import {
	assertMutationJournalRevision,
	mutationJournalRevision,
	noteMutationJournalReadFault,
} from "./mutation-journal-revision.ts";
import { replayActionFor } from "./mutation-journal-state.ts";
import { registerModemConfigInverse } from "./mutation-rollback.ts";

type Retained = { readonly cleanup: () => Promise<boolean> };
export interface InternalCallRecoveryDeps {
	readonly list: () => Promise<readonly InternalCallAuthority[]>;
	readonly retain: (
		authority: InternalCallAuthority,
	) => Promise<Retained | undefined>;
}
/** Invoked by the existing startup replay owner only. Failed/uncertain inverses
 * retain the same physical lease; runtime verification performs no rollback.
 */
export class InternalCallRecovery {
	private readonly retained = new Map<string, Retained>();
	constructor(private readonly deps: InternalCallRecoveryDeps) {}
	async replay(): Promise<void> {
		const rows = await this.deps.list();
		for (const [key, owner] of this.retained) {
			if (rows.some((row) => row.key === key)) continue;
			if (!(await owner.cleanup()))
				throw new Error("Retained internal retirement incomplete");
			this.retained.delete(key);
		}
		let incomplete = false;
		for (const row of rows) {
			try {
				let owner = this.retained.get(row.key);
				if (!owner) {
					owner = await this.deps.retain(row);
					if (owner) this.retained.set(row.key, owner);
				}
				if (!owner || !(await owner.cleanup())) {
					incomplete = true;
					continue;
				}
				this.retained.delete(row.key);
			} catch {
				incomplete = true;
			}
		}
		if (incomplete || (await this.deps.list()).length)
			throw new Error("Internal call withdrawal incomplete");
	}
	async verify(): Promise<void> {
		await this.deps.list();
	}
}
export function internalCallLeaseStore(): PrivateStateStore {
	return {
		dir: `${process.env.CERALIVE_CELLULAR_INTERNAL_OWNER_STATE_DIR ?? "/data/ceralive/cellular-internal-owner"}-leases`,
	};
}
export interface InternalCallRecoveryHostDeps {
	readonly bootId: () => Promise<string>;
	readonly physical: typeof cellularPhysicalResourceState;
	readonly consumers: typeof cellularConsumersAbsent;
	readonly hosts: typeof inventoryCellularHosts;
	readonly lookup: typeof findCellularControlUnit;
	readonly control: typeof acquireCellularControl;
	readonly nm: typeof acquireCellularNmControl;
	readonly io: typeof cellularHandoffIO;
}
const hostDefaults: InternalCallRecoveryHostDeps = {
	bootId: async () =>
		(await Bun.file("/proc/sys/kernel/random/boot_id").text()).trim(),
	physical: cellularPhysicalResourceState,
	consumers: cellularConsumersAbsent,
	hosts: inventoryCellularHosts,
	lookup: findCellularControlUnit,
	control: acquireCellularControl,
	nm: acquireCellularNmControl,
	io: cellularHandoffIO,
};
export async function retainInternalCallInverse(
	authority: InternalCallAuthority,
	adapters: InternalCallRecoveryHostDeps = hostDefaults,
): Promise<Retained | undefined> {
	if (!isRecoveryPending())
		throw new Error("Internal recovery barrier unavailable");
	const lease = await acquirePrivateStateLease(
		internalCallLeaseStore(),
		internalCallAuthorityKey(authority.unit),
	);
	if (!lease) return undefined;
	try {
		const fresh = await accessInternalCallAuthority(
			authority.unit,
			async (value) => value,
		);
		if (
			!fresh ||
			fresh.owner !== authority.owner ||
			fresh.epoch !== authority.epoch
		) {
			lease.release();
			return undefined;
		}
		authority = fresh;
	} catch (error) {
		lease.release();
		throw error;
	}
	let held = true,
		loaded = false,
		complete = false,
		released = false,
		control: CellularControl | undefined,
		target: CellularControlTarget | undefined,
		nm: CellularNmControl | undefined,
		host: CellularHostHandoff | undefined,
		io: CellularHandoffIO | undefined;
	const owned = () => held && isRecoveryPending();
	const session = new InternalCallAuthoritySession(authority, {
		owned,
		withdrawn: () => released && owned(),
		release: () => {
			held = false;
			lease.release();
		},
	});
	let bootId: string | undefined;
	const currentBoot = async () => {
		bootId ??= await adapters.bootId();
		if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId))
			throw new Error("Internal recovery boot unavailable");
		return bootId;
	};
	const physical = async () =>
		adapters.physical(
			authority.physical,
			authority.bootId === (await currentBoot()),
		);
	const handoff = async () => {
		if (host && io && (io.nm?.valid() || (await physical()) !== "present"))
			return { host, io };
		if (nm) {
			await nm.close();
			nm = undefined;
		}
		if ((await physical()) === "present") {
			try {
				nm = await adapters.nm(authority.physical, undefined);
			} catch {
				/* Independent read-only restoration still must prove absence. */
			}
		}
		io = adapters.io(authority.physical, nm, await currentBoot());
		host = new CellularHostHandoff(
			authority.owner,
			authority.epoch,
			authority.physical,
			io,
			{
				bootId: await currentBoot(),
				read: () => session.readHandoff(),
				write: (value) => session.writeHandoff(value),
				current: async () => false,
				withdraw: () =>
					withdrawCellularSource(
						authority.owner,
						authority.epoch,
						authority.physical.ifname,
					),
				fence: async () => {
					if (!released || !owned())
						throw new Error("Internal recovery withdrawal proof lost");
				},
				consumersReleased: async () => released && owned(),
			},
		);
		return { host, io };
	};
	const guarded = async () => {
		const selected = await handoff(),
			device = selected.io.nm?.devices[0];
		if (
			!owned() ||
			!released ||
			!device ||
			!selected.io.nm?.valid() ||
			!(await selected.io.present()) ||
			(await selected.io.readRaDefault()) !== "0" ||
			!authority.handoff ||
			device.udi !== authority.handoff.plan.device.udi
		)
			return false;
		const current = await selected.io.nm.read(device);
		return current?.managed === false && owned() && released;
	};
	const acquire = async () => {
		if (control && (await control.valid())) return control;
		if (control) {
			await control.close();
			control = undefined;
		}
		target = await adapters.lookup(authority);
		if (
			!target ||
			JSON.stringify(target.identity) !== JSON.stringify(authority.identity) ||
			!(await guarded())
		)
			return undefined;
		control = await adapters.control(target);
		return control;
	};
	return {
		cleanup: async () => {
			if (complete) return true;
			if (!owned()) return false;
			return withHeldJournalKey(authority.stableKey, async () => {
				const entry = await readEntry(authority.stableKey);
				if (entry && replayActionFor(entry.state) === "remain-blocked")
					return false;
				if (!loaded) {
					await session.load();
					loaded = true;
				}
				complete = await withdrawInternalCall({
					retirement: {
						...session.retirement,
						finish: async () => {
							// Complete only the matching attempt while the existing key is held. Its
							// durable acknowledgement precedes deletion of the whole-owner authority.
							const current = await readEntry(authority.stableKey);
							if (!owned() || !released) return false;
							if (current && ownContextEntry(current, authority)) {
								if (
									current.attemptId !== entry?.attemptId ||
									!["armed", "executing", "completed"].includes(current.state)
								)
									return false;
								await commitMutationEntry(
									current.state === "completed"
										? current
										: nextEntry(
												current,
												"completed",
												journalNow(),
												"retained internal inverse completed",
											),
								);
							} else if (entry && ownContextEntry(entry, authority))
								return false;
							return session.retirement.finish();
						},
					},
					withdraw: () =>
						withdrawCellularSource(
							authority.owner,
							authority.epoch,
							authority.physical.ifname,
						),
					clearGrant: async () => {
						released = false;
						if (
							!owned() ||
							(await adapters.hosts(cellularHostStore())).length ||
							!(await adapters.consumers())
						)
							return false;
						released = owned();
						return released;
					},
					context: async () => {
						const record = await accessInternalContextAuthority(
							authority.unit,
							authority.cid,
							async (value) => value,
						);
						if (!record) {
							if (session.baselineExpected())
								throw new Error(
									"Expected internal context authority is missing",
								);
							return true;
						}
						await session.contextExpected();
						// No host handoff means this inert birth never submitted a call.
						if (!(await session.readHandoff())) return true;
						if ((await physical()) === "absent") return true;
						const selected = await acquire();
						if (!selected || !target) return false;
						const request = {
							unit: record.unit,
							subscription: record.subscription,
							cid: record.cid,
							desired: record.desired,
						};
						const deps: InternalContextEffectsDeps = {
							owned,
							withdrawn: () => released && owned(),
							baselineAllowed: () => false,
							current: async () => false,
							prepareCall: async () => {
								throw new Error("Recovery cannot prepare a new call");
							},
							access: defaultInternalContextAccess(request),
							identity: async () => {
								if (!target || !(await guarded())) return undefined;
								const unit = internalCallUnitKey(target.equipment),
									subscriber = await selected.readSubscriber(),
									subscription = subscriber
										? internalCallSubscriptionKey(subscriber)
										: undefined;
								return unit === authority.unit &&
									subscription &&
									(await guarded())
									? { unit, subscription, stableKey: authority.stableKey }
									: undefined;
							},
						};
						const identity = await deps.identity();
						if (!identity) return false;
						if (identity.subscription !== record.subscription)
							return parkChangedInternalContextEffects(request, selected, deps);
						// The existing startup owner holds the journal key and durably
						// latched whole-owner inverse; context effects keep their cursors.
						const result = await restoreInternalContextEffects(
							request,
							selected,
							{
								markExecuting: async () => {
									// Whole-owner withdrawal is already durably latched under the journal key.
								},
							},
							deps,
						);
						return result.confirmed && result.value;
					},
					host: async () => (await handoff()).host.cleanup(),
					control: async () => {
						await control?.close();
						control = undefined;
						await nm?.close();
						nm = undefined;
					},
				});
				return complete;
			});
		},
	};
}
async function readEntry(key: string) {
	const revision = mutationJournalRevision();
	const entry = await readMutationEntry(key);
	assertMutationJournalRevision(revision);
	return entry;
}
function ownContextEntry(
	entry: NonNullable<Awaited<ReturnType<typeof readMutationEntry>>>,
	authority: InternalCallAuthority,
): boolean {
	const pre = entry.preState;
	return (
		entry.kind === "modem-config" &&
		pre.format === "cellular-internal-context-v1" &&
		pre.unit === authority.unit &&
		pre.subscription === authority.subscription &&
		pre.cid === authority.cid &&
		pre.contextKey === authority.contextKey
	);
}
// An unfinished orphan cannot infer completion from a missing whole-owner file.
// The startup unit inverse settles matching attempts before ordinary replay.
registerModemConfigInverse("cellular-internal-context-v1", {
	rollback: async () => "failed",
});
const recoveries = new Map<string, InternalCallRecovery>();
function recovery(): InternalCallRecovery {
	const key = internalCallLeaseStore().dir;
	let owner = recoveries.get(key);
	if (!owner) {
		owner = new InternalCallRecovery({
			list: listInternalCallAuthorities,
			retain: retainInternalCallInverse,
		});
		recoveries.set(key, owner);
	}
	return owner;
}
export async function replayInternalCalls(): Promise<void> {
	try {
		await recovery().replay();
	} catch (error) {
		noteMutationJournalReadFault();
		throw error;
	}
}
