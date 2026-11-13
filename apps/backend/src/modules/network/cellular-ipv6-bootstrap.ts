import {
	DurableInverse,
	privateInverseStore,
} from "../../helpers/durable-inverse.ts";
import type { PrivateStateStore } from "../../helpers/private-json-state.ts";
import { cellularFirewallIO } from "./cellular-firewall.ts";
import { inventoryCellularHosts } from "./cellular-host-inventory.ts";
import { CellularIpState, cellularIpIO } from "./cellular-ip-state.ts";
import { CellularIpv6BootstrapFence } from "./cellular-ipv6-bootstrap-fence.ts";
import {
	type CellularIpv6BootstrapPlan,
	cellularIpv6BootstrapKey,
	cellularIpv6BootstrapRoutes,
	cellularIpv6BootstrapSteps,
	parseCellularIpv6BootstrapPlan,
} from "./cellular-ipv6-bootstrap-plan.ts";
import {
	type CellularDnsResult,
	type CellularProbePath,
	probeCellularDns,
} from "./cellular-path-probe.ts";
import type { CellularRoutePlan } from "./cellular-route-plan.ts";

type Fence = Pick<
	CellularIpv6BootstrapFence,
	"inspect" | "create" | "transition" | "remove"
>;
type Ip = Pick<CellularIpState, "inspect" | "apply" | "remove">;
export interface CellularIpv6BootstrapDeps {
	readonly store: PrivateStateStore;
	readonly bootId: string;
	readonly owned: () => boolean;
	readonly currentNow: () => boolean;
	readonly current: () => Promise<boolean>;
	/** Durable pair-scoped budget reservation before the only DNS attempt. */
	readonly reserve: (bytes: number) => Promise<boolean>;
	readonly consumersReleased: () => Promise<boolean>;
	readonly probe?: (
		path: CellularProbePath,
		signal: AbortSignal,
	) => Promise<CellularDnsResult>;
	readonly effects?: (
		plan: CellularIpv6BootstrapPlan,
		routes: CellularRoutePlan,
		current: () => Promise<boolean>,
		writable: () => boolean,
	) => { readonly fence: Fence; readonly ip: Ip };
}
function kernelEffects(
	plan: CellularIpv6BootstrapPlan,
	routes: CellularRoutePlan,
	current: () => Promise<boolean>,
	writable: () => boolean,
) {
	const nft = cellularFirewallIO(current),
		ip = cellularIpIO(current);
	return {
		fence: new CellularIpv6BootstrapFence(plan, {
			...nft,
			write: async (text) => {
				if (!writable()) throw new Error("Bootstrap fence lease retired");
				await nft.write(text);
			},
		}),
		ip: new CellularIpState(routes, {
			...ip,
			write: async (argv) => {
				if (!writable()) throw new Error("Bootstrap IP lease retired");
				await ip.write(argv);
			},
		}),
	};
}
/** A finite DNS discovery stage, never a published uplink. The caller retains
 * the shared slot lease on every uncertain reply, closes this stage completely,
 * then revalidates the grant before installing a translator with fresh ownership.
 * No route/configuration is shared with or adopted by the final CLAT child.
 */
