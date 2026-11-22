import { z } from 'zod';

/**
 * "Is the box ready to go live?" One yes/no plus the reason, for the UI, the
 * support log and the box's own status screen.
 *
 * Four checks feed it. Each check is `ok`, `blocked` or `unknown`; only a
 * `blocked` check makes `ready` false. `unknown` means nothing was measured
 * (for example, a receiver nobody has tested yet) and is reported, not hidden.
 *
 *  - `lock`: something the Start button would refuse right now (an update
 *    committing, recovery replay, a modem change in flight, a start already
 *    running).
 *  - `source`: the configured video source resolves the same way a Start
 *    would resolve it.
 *  - `receiver`: a destination is set; the last reachability test of that
 *    destination, if any, did not fail.
 *  - `uplinks`: before going live, at least one uplink passes its health
 *    check; while live, not every bonded link is sending nothing.
 *
 * Codes are machine tokens, never rendered raw; the UI maps them to text.
 */
export const streamReadinessCheckIdSchema = z.enum(['lock', 'source', 'receiver', 'uplinks']);
export type StreamReadinessCheckId = z.infer<typeof streamReadinessCheckIdSchema>;

export const streamReadinessCheckStateSchema = z.enum(['ok', 'blocked', 'unknown']);
export type StreamReadinessCheckState = z.infer<typeof streamReadinessCheckStateSchema>;

export const streamReadinessCheckSchema = z.object({
	id: streamReadinessCheckIdSchema,
	state: streamReadinessCheckStateSchema,
	/** Why the check is not `ok`; absent when it is. */
	code: z.string().min(1).max(64).optional(),
});
export type StreamReadinessCheck = z.infer<typeof streamReadinessCheckSchema>;

export const streamReadinessSchema = z.object({
	ready: z.boolean(),
	/** True while a stream runs; `ready` then means "the stream has a carrying link". */
	live: z.boolean(),
	/**
	 * The first blocking check and its code, or the first `unknown` one when
	 * nothing blocks, or absent when every check is `ok`.
	 */
	reason: z
		.object({
			check: streamReadinessCheckIdSchema,
			code: z.string().min(1).max(64),
		})
		.optional(),
	/** In a fixed order: lock, source, receiver, uplinks. */
	checks: z.array(streamReadinessCheckSchema).length(4),
	/** Uplinks that pass (idle) or carry (live), and how many were considered. */
	uplinks: z.object({
		usable: z.number().int().nonnegative(),
		total: z.number().int().nonnegative(),
	}),
	/** Unix milliseconds of the evaluation. */
	at: z.number().nonnegative(),
});
export type StreamReadiness = z.infer<typeof streamReadinessSchema>;

export const STREAM_READINESS_EVENT = 'stream_readiness' as const;
