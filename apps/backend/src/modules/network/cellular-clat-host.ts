import {
	DurableInverse,
	privateInverseStore,
} from "../../helpers/durable-inverse.ts";
import type { CellularPathSession } from "../modems/cellular-path-owner.ts";
import {
	type CellularClatHostPlan,
	cellularClatHostSteps,
	parseCellularClatHostPlan,
} from "./cellular-clat-host-plan.ts";
import type { CellularFirewall } from "./cellular-firewall.ts";
import { cellularUplinkSlotKey } from "./cellular-native-host-plan.ts";
import {
	type CellularRoutePlan,
	planCellularRoutes,
} from "./cellular-route-plan.ts";

export interface CellularClatHostEffects {
	readonly output: Pick<CellularFirewall, "inspect" | "transition">;
	readonly inspect: (
		step: string,
		inverse: boolean,
	) => Promise<"absent" | "owned" | "foreign">;
	readonly apply: (step: string) => Promise<void>;
	readonly remove: (step: string) => Promise<void>;
	/** Full current kernel, receipt, translator and configuration readback. */
	readonly valid: () => Promise<boolean>;
	/** Deny both owned planes; do not create a missing table during recovery. */
	readonly deny: () => Promise<void>;
}
export interface CellularClatHostDeps {
	readonly store: { readonly dir: string };
	readonly owned: () => boolean;
	/** Captured observation revision; cleanup retains its separate lease. */
	readonly currentNow: () => boolean;
	readonly current: () => Promise<boolean>;
	readonly withdraw: () => void;
	readonly consumersReleased: () => Promise<boolean>;
	readonly cancelProbe: () => void;
	readonly effects: (
		authority: CellularClatHostPlan,
		routes: CellularRoutePlan,
		guard: {
			readonly current: () => Promise<boolean>;
			readonly writable: () => boolean;
		},
	) => CellularClatHostEffects;
}
/** Ordered immutable inverse, including the transit fence's active transition.
 * The outer retained owner records TUN birth and holds its slot lease until
 * this child and the TUN inverse complete. No reconnect or hardware replay is
 * owned here; installation never resumes an existing interrupted cursor.
 */
export class CellularClatHost implements CellularPathSession {
	readonly authority: CellularClatHostPlan;
	readonly binding;
	readonly dns;
	readonly cancelProbe;
	readonly steps: readonly string[];
	private readonly effects: CellularClatHostEffects;
	private readonly inverse: DurableInverse<CellularClatHostPlan>;
	private closing = false;
	private removing = false;
	private withdrawing = false;
	private retired = false;
	private withdrawn = false;
	private tail: Promise<void> = Promise.resolve();
	constructor(
		raw: CellularClatHostPlan,
		private readonly deps: CellularClatHostDeps,
	) {
		this.authority = parseCellularClatHostPlan(raw);
		const { input, physical, dns } = this.authority,
			routes = planCellularRoutes(input);
		if (!routes?.translated) throw new Error("Translated host required");
		this.binding = {
			source: routes.source,
			device: routes.device,
			translated: true,
			generation: input.epoch,
		};
		this.dns = {
			source: input.ipv6,
			device: physical.ifname,
			ifindex: Number(physical.ifindex),
			dns,
		};
		this.cancelProbe = deps.cancelProbe;
		this.steps = cellularClatHostSteps(this.authority);
		this.effects = deps.effects(this.authority, routes, {
			current: () => this.current(),
			writable: () =>
				deps.owned() &&
				!this.retired &&
				(this.removing ||
					this.withdrawing ||
					(!this.closing && deps.currentNow())),
		});
		const key = cellularUplinkSlotKey(input.slot);
		this.inverse = new DurableInverse({
			...privateInverseStore(deps.store, key),
			parsePlan: (value) => {
				const parsed = parseCellularClatHostPlan(value);
				if (JSON.stringify(parsed) !== JSON.stringify(this.authority))
					throw new Error("CLAT host authority changed");
				return parsed;
			},
			steps: () => this.steps,
			current: async (record) =>
				record.owner === input.owner &&
				record.epoch === input.epoch &&
				(await this.current()),
			inspect: async (_record, step) =>
				this.effects.inspect(this.step(step), this.removing),
			apply: async (_record, step) => {
				if (!deps.owned() || this.retired || this.closing || !deps.currentNow())
					throw new Error("CLAT apply lease retired");
				await this.effects.apply(this.step(step));
			},
			remove: async (_record, step) => {
				if (!deps.owned() || this.retired)
					throw new Error("CLAT inverse lease retired");
				await this.effects.remove(this.step(step));
			},
			withdraw: () => this.withdraw(),
			fence: async () => {
				if (!deps.owned() || this.retired)
					throw new Error("CLAT fence lease retired");
				await this.effects.deny();
			},
			consumersReleased: deps.consumersReleased,
		});
	}
	private step(value: string): string {
		if (!this.steps.includes(value))
			throw new Error("Unknown CLAT inverse step");
		return value;
	}
	private async current(): Promise<boolean> {
		return (
			!this.closing &&
			!this.retired &&
			this.deps.owned() &&
			this.deps.currentNow() &&
			(await this.deps.current()) &&
			!this.closing &&
			!this.retired &&
			this.deps.owned() &&
			this.deps.currentNow()
		);
	}
	private withdraw(): void {
		if (this.withdrawn) return;
		this.withdrawn = true;
		this.deps.withdraw();
	}
	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const pending = this.tail.then(operation);
		this.tail = pending.then(
			() => undefined,
			() => undefined,
		);
		return pending;
	}
	install(): Promise<void> {
		return this.serial(async () => {
			if (!(await this.current()))
				throw new Error("CLAT host identity unavailable");
			await this.inverse.create(
				this.authority.input.owner,
				this.authority.input.epoch,
				this.authority,
			);
		});
	}
	async valid(): Promise<boolean> {
		if (!(await this.current())) return false;
		const record = await this.inverse.read();
		if (
			record?.phase !== "active" ||
			record.owner !== this.authority.input.owner ||
			record.epoch !== this.authority.input.epoch
		)
			return false;
		for (const step of this.steps)
			if ((await this.effects.inspect(step, false)) !== "owned") return false;
		return (await this.effects.valid()) && (await this.current());
	}
	prepareProbe(): Promise<boolean> {
		return this.serial(async () => {
			if (!(await this.valid())) return false;
			if (!(await this.current())) return false;
			if ((await this.effects.output.inspect()) !== "ready")
				await this.effects.output.transition("probe");
			return this.current();
		});
	}
	setReady(ready: boolean): Promise<boolean> {
		return this.serial(async () => {
			if (!this.deps.owned() || this.retired || this.closing) return false;
			if (ready && !(await this.valid())) return false;
			this.withdrawing = !ready;
			try {
				await this.effects.output.transition(ready ? "ready" : "withdrawn");
			} finally {
				this.withdrawing = false;
			}
			return (
				!this.closing && this.deps.owned() && (!ready || (await this.current()))
			);
		});
	}
	cleanup(): Promise<boolean> {
		if (this.retired) return Promise.resolve(true);
		this.closing = true;
		if (!this.deps.owned()) return Promise.resolve(false);
		this.withdraw();
		this.cancelProbe();
		return this.serial(async () => {
			if (this.retired) return true;
			if (!this.deps.owned()) return false;
			this.removing = true;
			try {
				const done = await this.inverse.cleanup(
					this.authority.input.owner,
					this.authority.input.epoch,
				);
				if (done) this.retired = true;
				return done;
			} finally {
				this.removing = false;
			}
		});
	}
}