export class CellularIpv6Bootstrap {
	readonly plan: CellularIpv6BootstrapPlan;
	private readonly routes: CellularRoutePlan;
	private readonly effects: { readonly fence: Fence; readonly ip: Ip };
	private readonly inverse: DurableInverse<CellularIpv6BootstrapPlan>;
	private tail: Promise<void> = Promise.resolve();
	private closing = false;
	private removing = false;
	private retired = false;
	private attempted = false;
	private abort: AbortController | undefined;
	private pending: Promise<CellularDnsResult> | undefined;
	constructor(
		raw: CellularIpv6BootstrapPlan,
		private readonly deps: CellularIpv6BootstrapDeps,
	) {
		this.plan = parseCellularIpv6BootstrapPlan(raw);
		this.routes = cellularIpv6BootstrapRoutes(this.plan);
		this.effects = (deps.effects ?? kernelEffects)(
			this.plan,
			this.routes,
			() => this.current(),
			() =>
				this.sameBoot() &&
				deps.owned() &&
				!this.retired &&
				(this.removing || (!this.closing && deps.currentNow())),
		);
		this.inverse = new DurableInverse({
			...privateInverseStore(
				deps.store,
				cellularIpv6BootstrapKey(this.plan.slot),
			),
			parsePlan: (raw) => {
				const value = parseCellularIpv6BootstrapPlan(raw);
				if (JSON.stringify(value) !== JSON.stringify(this.plan))
					throw new Error("Bootstrap authority changed");
				return value;
			},
			steps: cellularIpv6BootstrapSteps,
			current: async (record) =>
				record.owner === this.plan.owner &&
				record.epoch === this.plan.epoch &&
				(await this.current()),
			inspect: async (_record, step) => {
				const state =
					step === "fence"
						? await this.effects.fence.inspect()
						: await this.effects.ip.inspect(this.effect(step), this.removing);
				return state === "absent"
					? "absent"
					: !this.sameBoot() || state === "foreign"
						? "foreign"
						: "owned";
			},
			apply: async (_record, step) => {
				if (step === "fence") await this.effects.fence.create("withdrawn");
				else await this.effects.ip.apply(this.effect(step));
			},
			remove: async (_record, step) => {
				if (!this.sameBoot() || !deps.owned() || this.retired)
					throw new Error("Bootstrap inverse lease retired");
				const complete =
					step === "fence"
						? await this.effects.fence.remove()
						: await this.effects.ip.remove(this.effect(step));
				if (!complete) throw new Error("Bootstrap inverse remains owned");
			},
			withdraw: () => this.cancelProbe(),
			fence: async () => {
				const state = await this.effects.fence.inspect();
				if (state !== "absent") {
					if (!this.sameBoot() || !deps.owned() || this.retired)
						throw new Error("Bootstrap fence belongs to another lifetime");
					await this.effects.fence.transition("withdrawn");
				}
			},
			consumersReleased: async () =>
				!this.pending && (await deps.consumersReleased()) && !this.pending,
		});
	}
	private sameBoot() {
		return this.plan.bootId === this.deps.bootId;
	}
	private async current(): Promise<boolean> {
		const permitted = () =>
			this.sameBoot() &&
			!this.closing &&
			!this.retired &&
			this.deps.owned() &&
			this.deps.currentNow();
		return permitted() && (await this.deps.current()) && permitted();
	}
	private effect(step: string) {
		if (!/^ip-\d+$/.test(step))
			throw new Error("Unknown bootstrap inverse step");
		const effect = this.routes.effects[Number(step.slice(3))];
		if (!effect) throw new Error("Missing bootstrap inverse step");
		return effect;
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
				throw new Error("Bootstrap grant unavailable");
			if (
				(await inventoryCellularHosts(this.deps.store)).some(
					(row) => row.slot === this.plan.slot,
				)
			)
				throw new Error("Bootstrap slot remains owned");
			await this.inverse.create(this.plan.owner, this.plan.epoch, this.plan);
		});
	}
	async valid(): Promise<boolean> {
		if (!(await this.current())) return false;
		const record = await this.inverse.read();
		if (
			record?.phase !== "active" ||
			record.owner !== this.plan.owner ||
			record.epoch !== this.plan.epoch
		)
			return false;
		for (const effect of this.routes.effects)
			if ((await this.effects.ip.inspect(effect)) !== "owned") return false;
		const fence = await this.effects.fence.inspect();
		return fence !== "absent" && fence !== "foreign" && (await this.current());
	}
	cancelProbe(): void {
		this.abort?.abort();
	}
	async discover(): Promise<string | undefined> {
		const job = await this.serial(async () => {
			if (this.attempted || this.pending || !(await this.valid()))
				return undefined;
			this.attempted = true;
			if (!(await this.deps.reserve(32 * 1024)) || !(await this.current()))
				return undefined;
			await this.effects.fence.transition("probe");
			if (!(await this.current())) return undefined;
			const abort = new AbortController(),
				path: CellularProbePath = {
					source: this.plan.source,
					device: this.plan.physical.ifname,
					ifindex: Number(this.plan.physical.ifindex),
					dns: this.plan.dns,
				};
			this.abort = abort;
			const pending: Promise<CellularDnsResult> = Promise.resolve()
				.then(() => {
					if (
						abort.signal.aborted ||
						this.closing ||
						!this.deps.owned() ||
						!this.deps.currentNow()
					)
						return { ok: false } as const;
					return this.deps.probe
						? this.deps.probe(path, abort.signal)
						: probeCellularDns(path, undefined, abort.signal);
				})
				.catch(() => ({ ok: false }) as const)
				.finally(() => {
					if (this.pending === pending) {
						this.pending = undefined;
						this.abort = undefined;
					}
				});
			this.pending = pending;
			return { pending };
		});
		if (!job) return undefined;
		const result = await job.pending;
		return result.ok && (await this.current()) ? result.nat64 : undefined;
	}
	cleanup(): Promise<boolean> {
		if (this.retired) return Promise.resolve(true);
		this.closing = true;
		this.cancelProbe();
		return this.serial(async () => {
			if (this.retired) return true;
			if (!this.deps.owned()) return false;
			if (!(await this.inverse.read())) {
				if (
					this.pending ||
					!(await this.deps.consumersReleased()) ||
					(await this.effects.fence.inspect()) !== "absent"
				)
					return false;
				for (const effect of this.routes.effects)
					if ((await this.effects.ip.inspect(effect, true)) !== "absent")
						return false;
			}
			this.removing = true;
			try {
				const complete = await this.inverse.cleanup(
					this.plan.owner,
					this.plan.epoch,
				);
				if (complete) this.retired = true;
				return complete;
			} finally {
				this.removing = false;
			}
		});
	}
}
