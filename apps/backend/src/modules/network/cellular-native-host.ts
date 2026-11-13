import {
	DurableInverse,
	privateInverseStore,
} from "../../helpers/durable-inverse.ts";
import type { CellularPathSession } from "../modems/cellular-path-owner.ts";
import { CellularFirewall, cellularFirewallIO } from "./cellular-firewall.ts";
import { cellularPhysicalResourceState } from "./cellular-host-identity.ts";
import { inventoryCellularHosts } from "./cellular-host-inventory.ts";
import type { CellularIndexedIpEffect } from "./cellular-indexed-ip.ts";
import {
	CellularIndexedIpState,
	cellularIndexedIpIO,
} from "./cellular-indexed-ip-state.ts";
import { CellularIpState, cellularIpIO } from "./cellular-ip-state.ts";
import {
	type CellularNativeHostPlan,
	cellularNativeHostSteps,
	cellularUplinkSlotKey,
	parseCellularNativeHostPlan,
} from "./cellular-native-host-plan.ts";

export type { CellularNativeHostPlan } from "./cellular-native-host-plan.ts";

import type { CellularPacketFence } from "./cellular-packet-fence.ts";
import {
	type CellularRoutePlan,
	planCellularRoutes,
} from "./cellular-route-plan.ts";

type Firewall = Pick<
	CellularFirewall,
	"inspect" | "create" | "transition" | "remove"
>;
type IpState = Pick<CellularIpState, "inspect" | "apply" | "remove">;
type AddressState = Pick<
	CellularIndexedIpState,
	"inspect" | "apply" | "remove"
>;
interface NativeAddressContext {
	readonly physical: NonNullable<CellularNativeHostPlan["ownedAddress"]>;
	readonly effect: CellularIndexedIpEffect;
	readonly sameBoot: boolean;
	/** A disconnected namespace supplies indexed virtual-link evidence here;
	 * production uses the captured USB instance and positive absence census.
	 */
	readonly physicalState?: () => Promise<
		"present" | "absent" | "foreign" | "unknown"
	>;
}
export interface CellularNativeHostDeps {
	/** Lifetime slot lease and retained actor ownership; checked synchronously at dispatch. */
	readonly owned: () => boolean;
	readonly bootId: string;
	/** Captured observation revision; cleanup retains its separate lease. */
	readonly currentNow: () => boolean;
	/** Fresh physical device, SIM, subscription and actual grant identity. */
	readonly current: () => Promise<boolean>;
	readonly store: { readonly dir: string };
	readonly withdraw: () => void;
	readonly consumersReleased: () => Promise<boolean>;
	readonly cancelProbe: () => void;
	readonly effects?: (
		plan: CellularRoutePlan,
		fence: CellularPacketFence,
		current: () => Promise<boolean>,
		writable: () => boolean,
		address?: NativeAddressContext,
	) => { firewall: Firewall; ip: IpState; address?: AddressState };
}
function routes(value: CellularNativeHostPlan): CellularRoutePlan {
	const { ipv4Gateway, ...input } = value.input;
	const plan = planCellularRoutes({
		...input,
		...(ipv4Gateway !== undefined ? { ipv4Gateway } : {}),
	});
	if (!plan || plan.translated) throw new Error("Native grant required");
	return plan;
}
export function createCellularNativeKernelEffects(
	plan: CellularRoutePlan,
	fence: CellularPacketFence,
	current: () => Promise<boolean>,
	writable: () => boolean,
	address?: NativeAddressContext,
) {
	const firewall = cellularFirewallIO(current),
		ip = cellularIpIO(current);
	return {
		firewall: new CellularFirewall(fence, {
			...firewall,
			write: async (text) => {
				if (!writable()) throw new Error("Retired cellular host write");
				await firewall.write(text);
			},
		}),
		ip: new CellularIpState(plan, {
			...ip,
			write: async (argv) => {
				if (!writable()) throw new Error("Retired cellular host write");
				await ip.write(argv);
			},
		}),
		...(address
			? {
					address: new CellularIndexedIpState(
						{ name: plan.device, index: fence.ifindex },
						[address.effect],
						cellularIndexedIpIO(
							address.physicalState ??
								(() =>
									cellularPhysicalResourceState(
										address.physical,
										address.sameBoot,
									)),
							writable,
						),
					),
				}
			: {}),
	};
}
/** Native host composition. Caller retains the slot lease/actor even after an
 * uncertain install and releases it only after cleanup returns true. NM owns
 * native addresses by default. An explicit internal-call address also owns its
 * indexed /32, behind the fence and under this same durable inverse.
 * All writes serialize, including failure cleanup and late readiness replies.
 */
