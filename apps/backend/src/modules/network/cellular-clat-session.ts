import { createHash } from "node:crypto";
import { z } from "zod";
import {
	readParsedPrivateJson,
	writePrivateJson,
} from "../../helpers/private-json-state.ts";
import type { CellularPathSession } from "../modems/cellular-path-owner.ts";
import {
	type CellularClatHostPlan,
	cellularClatHostPlanSchema,
	parseCellularClatHostPlan,
} from "./cellular-clat-host-plan.ts";
import { planCellularRoutes } from "./cellular-route-plan.ts";
import {
	type CellularTunIdentity,
	cellularTunAlias,
	inspectCellularTun,
} from "./cellular-tun.ts";

export type CellularClatBirthPlan = Omit<CellularClatHostPlan, "tun">;
const birthSchema = cellularClatHostPlanSchema.omit({ tun: true });
const recordSchema = z
	.object({
		version: z.literal(1),
		plan: birthSchema,
		tun: cellularClatHostPlanSchema.shape.tun.optional(),
		childSubmitted: z.boolean(),
		withdrawing: z.boolean(),
	})
	.strict();
export type CellularClatBirthRecord = z.infer<typeof recordSchema>;
type BirthRecord = CellularClatBirthRecord;
export function parseCellularClatBirthRecord(
	raw: unknown,
): CellularClatBirthRecord {
	const record = recordSchema.parse(raw),
		plan = parseCellularClatBirthPlan(record.plan);
	if (record.childSubmitted && !record.tun)
		throw new Error("CLAT birth child identity missing");
	if (record.tun) parseCellularClatHostPlan({ ...plan, tun: record.tun });
	return { ...record, plan: birthSchema.parse(plan) };
}
export function cellularClatBirthKey(slot: number): string {
	if (!Number.isInteger(slot) || slot < 1 || slot > 32)
		throw new Error("Invalid CLAT birth slot");
	return createHash("sha256")
		.update(`cellular-clat-birth\0${slot}`)
		.digest("hex");
}
export function parseCellularClatBirthPlan(
	raw: unknown,
): CellularClatBirthPlan {
	const value = birthSchema.parse(raw),
		index = Number(value.physical.ifindex);
	const { tun: _tun, ...plan } = parseCellularClatHostPlan({
		...value,
		tun: {
			name: `cclat${value.input.slot}`,
			index: index === 1 ? 2 : 1,
			alias: cellularTunAlias(value.input.owner, value.tunEpoch),
			persistent: true,
		},
	});
	return Object.freeze(plan);
}
/** No startup method installs hardware. A recovered birth can only withdraw.
 * The caller holds the slot's kernel lease until cleanup durably retires it.
 */
