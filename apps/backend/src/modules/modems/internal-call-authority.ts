import { z } from "zod";
import {
	type DurableInverseRecord,
	parseDurableInverseRecord,
} from "../../helpers/durable-inverse.ts";
import {
	listPrivateJsonKeys,
	readPrivateJson,
} from "../../helpers/private-json-state.ts";
import {
	type CellularHandoffPlan,
	cellularHandoffSteps,
	parseCellularHandoffPhysicalLink,
	parseCellularHandoffPlan,
} from "../network/cellular-host-handoff.ts";
import type { CellularPhysicalLink } from "../network/cellular-host-identity.ts";
import { accessCellularAuthority } from "./cellular-authority-store.ts";
import { preparationKey } from "./cellular-preparation-state.ts";
import {
	internalContextAuthorityKey,
	parseInternalContextAuthority,
} from "./internal-context-authority.ts";
import { noteMutationJournalReadFault } from "./mutation-journal-revision.ts";
import { resolveTransportQuirk } from "./transport-policy.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z
	.object({
		version: z.literal(1),
		key: digest,
		unit: digest,
		owner: digest,
		epoch: digest,
		bootId: z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
		stableKey: z
			.string()
			.min(1)
			.max(4096)
			.refine(
				(value) =>
					value.trim() === value &&
					[...value].every(
						(char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
					),
			),
		physical: z.unknown(),
		identity: z
			.object({
				model: z.string().min(1).max(256),
				firmware: z.string().min(1).max(256),
				mode: z.literal("rndis"),
			})
			.strict(),
		subscription: digest,
		cid: z.number().int().min(1).max(16),
		contextKey: digest,
		/** True only after the context record is durably observed or committed. */
		contextExpected: z.boolean(),
		phase: z.enum(["holding", "withdrawing"]),
		handoff: z.record(z.string(), z.unknown()).nullable(),
	})
	.strict();
export interface InternalCallAuthority
	extends Omit<z.infer<typeof schema>, "physical" | "handoff"> {
	readonly physical: CellularPhysicalLink;
	readonly handoff: DurableInverseRecord<CellularHandoffPlan> | null;
}
export function internalCallAuthorityKey(unit: string): string {
	digest.parse(unit);
	return preparationKey("internal-owner", unit);
}
export function parseInternalCallAuthority(
	raw: unknown,
	key: string,
): InternalCallAuthority {
	const value = schema.parse(raw),
		physical = parseCellularHandoffPhysicalLink(value.physical),
		handoff =
			value.handoff === null
				? null
				: parseDurableInverseRecord(
						value.handoff,
						parseCellularHandoffPlan,
						cellularHandoffSteps,
					);
	if (
		value.key !== key ||
		internalCallAuthorityKey(value.unit) !== key ||
		value.contextKey !== internalContextAuthorityKey(value.unit, value.cid)
	)
		throw new Error("Internal owner belongs to another unit or context slot");
	if (resolveTransportQuirk(value.identity)?.owner !== "internal-call")
		throw new Error("Unadmitted internal owner transport");
	if (
		handoff &&
		(handoff.owner !== value.owner ||
			handoff.epoch !== value.epoch ||
			handoff.plan.bootId !== value.bootId ||
			Object.keys(physical).some(
				(field) =>
					physical[field as keyof CellularPhysicalLink] !==
					handoff.plan.link[field as keyof CellularPhysicalLink],
			))
	)
		throw new Error("Internal owner and host handoff identities disagree");
	if (handoff?.phase === "withdrawing" && value.phase !== "withdrawing")
		throw new Error("Withdrawing host cannot resume an internal call");
	return { ...value, physical, handoff };
}
/** The whole retained handoff has one durable unit record and one caller-owned
 * physical lease. This accessor is storage only, not a retry or recovery owner.
 * Context APN policy stays in the current subscription request, not this record.
 */
export function accessInternalCallAuthority<T>(
	unit: string,
	operation: (
		value: InternalCallAuthority | undefined,
		write: (value: InternalCallAuthority | undefined) => Promise<void>,
	) => Promise<T>,
): Promise<T> {
	return accessCellularAuthority(
		"cellular-internal-owner",
		internalCallAuthorityKey(unit),
		parseInternalCallAuthority,
		operation,
		process.env.CERALIVE_CELLULAR_INTERNAL_OWNER_STATE_DIR,
	);
}
/** Read after the existing startup owner has completed authority migration.
 * A complete stable census is required; this never manufactures an owner.
 */
export async function listInternalCallAuthorities(): Promise<
	readonly InternalCallAuthority[]
> {
	try {
		const store = {
				dir:
					process.env.CERALIVE_CELLULAR_INTERNAL_OWNER_STATE_DIR ??
					"/data/ceralive/cellular-internal-owner",
			},
			keys = await listPrivateJsonKeys(store),
			rows: InternalCallAuthority[] = [];
		for (const key of keys) {
			// Read by the enumerated slot before a unit value can select another slot.
			const value = await readPrivateJson(store, key);
			if (value === undefined)
				throw new Error("Internal owner inventory changed");
			rows.push(parseInternalCallAuthority(value, key));
		}
		const contexts = {
			dir:
				process.env.CERALIVE_CELLULAR_INTERNAL_CONTEXT_STATE_DIR ??
				"/data/ceralive/cellular-internal-context",
		};
		for (const row of rows) {
			if (!row.contextExpected) continue;
			const value = await readPrivateJson(contexts, row.contextKey);
			if (value === undefined)
				throw new Error("Expected internal context authority is missing");
			parseInternalContextAuthority(value, row.contextKey);
		}
		if (
			JSON.stringify(keys) !== JSON.stringify(await listPrivateJsonKeys(store))
		)
			throw new Error("Internal owner inventory changed");
		return rows;
	} catch (error) {
		noteMutationJournalReadFault();
		throw error;
	}
}