export class CellularNativeHost implements CellularPathSession {
	readonly binding;
	readonly dns;
	readonly cancelProbe;
	private readonly firewall: Firewall;
	private readonly ip: IpState;
	private readonly address: AddressState | undefined;
	private readonly addressEffect: CellularIndexedIpEffect | undefined;
	private readonly plan: CellularRoutePlan;
	private readonly inverse: DurableInverse<CellularNativeHostPlan>;
	private tail: Promise<void> = Promise.resolve();
	private closing = false;
	private retired = false;
	private removing = false;
	private withdrawing = false;
	private withdrawn = false;
	constructor(
		readonly authority: CellularNativeHostPlan,
		private readonly deps: CellularNativeHostDeps,
	) {
		this.authority = parseCellularNativeHostPlan(authority);
		this.plan = routes(this.authority);
		const { input, ifindex, dns } = this.authority;
		this.binding = {
			source: this.plan.source,
			device: this.plan.device,
			translated: false,
			generation: input.epoch,
		};
		this.dns = { source: this.plan.source, device: input.iface, ifindex, dns };
		this.cancelProbe = deps.cancelProbe;
		this.addressEffect = this.authority.ownedAddress
			? Object.freeze({
					kind: "address",
					family: 4,
					address: this.plan.source,
					prefix: 32,
				})
			: undefined;
		const effects = (deps.effects ?? createCellularNativeKernelEffects)(
			this.plan,
			{
				owner: input.owner,
				slot: input.slot,
				source: this.plan.source,
				ifindex,
				dns,
				translated: false,
			},
			() => this.current(),
			() =>
				this.sameBoot() &&
				deps.owned() &&
				!this.retired &&
				(this.removing ||
					this.withdrawing ||
					(!this.closing && deps.currentNow())),
			this.authority.ownedAddress && this.addressEffect
				? {
						physical: this.authority.ownedAddress,
						effect: this.addressEffect,
						sameBoot: this.sameBoot(),
					}
				: undefined,
		);
		this.firewall = effects.firewall;
		this.ip = effects.ip;
		this.address = effects.address;
		if (this.addressEffect && !this.address)
			throw new Error("Native address owner unavailable");
		const key = cellularUplinkSlotKey(input.slot),
			store = privateInverseStore(deps.store, key);
		this.inverse = new DurableInverse({
			...store,
			parsePlan: (raw) => {
				const parsed = parseCellularNativeHostPlan(raw);
				routes(parsed);
				if (JSON.stringify(parsed) !== JSON.stringify(this.authority))
					throw new Error("Native host authority changed");
				return parsed;
			},
			steps: cellularNativeHostSteps,
			current: async (record) =>
				record.owner === input.owner &&
				record.epoch === input.epoch &&
				(await this.current()),
			inspect: async (_record, step) => {
				const state =
					step === "address"
						? await this.addressOwner().state.inspect(
								this.addressOwner().effect,
							)
						: step !== "fence"
							? await this.ip.inspect(this.effect(step), this.removing)
							: await this.firewall.inspect();
				return state === "absent"
					? "absent"
					: !this.sameBoot() || state === "foreign"
						? "foreign"
						: "owned";
			},
			apply: async (_record, step) => {
				if (step === "fence") await this.firewall.create("withdrawn");
				else if (step === "address")
					await this.addressOwner().state.apply(this.addressOwner().effect);
				else await this.ip.apply(this.effect(step));
			},
			remove: async (_record, step) => {
				if (!this.sameBoot() || !deps.owned() || this.retired)
					throw new Error("Native inverse lease retired");
				const removed =
					step === "address"
						? await this.addressOwner().state.remove(this.addressOwner().effect)
						: step === "fence"
							? await this.firewall.remove()
							: await this.ip.remove(this.effect(step));
				if (!removed) throw new Error("Native inverse remains owned");
			},
			withdraw: () => this.withdraw(),
			fence: async () => {
				if (!deps.owned() || this.retired)
					throw new Error("Native fence lease retired");
				if ((await this.firewall.inspect()) !== "absent") {
					if (!this.sameBoot())
						throw new Error("Native fence belongs to another boot");
					await this.firewall.transition("withdrawn");
				}
			},
			consumersReleased: deps.consumersReleased,
		});
	}
	private addressOwner() {
		if (!this.address || !this.addressEffect)
			throw new Error("Unknown native address inverse");
		return { state: this.address, effect: this.addressEffect };
	}
	private effect(step: string) {
		if (!/^ip-\d+$/.test(step)) throw new Error("Unknown native inverse step");
		const effect = this.plan.effects[Number(step.slice(3))];
		if (!effect) throw new Error("Missing native inverse step");
		return effect;
	}
	private withdraw(): void {
		if (this.withdrawn) return;
		this.withdrawn = true;
		this.deps.withdraw();
	}
	private sameBoot(): boolean {
		return this.authority.bootId === this.deps.bootId;
	}
	private async current(): Promise<boolean> {
		return (
			this.sameBoot() &&
			!this.closing &&
			!this.retired &&
			this.deps.owned() &&
			this.deps.currentNow() &&
			(await this.deps.current()) &&
			this.sameBoot() &&
			!this.closing &&
			!this.retired &&
			this.deps.owned() &&
			this.deps.currentNow()
		);
	}
	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const pending = this.tail.then(operation);
		this.tail = pending.then(
			() => undefined,
			() => undefined,
		);
		return pending;
	}
	async install(): Promise<void> {
		await this.serial(async () => {
			if (!(await this.current()))
				throw new Error("Native host identity unavailable");
			if (
				(await inventoryCellularHosts(this.deps.store)).some(
					(row) => row.slot === this.authority.input.slot,
				)
			)
				throw new Error("Native host slot remains owned");
			if (
				this.address &&
				this.addressEffect &&
				(await this.address.inspect(this.addressEffect)) !== "absent"
			)
				throw new Error("Native address already exists");
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
		if (
			this.address &&
			this.addressEffect &&
			(await this.address.inspect(this.addressEffect)) !== "owned"
		)
			return false;
		for (const effect of this.plan.effects)
			if ((await this.ip.inspect(effect)) !== "owned") return false;
		const fence = await this.firewall.inspect();
		return fence !== "absent" && fence !== "foreign" && (await this.current());
	}
	prepareProbe(): Promise<boolean> {
		return this.serial(async () => {
			if (!(await this.valid())) return false;
			if ((await this.firewall.inspect()) !== "ready")
				await this.firewall.transition("probe");
			return await this.current();
		});
	}
	setReady(ready: boolean): Promise<boolean> {
		return this.serial(async () => {
			if (
				!this.sameBoot() ||
				!this.deps.owned() ||
				this.retired ||
				this.closing
			)
				return false;
			if (ready && !(await this.valid())) return false;
			this.withdrawing = !ready;
			try {
				await this.firewall.transition(ready ? "ready" : "withdrawn");
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
		this.deps.cancelProbe();
		this.withdraw();
		return this.serial(async () => {
			if (this.retired) return true;
			if (!this.deps.owned()) return false;
			// A visible unlink may have failed its directory acknowledgement. With no
			// envelope, retire only after a complete positive kernel absence check.
			if (!(await this.inverse.read())) {
				if ((await this.firewall.inspect()) !== "absent") return false;
				if (
					this.address &&
					this.addressEffect &&
					(await this.address.inspect(this.addressEffect)) !== "absent"
				)
					return false;
				for (const effect of this.plan.effects)
					if ((await this.ip.inspect(effect, true)) !== "absent") return false;
			}
			this.removing = true;
			try {
				const complete = await this.inverse.cleanup(
					this.authority.input.owner,
					this.authority.input.epoch,
				);
				if (complete) this.retired = true;
				return complete;
			} finally {
				this.removing = false;
			}
		});
	}
}
