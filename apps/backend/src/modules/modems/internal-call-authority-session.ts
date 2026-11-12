import type { DurableInverseRecord } from "../../helpers/durable-inverse.ts";
import type { CellularHandoffPlan } from "../network/cellular-host-handoff.ts";
import {
	accessInternalCallAuthority,
	type InternalCallAuthority,
	parseInternalCallAuthority,
} from "./internal-call-authority.ts";
import type { InternalCallRetirement } from "./internal-call-withdrawal.ts";

export interface InternalCallAuthoritySessionDeps {
	/** The one retained unit owner holds its physical state lease. */
	readonly owned: () => boolean;
	readonly withdrawn: () => boolean;
	readonly release: () => void;
	readonly access?: typeof accessInternalCallAuthority;
}
/** State adapter shared by the live owner and startup inverse. It never starts
 * a call, acquires a second mutation lock or runs its own reconciliation loop.
 */
export class InternalCallAuthoritySession {
	private readonly initial: InternalCallAuthority;
	private current: InternalCallAuthority;
	private known = false;
	private removing = false;
	private retired = false;
	private readonly access: typeof accessInternalCallAuthority;
	readonly retirement: InternalCallRetirement;
	constructor(
		raw: InternalCallAuthority,
		private readonly deps: InternalCallAuthoritySessionDeps,
	) {
		this.initial = parseInternalCallAuthority(raw, raw.key);
		this.current = this.initial;
		this.access = deps.access ?? accessInternalCallAuthority;
		this.retirement = {
			owned: () => !this.retired && deps.owned(),
			withdrawn: deps.withdrawn,
			contextReleased: () => this.current.contextReleased,
			begin: () => this.begin(),
			markContextReleased: () =>
				this.update((value) => ({ ...value, contextReleased: true })),
			finish: () => this.finish(),
		};
	}
	private scope(value: InternalCallAuthority): void {
		if (
			!this.retirement.owned() ||
			value.key !== this.initial.key ||
			value.owner !== this.initial.owner ||
			value.epoch !== this.initial.epoch ||
			value.bootId !== this.initial.bootId ||
			value.cid !== this.initial.cid ||
			value.subscription !== this.initial.subscription ||
			value.stableKey !== this.initial.stableKey ||
			(this.current.contextExpected && !value.contextExpected) ||
			(this.current.contextReleased && !value.contextReleased) ||
			(this.current.phase === "withdrawing" && value.phase !== "withdrawing") ||
			JSON.stringify(value.physical) !==
				JSON.stringify(this.initial.physical) ||
			JSON.stringify(value.identity) !== JSON.stringify(this.initial.identity)
		)
			throw new Error("Internal owner authority was replaced");
	}
	/** A new owner may create only an inert birth, never overwrite an inverse. */
	async create(): Promise<boolean> {
		if (
			this.known ||
			!this.retirement.owned() ||
			this.initial.phase !== "holding" ||
			this.initial.handoff !== null ||
			this.initial.contextReleased
		)
			return false;
		return this.access(this.initial.unit, async (value, write) => {
			if (value || !this.retirement.owned()) return false;
			await write(this.initial);
			this.known = true;
			this.current = this.initial;
			return this.retirement.owned();
		});
	}
	/** Recovery loads an exact existing owner and never manufactures absence. */
	async load(): Promise<void> {
		await this.access(this.initial.unit, async (value) => {
			if (!value)
				throw new Error("Retained internal owner authority is missing");
			this.scope(value);
			this.current = parseInternalCallAuthority(value, value.key);
			this.known = true;
		});
	}
	baselineExpected(): boolean {
		return this.current.contextExpected;
	}
	holding(): boolean {
		return (
			this.known &&
			this.retirement.owned() &&
			!this.removing &&
			this.current.phase === "holding"
		);
	}
	contextExpected(): Promise<void> {
		return this.update((value) => ({ ...value, contextExpected: true }));
	}
	writeHandoff(
		handoff: DurableInverseRecord<CellularHandoffPlan> | undefined,
	): Promise<void> {
		const captured = handoff ? structuredClone(handoff) : null;
		return this.update((value) => {
			if (
				(value.handoff &&
					captured &&
					JSON.stringify(value.handoff.plan) !==
						JSON.stringify(captured.plan)) ||
				(!value.handoff && captured && value.phase === "withdrawing") ||
				(value.handoff &&
					!captured &&
					(value.handoff.phase !== "withdrawing" || value.handoff.cursor !== 0))
			)
				throw new Error(
					"Internal host inverse cannot be replaced or forgotten",
				);
			return { ...value, handoff: captured };
		});
	}
	async readHandoff(): Promise<
		DurableInverseRecord<CellularHandoffPlan> | undefined
	> {
		await this.load();
		return this.current.handoff
			? structuredClone(this.current.handoff)
			: undefined;
	}
	private async update(
		change: (value: InternalCallAuthority) => InternalCallAuthority,
	): Promise<void> {
		if (!this.known || this.removing)
			throw new Error("Internal owner is not writable");
		await this.access(this.initial.unit, async (value, write) => {
			if (!value)
				throw new Error("Retained internal owner authority is missing");
			this.scope(value);
			const next = parseInternalCallAuthority(change(value), value.key);
			this.scope(next);
			await write(next);
			this.current = next;
			if (!this.retirement.owned())
				throw new Error("Internal owner lost authority after commit");
		});
	}
	private async begin(): Promise<"withdrawing" | "retiring" | false> {
		if (!this.retirement.owned()) return false;
		if (this.removing) {
			await this.access(this.initial.unit, async (value) => {
				if (value) this.scope(value);
			});
			return "retiring";
		}
		await this.update((value) => ({ ...value, phase: "withdrawing" }));
		return "withdrawing";
	}
	private async finish(): Promise<boolean> {
		if (
			!this.retirement.owned() ||
			!this.deps.withdrawn() ||
			this.current.phase !== "withdrawing" ||
			!this.current.contextReleased ||
			this.current.handoff !== null
		)
			return false;
		await this.access(this.initial.unit, async (value, write) => {
			if (value) {
				this.scope(value);
				if (
					value.phase !== "withdrawing" ||
					!value.contextReleased ||
					value.handoff !== null
				)
					throw new Error("Internal inverse is not complete");
			} else if (!this.removing)
				throw new Error("Retained internal owner authority is missing");
			if (!this.retirement.owned() || !this.deps.withdrawn())
				throw new Error("Internal withdrawal proof was lost");
			this.removing = true;
			await write(undefined);
			if (!this.retirement.owned() || !this.deps.withdrawn())
				throw new Error("Internal withdrawal proof was lost after removal");
			this.deps.release();
			this.retired = true;
		});
		return true;
	}
}