export interface CellularClatSessionDeps {
	readonly store: { readonly dir: string };
	readonly bootId: string;
	readonly owned: () => boolean;
	readonly currentNow: () => boolean;
	readonly current: () => Promise<boolean>;
	/** Allocation, private route/table and forwarding support baseline. */
	readonly preflight: (plan: CellularClatBirthPlan) => Promise<boolean>;
	readonly links: () => Promise<unknown>;
	readonly createTun: (
		plan: CellularClatBirthPlan,
	) => Promise<CellularTunIdentity>;
	/** No remaining addresses, routes, rules, consumers or foreign references. */
	readonly unreferenced: (tun: CellularTunIdentity) => Promise<boolean>;
	readonly deleteTun: (tun: CellularTunIdentity) => Promise<boolean>;
	readonly child: (
		plan: CellularClatHostPlan,
	) => CellularPathSession & { install(): Promise<void> };
	readonly withdraw: () => void;
	readonly cancelProbe: () => void;
	readonly consumersReleased: () => Promise<boolean>;
	readonly release: () => void;
}
export class CellularClatSession implements CellularPathSession {
	readonly plan: CellularClatBirthPlan;
	readonly binding;
	readonly dns;
	readonly cancelProbe;
	private readonly key: string;
	private child: ReturnType<CellularClatSessionDeps["child"]> | undefined;
	private tail: Promise<void> = Promise.resolve();
	private closing = false;
	private retired = false;
	private withdrawn = false;
	constructor(
		raw: CellularClatBirthPlan,
		private readonly deps: CellularClatSessionDeps,
	) {
		this.plan = parseCellularClatBirthPlan(raw);
		const routes = planCellularRoutes(this.plan.input);
		if (!routes?.translated) throw new Error("CLAT birth grant required");
		this.key = cellularClatBirthKey(this.plan.input.slot);
		this.binding = {
			source: routes.source,
			device: routes.device,
			translated: true,
			generation: this.plan.input.epoch,
		};
		this.dns = {
			source: this.plan.input.ipv6,
			device: this.plan.physical.ifname,
			ifindex: Number(this.plan.physical.ifindex),
			dns: this.plan.dns,
		};
		this.cancelProbe = deps.cancelProbe;
	}
	private writable(): boolean {
		return !this.retired && this.deps.owned();
	}
	get installingAllowed(): boolean {
		return !this.closing && this.writable() && this.deps.currentNow();
	}
	private async current(): Promise<boolean> {
		return (
			!this.closing &&
			this.writable() &&
			this.deps.currentNow() &&
			this.plan.bootId === this.deps.bootId &&
			(await this.deps.current()) &&
			!this.closing &&
			this.writable() &&
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
	private async read(): Promise<BirthRecord | undefined> {
		return readParsedPrivateJson(this.deps.store, this.key, (raw) => {
			const record = parseCellularClatBirthRecord(raw),
				plan = parseCellularClatBirthPlan(record.plan);
			if (JSON.stringify(plan) !== JSON.stringify(this.plan))
				throw new Error("CLAT birth authority changed");
			return record;
		});
	}
	private async write(record: BirthRecord | undefined): Promise<void> {
		if (!this.writable()) throw new Error("CLAT birth lease retired");
		await writePrivateJson(this.deps.store, this.key, record);
	}
	private host(tun: CellularTunIdentity) {
		this.child ??= this.deps.child(
			parseCellularClatHostPlan({ ...this.plan, tun }),
		);
		return this.child;
	}
	install(): Promise<void> {
		return this.serial(async () => {
			if (!(await this.current()) || (await this.read()))
				throw new Error("CLAT birth slot remains owned");
			if (!(await this.deps.preflight(this.plan)) || !(await this.current()))
				throw new Error("CLAT birth baseline unavailable");
			let record: BirthRecord = {
				version: 1,
				plan: birthSchema.parse(this.plan),
				childSubmitted: false,
				withdrawing: false,
			};
			await this.write(record);
			if (!(await this.current()))
				throw new Error("CLAT birth observation retired");
			const tun = await this.deps.createTun(this.plan);
			record = {
				...record,
				tun: cellularClatHostPlanSchema.shape.tun.parse(tun),
			};
			await this.write(record);
			if (!(await this.current()))
				throw new Error("CLAT birth observation retired");
			record = { ...record, childSubmitted: true };
			await this.write(record);
			if (!(await this.current()))
				throw new Error("CLAT birth observation retired");
			await this.host(tun).install();
		});
	}
	async valid(): Promise<boolean> {
		if (!(await this.current())) return false;
		const record = await this.read();
		return (
			!!record?.tun &&
			record.childSubmitted &&
			!record.withdrawing &&
			(await this.host(record.tun).valid()) &&
			(await this.current())
		);
	}
	/** A health socket uses the born TUN identity, never its prospective name alone. */
	async sourcePath(): Promise<
		{ source: string; device: string; ifindex: number } | undefined
	> {
		if (!(await this.valid())) return undefined;
		const record = await this.read();
		if (!record?.tun) return undefined;
		const state = inspectCellularTun(
			await this.deps.links(),
			this.plan.input.slot,
			this.plan.input.owner,
			this.plan.tunEpoch,
		);
		return typeof state === "object" &&
			state.index === record.tun.index &&
			state.persistent &&
			(await this.valid())
			? {
					source: this.binding.source,
					device: record.tun.name,
					ifindex: record.tun.index,
				}
			: undefined;
	}
	prepareProbe(): Promise<boolean> {
		return this.serial(
			async () =>
				(await this.valid()) &&
				!!this.child &&
				(await this.child.prepareProbe()) &&
				(await this.current()),
		);
	}
	setReady(ready: boolean): Promise<boolean> {
		return this.serial(async () => {
			if (
				!this.writable() ||
				this.closing ||
				!this.child ||
				(ready && !(await this.valid()))
			)
				return false;
			const done = await this.child.setReady(ready);
			return done && (!ready || (await this.current()));
		});
	}
	cleanup(): Promise<boolean> {
		if (this.retired) return Promise.resolve(true);
		this.closing = true;
		if (!this.writable()) return Promise.resolve(false);
		if (!this.withdrawn) {
			this.withdrawn = true;
			this.deps.withdraw();
		}
		this.cancelProbe();
		return this.serial(async () => {
			if (this.retired) return true;
			if (!this.writable()) return false;
			let record = await this.read();
			if (!record) {
				if (
					inspectCellularTun(
						await this.deps.links(),
						this.plan.input.slot,
						this.plan.input.owner,
						this.plan.tunEpoch,
					) !== "absent" ||
					!(await this.deps.consumersReleased())
				)
					return false;
				await this.write(undefined);
				this.retire();
				return true;
			}
			record = { ...record, withdrawing: true };
			await this.write(record);
			if (
				record.childSubmitted &&
				record.tun &&
				!(await this.host(record.tun).cleanup())
			)
				return false;
			// Old-boot interfaces can reuse indices and aliases from a restored image.
			// Do not infer permission to mutate them from a retained birth record.
			const observed = inspectCellularTun(
				await this.deps.links(),
				this.plan.input.slot,
				this.plan.input.owner,
				this.plan.tunEpoch,
			);
			if (
				observed === "foreign" ||
				(observed !== "absent" && this.plan.bootId !== this.deps.bootId)
			)
				return false;
			if (typeof observed !== "string") {
				const recordedTun = record.tun;
				if (
					!observed.persistent ||
					(recordedTun &&
						["name", "index", "alias", "persistent"].some(
							(key) =>
								recordedTun[key as keyof CellularTunIdentity] !==
								observed[key as keyof CellularTunIdentity],
						))
				)
					return false;
				// Lost create reply: persist the exact same-boot random birth identity
				// solely for cleanup. Never submit the child from this recovery path.
				if (!record.tun) {
					record = {
						...record,
						tun: cellularClatHostPlanSchema.shape.tun.parse(observed),
					};
					await this.write(record);
				}
			}
			if (!(await this.deps.consumersReleased()) || !this.writable())
				return false;
			if (typeof observed !== "string") {
				if (
					!(await this.deps.unreferenced(observed)) ||
					!this.writable() ||
					!(await this.deps.deleteTun(observed))
				)
					return false;
				if (
					inspectCellularTun(
						await this.deps.links(),
						this.plan.input.slot,
						this.plan.input.owner,
						this.plan.tunEpoch,
					) !== "absent"
				)
					return false;
			}
			await this.write(undefined);
			this.retire();
			return true;
		});
	}
	private retire(): void {
		this.retired = true;
		this.deps.release();
	}
}
