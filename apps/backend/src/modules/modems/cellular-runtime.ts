import { randomBytes } from "node:crypto";
import {
	captureCellularSourceWithdrawal,
	releaseCellularSource,
} from "../network/cellular-source-state.ts";
import type { CellularDataGrant } from "./cellular-grant.ts";
import { CellularPathOwner } from "./cellular-path-owner.ts";
import type { CellularRuntimeSession } from "./cellular-runtime-session.ts";

export interface CellularRuntimeObservation {
	readonly owner: string;
	readonly iface: string;
	readonly linkId: string;
	readonly physicalGeneration: string;
	readonly stamp: string;
	readonly grant?: CellularDataGrant;
	readonly currentNow: () => boolean;
	readonly current: () => Promise<boolean>;
	readonly close: () => Promise<void>;
	readonly reconnect: (withdrawn: () => boolean) => Promise<boolean>;
}
export interface CellularRuntimeDeps {
	readonly now: () => number;
	readonly reservedSlots?: () => readonly number[];
	readonly capable: () => Promise<boolean>;
	readonly reserve: (
		owner: string,
		bytes: number,
	) => Promise<{ remaining: number } | undefined>;
	/** Inert wrapper only; this root retains it before install. */
	readonly retain: (
		observation: CellularRuntimeObservation,
		grant: CellularDataGrant,
		slot: number,
		sourceEpoch: string,
		hostEpoch: string,
		owned: () => boolean,
		currentNow: () => boolean,
	) => {
		readonly session: CellularRuntimeSession;
		readonly finish: (complete: boolean) => void;
	};
	readonly failure: (error: unknown) => void;
}
interface Actor {
	readonly owner: string;
	readonly iface: string;
	readonly epoch: string;
	readonly slot: number;
	readonly path: CellularPathOwner<CellularDataGrant>;
	observation: CellularRuntimeObservation | undefined;
	session: CellularRuntimeSession | undefined;
	capable: boolean;
	retained: boolean;
	invalidated: boolean;
	physicalGeneration: string;
	dataGeneration: string | undefined;
}
/** Runtime composition in the existing modem loop. Actors outlive MM indices
 * and short whole-USB absences; a replacement SIM/physical interface cannot
 * steal the old source observation or slot before its inverse completes.
 */
