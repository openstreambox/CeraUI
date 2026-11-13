import { z } from "zod";
import { accessCellularAuthority } from "./cellular-authority-store.ts";
import { preparationKey } from "./cellular-preparation-state.ts";
import {
	type InternalContext,
	internalContextCommand,
} from "./transport-policy.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const contextSchema = z
	.object({
		apn: z.string().max(100),
		family: z.enum(["ipv4", "ipv6", "ipv4v6"]),
		settings: z.array(z.string().max(128)).max(16).optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		try {
			internalContextCommand(1, value.apn, value.family, value.settings);
		} catch {
			ctx.addIssue({ code: "custom", message: "Invalid retained context" });
		}
	})
	.transform(
		({ apn, family, settings }): InternalContext => ({
			apn,
			family,
			...(settings === undefined ? {} : { settings }),
		}),
	);
const recordSchema = z
	.object({
		version: z.literal(1),
		key: digest,
		unit: digest,
		cid: z.number().int().min(1).max(16),
		/** The first subscription's baseline never becomes the next SIM's policy. */
		original: z
			.object({
				subscription: digest,
				context: contextSchema,
				active: z.boolean(),
			})
			.strict(),
		subscription: digest,
		before: contextSchema,
		desired: contextSchema,
		phase: z.enum([
			"baseline",
			"defining",
			"defined",
			"activating",
			"active",
			"parked",
		]),
		activationOwned: z.boolean(),
		adoptedActive: z.boolean(),
	})
	.strict();
export type InternalContextAuthority = z.infer<typeof recordSchema>;
export interface InternalContextRequest {
	readonly unit: string;
	readonly subscription: string;
	readonly cid: number;
	/** Already selected from current subscription/home policy, never a unit APN. */
	readonly desired: InternalContext;
}

export function internalContextAuthorityKey(unit: string, cid: number): string {
	digest.parse(unit);
	if (!Number.isInteger(cid) || cid < 1 || cid > 16)
		throw new Error("Invalid internal context slot");
	return preparationKey("internal-context", unit, String(cid));
}
export function parseInternalContextAuthority(
	value: unknown,
	key: string,
): InternalContextAuthority {
	const record = recordSchema.parse(value);
	if (
		record.key !== key ||
		internalContextAuthorityKey(record.unit, record.cid) !== key
	)
		throw new Error("Retained context belongs to another unit or slot");
	if (
		record.phase === "parked" &&
		(record.activationOwned || record.adoptedActive)
	)
		throw new Error("Parked context still claims an active call");
	if (
		(record.phase === "activating" && !record.activationOwned) ||
		(record.phase === "active" &&
			!record.activationOwned &&
			!record.adoptedActive)
	)
		throw new Error("Active context has no admitted activation");
	return record;
}
export function sameInternalContext(
	a: InternalContext,
	b: InternalContext,
): boolean {
	return (
		a.apn === b.apn &&
		a.family === b.family &&
		JSON.stringify(a.settings ?? []) === JSON.stringify(b.settings ?? [])
	);
}
function copyContext(value: InternalContext): InternalContext {
	contextSchema.parse(value);
	return Object.freeze({
		...value,
		...(value.settings ? { settings: Object.freeze([...value.settings]) } : {}),
	});
}
/** Pure baseline/transfer admission. The caller must persist this record before
 * any definition or activation and hold the existing mutation/unit authority.
 * A parked definition can transfer; an active or foreign definition cannot.
 */
export function planInternalContextAuthority(
	request: InternalContextRequest,
	observed: InternalContext,
	active: boolean,
	previous?: InternalContextAuthority,
): InternalContextAuthority | undefined {
	if (typeof active !== "boolean") return undefined;
	const key = internalContextAuthorityKey(request.unit, request.cid);
	digest.parse(request.subscription);
	const before = copyContext(observed),
		desired = copyContext({
			...request.desired,
			...(request.desired.settings === undefined &&
			observed.settings !== undefined
				? { settings: observed.settings }
				: {}),
		});
	if (!previous) {
		if (active && !sameInternalContext(before, desired)) return undefined;
		return parseInternalContextAuthority(
			{
				version: 1,
				key,
				unit: request.unit,
				cid: request.cid,
				original: {
					subscription: request.subscription,
					context: before,
					active,
				},
				subscription: request.subscription,
				before,
				desired,
				phase: "baseline",
				activationOwned: false,
				adoptedActive: active,
			},
			key,
		);
	}
	const retained = parseInternalContextAuthority(previous, key),
		sameRequest =
			retained.subscription === request.subscription &&
			sameInternalContext(retained.desired, desired);
	if (sameRequest && retained.phase !== "parked") {
		const desiredPresent = sameInternalContext(before, retained.desired),
			definitionPending =
				retained.phase === "baseline" || retained.phase === "defining";
		if (
			(!desiredPresent &&
				!(definitionPending && sameInternalContext(before, retained.before))) ||
			(active && !desiredPresent)
		)
			return undefined;
		return retained;
	}
	if (
		retained.phase !== "parked" ||
		active ||
		!sameInternalContext(before, retained.desired)
	)
		return undefined;
	return parseInternalContextAuthority(
		{
			...retained,
			subscription: request.subscription,
			before,
			desired,
			phase: "baseline",
			activationOwned: false,
			adoptedActive: false,
		},
		key,
	);
}

/** Read-only parking requires positive inactive, exact-owned context evidence.
 * It never restores the original APN, deactivates a different SIM or erases the
 * unit baseline. The caller additionally proves current physical/subscriber state.
 */
export function parkInternalContextAuthority(
	previous: InternalContextAuthority,
	observed: InternalContext,
	active: boolean,
): InternalContextAuthority | undefined {
	const retained = parseInternalContextAuthority(previous, previous.key);
	contextSchema.parse(observed);
	if (active !== false || !sameInternalContext(observed, retained.desired))
		return undefined;
	return parseInternalContextAuthority(
		{
			...retained,
			phase: "parked",
			activationOwned: false,
			adoptedActive: false,
		},
		retained.key,
	);
}

/** Default storage shares the cellular authority migration, revision and fault
 * barrier. This is storage, not another mutation, recovery or modem owner.
 */
export function accessInternalContextAuthority<T>(
	unit: string,
	cid: number,
	operation: (
		value: InternalContextAuthority | undefined,
		write: (value: InternalContextAuthority | undefined) => Promise<void>,
	) => Promise<T>,
): Promise<T> {
	return accessCellularAuthority(
		"cellular-internal-context",
		internalContextAuthorityKey(unit, cid),
		parseInternalContextAuthority,
		operation,
		process.env.CERALIVE_CELLULAR_INTERNAL_CONTEXT_STATE_DIR,
	);
}
