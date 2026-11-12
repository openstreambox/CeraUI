import {
	accessInternalContextAuthority,
	type InternalContextAuthority,
	type InternalContextRequest,
	internalContextAuthorityKey,
	parkInternalContextAuthority,
	parseInternalContextAuthority,
	planInternalContextAuthority,
	sameInternalContext,
} from "./internal-context-authority.ts";
import type { CellularControl } from "./modems.ts";
import type { JournaledMutation } from "./mutation-lease.ts";
import { withJournaledModemMutation } from "./mutation-lease.ts";
import {
	type InternalContext,
	internalContextCommand,
} from "./transport-policy.ts";

export interface InternalContextEffectsDeps {
	/** The retained owner/physical generation is still held, including inverse. */
	readonly owned: () => boolean;
	/** Captured withdrawal/consumer release remains current through each call. */
	readonly withdrawn: () => boolean;
	/** True only before this owner has observed or committed unit authority. */
	readonly baselineAllowed: () => boolean;
	/** Fresh physical unit and positive digit-only subscription observation. */
	readonly identity: () => Promise<
		| {
				readonly unit: string;
				readonly subscription: string;
				readonly stableKey: string;
		  }
		| undefined
	>;
	/** Current automatic profile intent and subscription/home policy. */
	readonly current: () => Promise<boolean>;
	/** The retained host inverse makes the exact link UP before CGACT. */
	readonly prepareCall: () => Promise<void>;
	readonly access: <T>(
		operation: (
			value: InternalContextAuthority | undefined,
			write: (value: InternalContextAuthority | undefined) => Promise<void>,
		) => Promise<T>,
	) => Promise<T>;
}
export interface InternalContextEffectResult {
	readonly confirmed: boolean;
	readonly value: boolean;
	readonly detail?: string;
}
export type InternalContextOperation =
	| "activate"
	| "deactivate"
	| "restore"
	| "park";
const preserved: InternalContextEffectResult = Object.freeze({
	confirmed: true,
	value: false,
});
const uncertain = (detail: string): InternalContextEffectResult => ({
	confirmed: false,
	value: false,
	detail,
});

function captureRequest(raw: InternalContextRequest): InternalContextRequest {
	internalContextAuthorityKey(raw.unit, raw.cid);
	if (!/^[a-f0-9]{64}$/.test(raw.subscription))
		throw new Error("Unresolved internal subscription");
	const desired = Object.freeze({
		...raw.desired,
		...(raw.desired.settings
			? { settings: Object.freeze([...raw.desired.settings]) }
			: {}),
	});
	internalContextCommand(
		raw.cid,
		desired.apn,
		desired.family,
		desired.settings,
	);
	return Object.freeze({
		unit: raw.unit,
		subscription: raw.subscription,
		cid: raw.cid,
		desired,
	});
}

export function defaultInternalContextAccess(
	request: InternalContextRequest,
): InternalContextEffectsDeps["access"] {
	const { unit, cid } = captureRequest(request);
	return (operation) => accessInternalContextAuthority(unit, cid, operation);
}
async function current(
	request: InternalContextRequest,
	deps: InternalContextEffectsDeps,
	control: CellularControl,
	policy = true,
): Promise<boolean> {
	try {
		if (!deps.owned() || !deps.withdrawn() || !(await control.valid()))
			return false;
		const first = await deps.identity();
		if (
			first?.unit !== request.unit ||
			first.subscription !== request.subscription ||
			!/^[a-f0-9]{64}$/.test(first.unit) ||
			!/^[a-f0-9]{64}$/.test(first.subscription) ||
			!deps.owned() ||
			(policy && !(await deps.current()))
		)
			return false;
		const last = await deps.identity();
		return (
			deps.owned() &&
			deps.withdrawn() &&
			last?.unit === request.unit &&
			last.subscription === request.subscription &&
			(await control.valid())
		);
	} catch {
		return false;
	}
}
async function observe(
	control: CellularControl,
	cid: number,
): Promise<
	| {
			readonly context: InternalContext;
			readonly active: boolean;
	  }
	| undefined
> {
	try {
		const context = await control.readContext(cid),
			active = await control.contextActive(cid);
		return context && typeof active === "boolean"
			? { context, active }
			: undefined;
	} catch {
		return undefined;
	}
}

/** One effect inside the existing identity lease/journal, never another owner.
 * Persist the unit baseline and each pending command before dispatch. Lost AT
 * replies settle only by exact read-back on the same current unit/subscription.
 */
