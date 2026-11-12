import { createHash } from "node:crypto";
import { z } from "zod";

const family = z.enum(["ipv4", "ipv6", "ipv4v6"]);
const settings = z.object({ apn: z.string().max(100), family }).strict();
const recordSchema = z.discriminatedUnion("kind", [
	z
		.object({
			version: z.literal(1),
			kind: z.literal("raw"),
			key: z.string(),
			original: z.enum(["Y", "N"]),
			epoch: z.string(),
			phase: z.enum(["baseline", "verified"]),
		})
		.strict(),
	z
		.object({
			version: z.literal(1),
			kind: z.literal("profile"),
			key: z.string(),
			original: z.enum(["yes", "no"]),
			birth: z.boolean(),
			originalAuto: z.enum(["yes", "no"]),
			originalApn: z.string().max(256),
		})
		.strict(),
	z
		.object({
			version: z.literal(1),
			kind: z.literal("qmap"),
			key: z.string(),
			original: z.number().int().min(0).max(65535),
			phase: z.enum(["baseline", "awaiting-usb", "verified", "blocked"]),
			epoch: z.string(),
			started: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			version: z.literal(1),
			kind: z.literal("eps"),
			key: z.string(),
			original: settings,
			desired: settings,
			attempted: z.boolean(),
			phase: z.enum(["baseline", "awaiting-usb", "verified", "blocked"]),
			epoch: z.string(),
			started: z.number().int().nonnegative(),
		})
		.strict(),
]);
export type PreparationRecord = z.infer<typeof recordSchema>;
export const preparationKey = (...parts: readonly string[]) => {
	if (parts.some((part) => !part || part.length > 2048))
		throw new Error("Unresolved preparation identity");
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
};
export function parsePreparationRecord(
	value: unknown,
	key: string,
): PreparationRecord {
	const record = recordSchema.parse(value);
	if (record.key !== key)
		throw new Error("Preparation authority belongs to another identity");
	return record;
}
