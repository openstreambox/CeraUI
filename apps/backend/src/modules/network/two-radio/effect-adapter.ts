import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "../../wifi/wifi-adapter-lock.ts";
import { type Effect, type Epoch, type Radio, sameEpoch } from "./reducer.ts";

export type Identity = Readonly<{
	physical: string;
	permanentMac: string;
	epoch: Epoch;
}>;
export type Holder = Readonly<{ radio: Radio; identity: Identity }>;
export type Ack = {
	type: "ack";
	operation: number;
	command: number;
	ok: boolean;
};
export type Intent = {
	effect: Effect;
	identity: Identity;
};
export type OperationRecord = {
	operation: number;
	scope: string;
	holder: Holder;
	closed: boolean;
	clean: boolean;
	commands: Intent[];
	acknowledgements: Ack[];
};
export type Snapshot = {
	version: 1;
	session: string;
	holder?: Holder | undefined;
	operations: OperationRecord[];
};
export interface Journal {
	load(): Promise<Snapshot | null>;
	/** Atomic replace, fsync file and parent directory before resolving. */
	save(snapshot: Snapshot): Promise<void>;
}
/** Supplied by the existing network owner; no timer, gateway or owner is installed here.
 * All methods must honor signal and a finite IO budget. apply/restore/remove are
 * single fenced effects, never detached tasks. drain includes NM/server work,
 * surviving children and queued callbacks, including those from a previous boot.
 */
export interface NetworkOwner {
	run<T>(work: () => Promise<T>): Promise<T>;
	identity(radio: Radio, signal: AbortSignal): Promise<Identity | null>;
	readback?(holder: Holder, signal: AbortSignal): Promise<boolean>;
	apply(intent: Intent, scope: string, signal: AbortSignal): Promise<boolean>;
	cancelAndDrain(
		record: OperationRecord,
		signal: AbortSignal,
	): Promise<boolean>;
	restore(holder: Holder, signal: AbortSignal): Promise<boolean>;
	/** Enumerate and remove only resources carrying this exact durable scope.
	 * Must not remove adopted/foreign resources; return false if ownership is unknown. */
	removeOwned(scope: string, signal: AbortSignal): Promise<boolean>;
}
const sameIdentity = (a: Identity | null, b: Identity): boolean =>
	a !== null &&
	a.physical === b.physical &&
	wifiAdapterLockKey(a.permanentMac) === wifiAdapterLockKey(b.permanentMac) &&
	sameEpoch(a.epoch, b.epoch);