export async function ensureInternalContextEffects(
	raw: InternalContextRequest,
	control: CellularControl,
	mutation: Pick<JournaledMutation, "markExecuting">,
	deps: InternalContextEffectsDeps,
): Promise<InternalContextEffectResult> {
	const request = captureRequest(raw);
	if (!(await current(request, deps, control))) return preserved;
	return deps.access(async (stored, write) => {
		if (!(await current(request, deps, control))) return preserved;
		if (!stored && !deps.baselineAllowed())
			return uncertain("Stored internal context authority disappeared");
		const before = await observe(control, request.cid);
		if (!before || !(await current(request, deps, control))) return preserved;
		let record = planInternalContextAuthority(
			request,
			before.context,
			before.active,
			stored,
		);
		if (!record) return preserved;
		if (["deactivating", "restoring"].includes(record.phase)) return preserved;
		await write(record);
		if (!(await current(request, deps, control))) return preserved;
		await mutation.markExecuting();
		if (!(await current(request, deps, control))) return preserved;
		try {
			await deps.prepareCall();
		} catch {
			return uncertain("Internal-call host preparation did not verify");
		}
		if (!(await current(request, deps, control)))
			return uncertain("Internal-call handoff lost its identity");
		let observed = await observe(control, request.cid);
		if (!observed || !(await current(request, deps, control)))
			return uncertain("Internal context observation unavailable");
		if (!sameInternalContext(observed.context, record.desired)) {
			if (
				observed.active ||
				!sameInternalContext(observed.context, record.before)
			)
				return uncertain("Internal context changed outside its owner");
			record = parseInternalContextAuthority(
				{ ...record, phase: "defining" },
				record.key,
			);
			await write(record);
			if (!(await current(request, deps, control)))
				return uncertain("Internal definition lost its identity");
			try {
				await control.defineContext(
					request.cid,
					record.desired.apn,
					record.desired.family,
					record.desired.settings,
				);
			} catch {
				// Positive read-back below is the only authority after a lost reply.
			}
			observed = await observe(control, request.cid);
			if (
				!observed ||
				!sameInternalContext(observed.context, record.desired) ||
				!(await current(request, deps, control))
			)
				return uncertain("Internal context definition did not verify");
		}
		record = parseInternalContextAuthority(
			{ ...record, phase: "defined" },
			record.key,
		);
		await write(record);
		if (!observed.active) {
			record = parseInternalContextAuthority(
				{
					...record,
					phase: "activating",
					activationOwned: true,
					adoptedActive: false,
				},
				record.key,
			);
			await write(record);
			if (!(await current(request, deps, control)))
				return uncertain("Internal activation lost its identity");
			try {
				await control.activateContext(request.cid, true);
			} catch {
				/* An uncertain response is not confirmation. */
			}
			observed = await observe(control, request.cid);
		} else if (!record.activationOwned && !record.adoptedActive) {
			return uncertain("Internal context was activated outside its owner");
		}
		if (
			!observed?.active ||
			!sameInternalContext(observed.context, record.desired) ||
			!(await current(request, deps, control))
		)
			return uncertain("Internal activation did not verify");
		record = parseInternalContextAuthority(
			{ ...record, phase: "active" },
			record.key,
		);
		await write(record);
		return (await current(request, deps, control))
			? { confirmed: true, value: true }
			: uncertain("Internal activation lost its identity after commit");
	});
}

/** Source/host withdrawal precedes this transaction. Never disconnect a call
 * merely because it matches an APN: only a recorded owned activation may stop.
 */
