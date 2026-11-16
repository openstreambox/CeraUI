/**
 * Dev-only RPC schemas (NOT registered in production).
 *
 * `dev.emit` lets a test client trigger an arbitrary backend broadcast on demand
 * so Playwright can inject a conflicting `config`/`status` echo at a known time
 * (deterministic QA of the field-lock race-condition fix).
 *
 * The backend hard-gates this procedure on `NODE_ENV !== 'production'` at router
 * registration time — see apps/backend/src/rpc/router.ts.
 */
import { z } from 'zod';

export const devEmitInputSchema = z.object({
	type: z.string(),
	payload: z.unknown(),
});
export type DevEmitInput = z.infer<typeof devEmitInputSchema>;

export const devEmitOutputSchema = z.object({
	success: z.boolean(),
});
export type DevEmitOutput = z.infer<typeof devEmitOutputSchema>;

/**
 * `dev.scenario` — scripted mock scenarios for demos and screenshot tests.
 *
 * A scenario driver (never a browser page: the socket must carry the driver's
 * secret header at upgrade) pins the mock clock at a scenario time and applies
 * events to the mock state. Registered like `dev.emit`, outside production only,
 * and refused unless the backend runs on mocks.
 */
const ifaceSchema = z.string().regex(/^[a-z][a-z0-9]{0,14}$/);

export const devScenarioLinkEventSchema = z
	.object({
		type: z.literal('box.link'),
		iface: ifaceSchema,
		rtt_ms: z.number().min(0).max(10_000).optional(),
		nak_count: z.number().int().min(0).max(1_000_000).optional(),
		weight_scale: z.number().min(0).max(10).optional(),
		stale: z.boolean().optional(),
		gone: z.boolean().optional(),
		/** Drop earlier overrides on this link first; fields given with it then apply. */
		reset: z.literal(true).optional(),
	})
	.strict();

export const devScenarioBitrateEventSchema = z.union([
	z
		.object({
			type: z.literal('box.bitrate'),
			target_kbps: z.number().int().min(100).max(100_000),
		})
		.strict(),
	z.object({ type: z.literal('box.bitrate'), reset: z.literal(true) }).strict(),
]);

export const devScenarioModemEventSchema = z
	.object({
		type: z.literal('box.modem'),
		id: z.number().int().min(0).max(15),
		state: z.enum(['registered', 'connected', 'searching']),
	})
	.strict();

export const devScenarioEventSchema = z.union([
	devScenarioLinkEventSchema,
	devScenarioBitrateEventSchema,
	devScenarioModemEventSchema,
]);
export type DevScenarioEvent = z.infer<typeof devScenarioEventSchema>;

export const devScenarioApplyInputSchema = z
	.object({
		/** Scenario seed (32-bit unsigned). */
		seed: z.number().int().min(0).max(0xffff_ffff),
		/** Scenario time of this step, ms since the scenario started. */
		t_ms: z.number().int().min(0).max(86_400_000),
		events: z.array(devScenarioEventSchema).max(64).default([]),
	})
	.strict();
export type DevScenarioApplyInput = z.infer<typeof devScenarioApplyInputSchema>;

export const devScenarioLinkStateSchema = z.object({
	rtt_ms: z.number().optional(),
	nak_count: z.number().optional(),
	weight_scale: z.number().optional(),
	stale: z.boolean().optional(),
	gone: z.boolean().optional(),
});

export const devScenarioStatusSchema = z.object({
	pinned: z.boolean(),
	seed: z.number().nullable(),
	t_ms: z.number().nullable(),
	links: z.record(z.string(), devScenarioLinkStateSchema),
	bitrate_target_kbps: z.number().nullable(),
});
export type DevScenarioStatus = z.infer<typeof devScenarioStatusSchema>;

export const devScenarioOutputSchema = z.object({
	success: z.boolean(),
	/** Why a call was refused: not-mock, not-driver or production. */
	refused: z.enum(['production', 'not_mock', 'not_driver']).optional(),
	status: devScenarioStatusSchema.optional(),
});
export type DevScenarioOutput = z.infer<typeof devScenarioOutputSchema>;

export const devScenarioEmptyInputSchema = z.object({}).strict().optional();