export class CellularRuntime {
	private readonly actors = new Map<string, Actor>();
	private busy = false;
	constructor(private readonly deps: CellularRuntimeDeps) {}
	invalidate(iface?: string): void {
		for (const actor of this.actors.values()) {
			if (iface !== undefined && actor.iface !== iface) continue;
			actor.invalidated = true;
			actor.path.withdraw();
			actor.session?.cancelProbe();
			void actor.session?.setReady(false).catch(this.deps.failure);
		}
	}
	private async retire(actor: Actor): Promise<boolean> {
		actor.path.withdraw();
		if (!(await actor.path.close())) return false;
		actor.retained = false;
		await actor.observation?.close();
		this.actors.delete(actor.owner);
		releaseCellularSource(actor.owner, actor.epoch, actor.iface);
		return true;
	}
	private make(observation: CellularRuntimeObservation): Actor | undefined {
		const slot = Array.from({ length: 32 }, (_, i) => i + 1).find(
			(slot) =>
				!this.deps.reservedSlots?.().includes(slot) &&
				![...this.actors.values()].some((actor) => actor.slot === slot),
		);
		if (!slot) return undefined;
		const epoch = randomBytes(32).toString("hex");
		let actor: Actor;
		const path = new CellularPathOwner<CellularDataGrant>(
			observation.owner,
			epoch,
			observation.iface,
			{
				now: this.deps.now,
				reserve: (bytes) => this.deps.reserve(actor.owner, bytes),
				capable: async () => actor.capable,
				install: async (grant) => {
					const captured = actor.observation;
					if (
						!captured ||
						!actor.retained ||
						!actor.capable ||
						!captured.currentNow()
					)
						return undefined;
					const retained = this.deps.retain(
						captured,
						grant,
						slot,
						actor.epoch,
						randomBytes(32).toString("hex"),
						() => actor.retained,
						() =>
							actor.retained &&
							!actor.invalidated &&
							actor.capable &&
							actor.observation === captured &&
							captured.currentNow(),
					);
					const session = retained.session;
					actor.session = session;
					let installed = false;
					try {
						await session.install();
						installed = true;
					} catch (error) {
						this.deps.failure(error);
					} finally {
						retained.finish(installed);
					}
					return {
						binding: session.binding,
						dns: session.dns,
						valid: () =>
							actor.capable && actor.observation === captured
								? session.valid()
								: Promise.resolve(false),
						prepareProbe: () => session.prepareProbe(),
						setReady: (ready) => session.setReady(ready),
						cancelProbe: session.cancelProbe,
						cleanup: async () => {
							let complete = false;
							try {
								if (!(await session.cleanup())) return false;
								complete = true;
								if (actor.session === session) actor.session = undefined;
								return true;
							} finally {
								retained.finish(complete);
							}
						},
					};
				},
				probe: async () => actor.session?.probe() ?? "unavailable",
				reconnect: async () => {
					const row = actor.observation;
					if (!row || actor.session || !actor.retained) return false;
					const withdrawn = captureCellularSourceWithdrawal(
						actor.owner,
						actor.epoch,
						actor.iface,
					);
					return row.reconnect(
						() =>
							actor.retained &&
							actor.observation === row &&
							!actor.session &&
							withdrawn(),
					);
				},
				passiveHealthy: () => false,
			},
		);
		actor = {
			owner: observation.owner,
			iface: observation.iface,
			epoch,
			slot,
			path,
			observation,
			session: undefined,
			capable: false,
			retained: true,
			invalidated: false,
			physicalGeneration: observation.physicalGeneration,
			dataGeneration: undefined,
		};
		this.actors.set(actor.owner, actor);
		return actor;
	}
	async reconcile(
		observations: readonly CellularRuntimeObservation[],
	): Promise<void> {
		if (this.busy) {
			for (const row of observations)
				await row.close().catch(this.deps.failure);
			return;
		}
		this.busy = true;
		const accepted = new Set<CellularRuntimeObservation>();
		try {
			const owners = new Set<string>(),
				ifaces = new Set<string>();
			if (
				observations.some((row) => {
					if (owners.has(row.owner) || ifaces.has(row.iface)) return true;
					owners.add(row.owner);
					ifaces.add(row.iface);
					return false;
				})
			) {
				this.invalidate();
				throw new Error("Ambiguous cellular runtime inventory");
			}
			const capable = await this.deps.capable();
			for (const row of observations) {
				for (const previous of this.actors.values()) {
					if (
						(previous.owner === row.owner && previous.iface !== row.iface) ||
						(previous.iface === row.iface && previous.owner !== row.owner)
					)
						if (!(await this.retire(previous))) break;
				}
				if (
					[...this.actors.values()].some(
						(actor) =>
							(actor.iface === row.iface && actor.owner !== row.owner) ||
							(actor.owner === row.owner && actor.iface !== row.iface),
					)
				)
					continue;
				const actor = this.actors.get(row.owner) ?? this.make(row);
				if (!actor) continue;
				actor.capable = capable;
				const old = actor.observation;
				if (
					old !== row &&
					(old?.stamp !== row.stamp || !old.currentNow() || actor.invalidated)
				) {
					actor.path.withdraw();
					actor.observation = row;
					actor.invalidated = false;
					await old?.close();
				} else if (old === row) actor.observation = row;
				const selected = actor.observation;
				if (!selected) continue;
				accepted.add(selected);
				if (actor.physicalGeneration !== selected.physicalGeneration) {
					actor.physicalGeneration = selected.physicalGeneration;
					actor.dataGeneration = undefined;
				}
				if (selected.grant) actor.dataGeneration = selected.grant.generation;
				await actor.path.observe({
					generation: actor.dataGeneration ?? selected.physicalGeneration,
					...(selected.grant && capable && selected.currentNow()
						? { grant: selected.grant }
						: {}),
				});
			}
			for (const actor of this.actors.values()) {
				if (accepted.has(actor.observation as CellularRuntimeObservation))
					continue;
				actor.capable = false;
				const old = actor.observation;
				actor.observation = undefined;
				await old?.close();
				await actor.path.observe({});
			}
		} catch (error) {
			this.invalidate();
			throw error;
		} finally {
			for (const row of observations)
				if (
					![...this.actors.values()].some((actor) => actor.observation === row)
				)
					await row.close().catch(this.deps.failure);
			this.busy = false;
		}
	}
	/** Shutdown/replacement only. Incomplete actors remain retained for retry. */
	async close(): Promise<boolean> {
		this.invalidate();
		if (this.busy) return false;
		let complete = true;
		for (const actor of this.actors.values())
			if (!(await this.retire(actor))) complete = false;
		return complete;
	}
}