export class EffectAdapter {
	private snapshot: Snapshot | undefined;
	private ready = false;
	private revision = 0;
	private unsettled = new Set<Promise<unknown>>();
	private pending = new Map<number, Set<AbortController>>();
	private closed = new Set<number>();
	constructor(
		private readonly owner: NetworkOwner,
		private readonly journal: Journal,
		private readonly session: string,
		private readonly ioMs = 5_000,
	) {
		if (
			!/^[a-zA-Z0-9_-]{1,80}$/.test(session) ||
			!Number.isFinite(ioMs) ||
			ioMs <= 0
		)
			throw new Error("Invalid adapter configuration");
	}
	private async bounded<T>(
		work: (signal: AbortSignal) => Promise<T>,
		operation?: number,
	): Promise<T> {
		const controller = new AbortController();
		const set =
			operation === undefined
				? undefined
				: (this.pending.get(operation) ?? new Set<AbortController>());
		if (operation !== undefined && set) this.pending.set(operation, set);
		set?.add(controller);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const task = work(controller.signal);
			this.unsettled.add(task);
			void task.then(
				() => this.unsettled.delete(task),
				() => this.unsettled.delete(task),
			);
			return await Promise.race([
				task,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						controller.abort();
						reject(new Error("IO deadline; reconciliation required"));
					}, this.ioMs);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
			set?.delete(controller);
		}
	}
	private async deadline<T>(task: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				task,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						this.ready = false;
						this.revision++;
						for (const set of this.pending.values())
							for (const c of set) c.abort();
						reject(new Error("Owner deadline"));
					}, this.ioMs * 8);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	designatedHolder(): Holder | null {
		return this.snapshot?.holder ? structuredClone(this.snapshot.holder) : null;
	}

	private save() {
		return this.bounded(() =>
			this.journal.save(structuredClone(this.snapshot as Snapshot)),
		);
	}
	/** Call before admitting reducer effects. Restart NEVER replays a mutation.
	 * Unknown drain/identity/restore leaves admission closed and durable intent intact. */
	async reconcile(): Promise<boolean> {
		const revision = ++this.revision;
		this.ready = false;
		try {
			return await this.deadline(
				this.owner.run(async () => {
					this.snapshot = (await this.bounded(() => this.journal.load())) ?? {
						version: 1,
						session: this.session,
						operations: [],
					};
					if (this.snapshot.version !== 1)
						throw new Error("Unknown journal version");
					for (const record of this.snapshot.operations) {
						if (record.clean) continue;
						record.closed = true;
						this.closed.add(record.operation);
						await this.save();
						if (!(await this.cleanup(record))) return false;
						record.clean = true;
						this.snapshot.holder = structuredClone(record.holder);
						await this.save();
					}
					// Older snapshots carry the designation only on the last operation.
					const lastHolder = this.snapshot.operations.at(-1)?.holder;
					if (!this.snapshot.holder && lastHolder)
						this.snapshot.holder = structuredClone(lastHolder);
					// Operation numbers may restart only with a new session after reconciliation.
					if (this.snapshot.session !== this.session) {
						this.snapshot = {
							version: 1,
							session: this.session,
							...(this.snapshot.holder ? { holder: this.snapshot.holder } : {}),
							operations: [],
						};
						this.closed.clear();
					}
					await this.save();
					if (revision !== this.revision) return false;
					this.ready = true;
					return true;
				}),
			);
		} catch {
			return false;
		}
	}
	private async locked<T>(
		expected: Holder,
		work: () => Promise<T>,
	): Promise<T> {
		const result = await withWifiAdapterLock(
			wifiAdapterLockKey(expected.identity.permanentMac),
			async () => {
				const identity = await this.bounded((signal) =>
					this.owner.identity(expected.radio, signal),
				);
				if (!sameIdentity(identity, expected.identity))
					throw new Error("Identity unknown or replaced");
				try {
					return await work();
				} finally {
					await Promise.allSettled([...this.unsettled]);
				}
			},
		);
		if (!result.success) throw new Error(result.error);
		return result.result;
	}
	private async cleanup(record: OperationRecord): Promise<boolean> {
		// Drain precedes all restoration/deletion. A killed nmcli alone is insufficient.
		if (
			!(await this.bounded((signal) =>
				this.owner.cancelAndDrain(structuredClone(record), signal),
			))
		)
			return false;
		return this.locked(record.holder, async () => {
			if (
				!(await this.bounded((signal) =>
					this.owner.restore(record.holder, signal),
				))
			)
				return false;
			// Revalidate after restoration before deletion and before a successful ACK.
			if (
				!sameIdentity(
					await this.bounded((signal) =>
						this.owner.identity(record.holder.radio, signal),
					),
					record.holder.identity,
				)
			)
				return false;
			if (
				!(await this.bounded((signal) =>
					this.owner.removeOwned(record.scope, signal),
				))
			)
				return false;
			return sameIdentity(
				await this.bounded((signal) =>
					this.owner.identity(record.holder.radio, signal),
				),
				record.holder.identity,
			);
		});
	}
	/** holder is the reducer's designated holder at dispatch, not a guessed NM default.
	 * Return null means no acknowledgement: keep token and explicitly reconcile.
	 * Feed returned ACK through reduce only after this call releases the owner. */
	async execute(effect: Effect, holder: Holder): Promise<Ack | null> {
		if (!this.ready || !this.snapshot) return null;
		const cleanup = effect.action === "cancel-drain-restore";
		if (cleanup) {
			// Close admission synchronously, before waiting for the owner or the lock.
			this.closed.add(effect.operation);
			for (const controller of this.pending.get(effect.operation) ?? [])
				controller.abort();
		} else if (this.closed.has(effect.operation)) return null;
		try {
			return await this.deadline(
				this.owner.run(async () => {
					const snapshot = this.snapshot;
					if (!snapshot || (!cleanup && this.closed.has(effect.operation)))
						return null;
					let record = snapshot.operations.find(
						(row) => row.operation === effect.operation,
					);
					const previous = record?.acknowledgements.find(
						(ack) => ack.command === effect.command,
					);
					if (previous) return structuredClone(previous);
					if (
						record?.commands.some(
							(row) => row.effect.command === effect.command,
						)
					)
						return null;
					if (snapshot.operations.length >= 1024 && !record) return null;
					if (!record) {
						record = {
							operation: effect.operation,
							scope: `two-radio-${snapshot.session}-${effect.operation}`,
							holder: structuredClone(holder),
							closed: false,
							clean: false,
							commands: [],
							acknowledgements: [],
						};
						snapshot.operations.push(record);
					}
					record.holder = structuredClone(holder);
					snapshot.holder = structuredClone(holder);
					if (cleanup) {
						record.closed = true;
						record.clean = false;
						if (
							!effect.restore?.epoch ||
							effect.restore.radio !== holder.radio ||
							!sameEpoch(effect.restore.epoch, holder.identity.epoch)
						)
							return null;
						await this.save();
						if (!(await this.cleanup(record))) return null;
						record.clean = true;
					} else {
						const identity = await this.bounded((signal) =>
							this.owner.identity(effect.radio, signal),
						);
						if (!identity || !sameEpoch(identity.epoch, effect.epoch))
							return null;
						if (record.commands.length >= 1024) return null;
						const intent = {
							effect: structuredClone(effect),
							identity: structuredClone(identity),
						};
						record.commands.push(intent);
						record.clean = false;
						// Durable intent BEFORE side effects, then exact identity fence AFTER IO.
						await this.save();
						const ok = await this.locked(
							{ radio: effect.radio, identity },
							() => {
								if (this.closed.has(effect.operation))
									throw new Error("Admission closed");
								return this.bounded(
									(signal) => this.owner.apply(intent, record.scope, signal),
									effect.operation,
								);
							},
						);
						if (
							this.closed.has(effect.operation) ||
							!sameIdentity(
								await this.bounded((signal) =>
									this.owner.identity(effect.radio, signal),
								),
								identity,
							)
						)
							return null;
						if (!ok) return null;
					}
					if (!this.ready) return null;
					const ack: Ack = {
						type: "ack",
						operation: effect.operation,
						command: effect.command,
						ok: true,
					};
					record.acknowledgements.push(ack);
					await this.save();
					return ack;
				}),
			);
		} catch {
			return null;
		}
	}
}