export async function deactivateInternalContextEffects(
	raw: InternalContextRequest,
	control: CellularControl,
	mutation: Pick<JournaledMutation, "markExecuting">,
	deps: InternalContextEffectsDeps,
): Promise<InternalContextEffectResult> {
	const request = captureRequest(raw);
	if (!(await current(request, deps, control, false))) return preserved;
	return deps.access(async (stored, write) => {
		if (!(await current(request, deps, control, false))) return preserved;
		if (!stored)
			return uncertain(
				"Stored internal context authority unavailable for withdrawal",
			);
		let record = parseInternalContextAuthority(
			stored,
			internalContextAuthorityKey(request.unit, request.cid),
		);
		if (record.subscription !== request.subscription) return preserved;
		const before = await observe(control, request.cid);
		if (!before || !(await current(request, deps, control, false)))
			return preserved;
		if (!sameInternalContext(before.context, record.desired)) return preserved;
		if (before.active) {
			if (!record.activationOwned) return preserved;
			record = parseInternalContextAuthority(
				{ ...record, phase: "deactivating" },
				record.key,
			);
			await write(record);
			await mutation.markExecuting();
			if (!(await current(request, deps, control, false)))
				return uncertain("Internal withdrawal lost its identity");
			try {
				await control.activateContext(request.cid, false);
			} catch {
				/* Exact inactive read-back below settles a lost reply. */
			}
			const after = await observe(control, request.cid);
			if (
				!after ||
				after.active ||
				!sameInternalContext(after.context, record.desired) ||
				!(await current(request, deps, control, false))
			)
				return uncertain("Internal context withdrawal did not verify");
		}
		if (!(await current(request, deps, control, false)))
			return uncertain("Internal withdrawal lost its identity before commit");
		await write(
			parseInternalContextAuthority(
				{
					...record,
					phase: "defined",
					activationOwned: false,
					adoptedActive: false,
				},
				record.key,
			),
		);
		return { confirmed: true, value: true };
	});
}

/** A positively changed SIM can retire its predecessor's inactive definition
 * without issuing any modem setter. Unknown subscription is never a change.
 */
export async function parkChangedInternalContextEffects(
	raw: InternalContextRequest,
	control: CellularControl,
	deps: InternalContextEffectsDeps,
): Promise<boolean> {
	const request = captureRequest(raw);
	const identity = async () => {
		try {
			if (!deps.owned() || !deps.withdrawn() || !(await control.valid()))
				return undefined;
			const value = await deps.identity();
			return deps.owned() &&
				deps.withdrawn() &&
				value?.unit === request.unit &&
				(await control.valid()) &&
				/^[a-f0-9]{64}$/.test(value.subscription) &&
				value.subscription !== request.subscription
				? Object.freeze({ unit: value.unit, subscription: value.subscription })
				: undefined;
		} catch {
			return undefined;
		}
	};
	const first = await identity();
	if (!first) return false;
	return deps.access(async (stored, write) => {
		if ((await identity())?.subscription !== first.subscription) return false;
		if (!stored) return false;
		const retained = parseInternalContextAuthority(
			stored,
			internalContextAuthorityKey(request.unit, request.cid),
		);
		if (retained.subscription !== request.subscription) return false;
		const observed = await observe(control, request.cid);
		if (!observed || (await identity())?.subscription !== first.subscription)
			return false;
		let candidate = retained;
		if (!sameInternalContext(observed.context, retained.desired)) {
			const pendingDefinition =
					["baseline", "defining"].includes(retained.phase) &&
					sameInternalContext(observed.context, retained.before),
				pendingRestore =
					retained.phase === "restoring" &&
					sameInternalContext(observed.context, retained.original.context);
			if (!pendingDefinition && !pendingRestore) return false;
			// A pending command may have left its before value or its inverse target.
			// This records observed inactive state; it never selects the next SIM's APN.
			candidate = parseInternalContextAuthority(
				{ ...retained, desired: observed.context },
				retained.key,
			);
		}
		const parked = parkInternalContextAuthority(
			candidate,
			observed.context,
			observed.active,
		);
		if (!parked) return false;
		await write(parked);
		return (await identity())?.subscription === first.subscription;
	});
}

/** Restore only on the baseline's original SIM. On a later SIM, retain a parked
 * unit record instead of defining an APN that belonged to its predecessor.
 */
