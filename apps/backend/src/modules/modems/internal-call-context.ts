import {
	type InternalContextAuthority,
	type InternalContextRequest,
	internalContextAuthorityKey,
	parseInternalContextAuthority,
	sameInternalContext,
} from "./internal-context-authority.ts";
import {
	defaultInternalContextAccess,
	type InternalContextEffectsDeps,
	journalInternalContextEffects,
} from "./internal-context-effects.ts";
import type { CellularControl } from "./modems.ts";
import type { withJournaledModemMutation } from "./mutation-lease.ts";
import { internalContextCommand } from "./transport-policy.ts";

/** Context operations of the one retained modem owner. No polling or process
 * lifetime belongs to this adapter; every effect uses the existing journal.
 */
export interface InternalCallContext {
	load(): Promise<void>;
	known(): boolean;
	accept(control: CellularControl): Promise<boolean>;
	activate(control: CellularControl): Promise<boolean>;
	valid(control: CellularControl): Promise<boolean>;
	deactivate(control: CellularControl): Promise<boolean>;
	close(control: CellularControl): Promise<boolean>;
}
export interface InternalCallContextDeps {
	readonly owned: () => boolean;
	readonly withdrawn: () => boolean;
	readonly identity: (
		control: CellularControl,
	) => ReturnType<InternalContextEffectsDeps["identity"]>;
	readonly current: () => Promise<boolean>;
	readonly prepareCall: () => Promise<void>;
	readonly access?: InternalContextEffectsDeps["access"];
	readonly journal?: typeof withJournaledModemMutation;
}

export function createInternalCallContext(
	stableKey: string,
	raw: InternalContextRequest,
	deps: InternalCallContextDeps,
): InternalCallContext {
	const request = Object.freeze({
			...raw,
			desired: Object.freeze({
				...raw.desired,
				...(raw.desired.settings
					? { settings: Object.freeze([...raw.desired.settings]) }
					: {}),
			}),
		}),
		key = internalContextAuthorityKey(request.unit, request.cid),
		storage = deps.access ?? defaultInternalContextAccess(request);
	internalContextCommand(
		request.cid,
		request.desired.apn,
		request.desired.family,
		request.desired.settings,
	);
	if (!/^[a-f0-9]{64}$/.test(request.subscription))
		throw new Error("Unresolved internal subscription");
	let known = false,
		latest: InternalContextAuthority | undefined;
	const access: InternalContextEffectsDeps["access"] = (operation) =>
		storage(async (value, write) => {
			latest = value ? parseInternalContextAuthority(value, key) : undefined;
			if (latest) known = true;
			return operation(latest, async (next) => {
				const captured = next
					? parseInternalContextAuthority(next, key)
					: undefined;
				await write(captured);
				latest = captured;
				if (captured) known = true;
			});
		});
	const load = () => access(async () => undefined),
		effects = (control: CellularControl): InternalContextEffectsDeps => ({
			owned: deps.owned,
			withdrawn: deps.withdrawn,
			baselineAllowed: () => !known,
			identity: () => deps.identity(control),
			current: deps.current,
			prepareCall: deps.prepareCall,
			access,
		}),
		identify = async (control: CellularControl) => {
			try {
				if (!deps.owned() || !(await control.valid())) return undefined;
				const identity = await deps.identity(control);
				return deps.owned() &&
					(await control.valid()) &&
					identity?.unit === request.unit &&
					identity.stableKey === stableKey &&
					/^[a-f0-9]{64}$/.test(identity.subscription)
					? Object.freeze({ ...identity })
					: undefined;
			} catch {
				return undefined;
			}
		},
		mutate = (
			operation: "activate" | "deactivate" | "restore" | "park",
			control: CellularControl,
			selected = request,
		) =>
			journalInternalContextEffects(
				stableKey,
				operation,
				selected,
				control,
				effects(control),
				deps.journal,
			),
		matchesPolicy = (record: InternalContextAuthority) =>
			record.desired.apn === request.desired.apn &&
			record.desired.family === request.desired.family &&
			(request.desired.settings === undefined ||
				sameInternalContext(record.desired, request.desired));
	return {
		load,
		known: () => known,
		accept: async (control) => !!(await identify(control)),
		activate: async (control) => {
			await load();
			const prior = latest;
			if (prior && prior.subscription !== request.subscription) {
				const predecessor = {
					unit: prior.unit,
					subscription: prior.subscription,
					cid: prior.cid,
					desired: prior.desired,
				};
				if (!(await mutate("park", control, predecessor))) return false;
			} else if (
				prior &&
				(["deactivating", "restoring"].includes(prior.phase) ||
					!matchesPolicy(prior))
			) {
				const predecessor = {
					unit: prior.unit,
					subscription: prior.subscription,
					cid: prior.cid,
					desired: prior.desired,
				};
				if (!(await mutate("restore", control, predecessor))) return false;
			}
			return mutate("activate", control);
		},
		valid: async (control) => {
			const first = await identify(control);
			if (
				first?.subscription !== request.subscription ||
				!(await deps.current())
			)
				return false;
			return access(async (record) => {
				if (
					record?.phase !== "active" ||
					record.subscription !== request.subscription ||
					!matchesPolicy(record)
				)
					return false;
				try {
					const context = await control.readContext(request.cid),
						active = await control.contextActive(request.cid);
					return (
						!!context &&
						active === true &&
						sameInternalContext(context, record.desired) &&
						(await identify(control))?.subscription === request.subscription &&
						(await deps.current())
					);
				} catch {
					return false;
				}
			});
		},
		deactivate: async (control) => {
			await load();
			return mutate("deactivate", control);
		},
		close: async (control) => {
			await load();
			if (!known) return true;
			const prior = latest;
			if (!prior) return false;
			const identity = await identify(control);
			if (!identity) return false;
			const predecessor = {
				unit: prior.unit,
				subscription: prior.subscription,
				cid: prior.cid,
				desired: prior.desired,
			};
			return mutate(
				identity.subscription === prior.subscription ? "restore" : "park",
				control,
				predecessor,
			);
		},
	};
}
