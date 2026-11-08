import { z } from 'zod';

import { capabilityMutationRefusalSchema } from './modems.schema';

const hostSchema = z
	.string()
	.max(253)
	.regex(/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/);

/** Consumer activation codes. Optional fields carry the SM-DP+ OID and confirmation flag. */
export function parseEsimActivationCode(value: string):
	| {
			smdpAddress: string;
			matchingId: string;
			confirmationRequired: boolean;
	  }
	| undefined {
	const fields = value.trim().split('$');
	if (fields.length < 3 || fields.length > 5 || fields[0] !== 'LPA:1') return undefined;
	const smdpAddress = fields[1];
	const matchingId = fields[2];
	if (
		!hostSchema.safeParse(smdpAddress).success ||
		!matchingId ||
		!/^[-a-zA-Z0-9]{1,512}$/.test(matchingId)
	)
		return undefined;
	if (fields[3] && !/^\d+(?:\.\d+)+$/.test(fields[3])) return undefined;
	if (fields[4] !== undefined && fields[4] !== '' && fields[4] !== '0' && fields[4] !== '1')
		return undefined;
	return {
		smdpAddress: smdpAddress as string,
		matchingId,
		confirmationRequired: fields[4] === '1',
	};
}

export const esimActivationCodeSchema = z
	.string()
	.trim()
	.max(1024)
	.refine(
		(value) => parseEsimActivationCode(value) !== undefined,
		'Invalid consumer eSIM activation code',
	);

const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const esimProfileSchema = z.object({
	id: tokenSchema,
	name: z.string().max(128),
	provider: z.string().max(128),
	state: z.enum(['enabled', 'disabled']),
});
export const esimSnapshotSchema = z.object({
	token: tokenSchema,
	profiles: z.array(esimProfileSchema).max(100),
});
export type EsimSnapshot = z.infer<typeof esimSnapshotSchema>;

const target = { device: z.string().regex(/^\d{1,6}$/) };
const confirmed = { acknowledged: z.literal(true) };
const profileTarget = { ...target, ...confirmed, snapshot: tokenSchema, profileId: tokenSchema };

export const esimOperationInputSchema = z.discriminatedUnion('action', [
	z.object({ ...target, ...confirmed, action: z.literal('inspect') }).strict(),
	z
		.object({
			...target,
			...confirmed,
			action: z.literal('download'),
			snapshot: tokenSchema,
			activationCode: esimActivationCodeSchema,
			confirmationCode: z
				.string()
				.min(1)
				.max(128)
				.regex(/^[\x21-\x7e]+$/)
				.optional(),
		})
		.strict(),
	z.object({ ...profileTarget, action: z.literal('enable') }).strict(),
	z.object({ ...profileTarget, action: z.literal('disable') }).strict(),
	z.object({ ...profileTarget, action: z.literal('delete') }).strict(),
]);
export type EsimOperationInput = z.infer<typeof esimOperationInputSchema>;

export const esimErrorSchema = z.enum([
	...capabilityMutationRefusalSchema.options,
	'not_configured',
	'card_unavailable',
	'stale_snapshot',
	'profile_not_found',
	'active_profile',
	'confirmation_required',
	'operation_failed',
	'outcome_unknown',
]);
export type EsimError = z.infer<typeof esimErrorSchema>;
export const esimOperationOutputSchema = z.discriminatedUnion('success', [
	z.object({ success: z.literal(true), snapshot: esimSnapshotSchema }),
	z.object({ success: z.literal(false), error: esimErrorSchema }),
]);
export type EsimOperationOutput = z.infer<typeof esimOperationOutputSchema>;

export const ESIM_OPERATION_BOUND_MS = 240_000;