export async function restoreInternalContextEffects(
	raw: InternalContextRequest,
	control: CellularControl,
	mutation: Pick<JournaledMutation, "markExecuting">,
	deps: InternalContextEffectsDeps,
): Promise<InternalContextEffectResult> {
	const request = captureRequest(raw);
	let executing = false;
	const once = {
		markExecuting: async () => {
			if (!executing) {
				await mutation.markExecuting();
				executing = true;
			}
		},
	};
	const stopped = await deactivateInternalContextEffects(
		request,
		control,
		once,
		deps,
	);
	if (!stopped.confirmed) return stopped;
	if (!(await current(request, deps, control, false))) return preserved;
	return deps.access(async (stored, write) => {
		if (!(await current(request, deps, control, false))) return preserved;
		if (!stored)
			return uncertain(
				"Stored internal context authority unavailable for restore",
			);
		let record = parseInternalContextAuthority(
			stored,
			internalContextAuthorityKey(request.unit, request.cid),
		);
		if (
			record.unit !== request.unit ||
			record.cid !== request.cid ||
			record.subscription !== request.subscription
		)
			return preserved;
		const before = await observe(control, request.cid);
		if (!before || !(await current(request, deps, control, false)))
			return preserved;
		if (record.original.subscription !== request.subscription) {
			const parked = parkInternalContextAuthority(
				record,
				before.context,
				before.active,
			);
			if (!parked) return preserved;
			await write(parked);
			return (await current(request, deps, control, false))
				? { confirmed: true, value: true }
				: uncertain("Parked context lost its identity after commit");
		}
		if (sameInternalContext(before.context, record.original.context)) {
			if (before.active && !(record.adoptedActive && record.original.active))
				return preserved;
			await write(
				parseInternalContextAuthority(
					{
						...record,
						desired: record.original.context,
						phase: before.active ? "released" : "parked",
						activationOwned: false,
						adoptedActive: before.active,
					},
					record.key,
				),
			);
			return (await current(request, deps, control, false))
				? { confirmed: true, value: true }
				: uncertain("Released context lost its identity after commit");
		}
		if (before.active || !sameInternalContext(before.context, record.desired))
			return preserved;
		record = parseInternalContextAuthority(
			{
				...record,
				phase: "restoring",
				activationOwned: false,
				adoptedActive: false,
			},
			record.key,
		);
		await write(record);
		await once.markExecuting();
		if (!(await current(request, deps, control, false)))
			return uncertain("Internal restore lost its identity");
		try {
			await control.defineContext(
				request.cid,
				record.original.context.apn,
				record.original.context.family,
				record.original.context.settings,
			);
		} catch {
			/* A restored definition still needs a positive same-SIM read. */
		}
		const after = await observe(control, request.cid);
		if (
			!after ||
			after.active ||
			!sameInternalContext(after.context, record.original.context) ||
			!(await current(request, deps, control, false))
		)
			return uncertain("Internal context restoration did not verify");
		await write(
			parseInternalContextAuthority(
				{
					...record,
					desired: record.original.context,
					phase: "parked",
					activationOwned: false,
					adoptedActive: false,
				},
				record.key,
			),
		);
		return (await current(request, deps, control, false))
			? { confirmed: true, value: true }
			: uncertain("Restored context lost its identity after commit");
	});
}

/** Production entrypoint uses the existing identity lease and durable journal.
 * Inverse replay may call the lower-level effects only while its existing
 * recovery owner holds that journal key. No new retry owner is introduced.
 */
export async function journalInternalContextEffects(
	stableKey: string,
	operation: InternalContextOperation,
	raw: InternalContextRequest,
	control: CellularControl,
	deps: InternalContextEffectsDeps,
	journal: typeof withJournaledModemMutation = withJournaledModemMutation,
): Promise<boolean> {
	if (!["activate", "deactivate", "restore", "park"].includes(operation))
		throw new Error("Unknown internal context operation");
	const request = captureRequest(raw),
		bounded: InternalContextEffectsDeps = {
			...deps,
			identity: async () => {
				const identity = await deps.identity();
				return identity?.stableKey === stableKey ? identity : undefined;
			},
		},
		baseline = Object.freeze({
			format: "cellular-internal-context-v1",
			unit: request.unit,
			subscription: request.subscription,
			cid: request.cid,
			contextKey: internalContextAuthorityKey(request.unit, request.cid),
		});
	try {
		const identity = await bounded.identity();
		if (
			!deps.owned() ||
			!deps.withdrawn() ||
			!(await control.valid()) ||
			identity?.unit !== request.unit ||
			!/^[a-f0-9]{64}$/.test(identity.subscription) ||
			(operation !== "park" &&
				identity.subscription !== request.subscription) ||
			(operation === "activate" && !(await deps.current()))
		)
			return false;
	} catch {
		return false;
	}
	const result = await journal(
		stableKey,
		"modem-config",
		baseline,
		async (mutation) => {
			if (operation === "park")
				return {
					confirmed: true,
					value: await parkChangedInternalContextEffects(
						request,
						control,
						bounded,
					),
				};
			const effect =
				operation === "activate"
					? ensureInternalContextEffects
					: operation === "deactivate"
						? deactivateInternalContextEffects
						: restoreInternalContextEffects;
			return effect(request, control, mutation, bounded);
		},
	);
	return result.ok && result.value;
}
