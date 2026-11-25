import { z } from 'zod';

import { modemMutationRefusalSchema } from './modems.schema';

/**
 * Restart modem: which models may be restarted from software, and how long the
 * link is expected to be gone.
 *
 * This table is the only allowlist. A model is listed only after a bench run
 * showed that ModemManager's reset brings it back with its SIM, carrier
 * configuration and connection profile intact, and that nothing got stuck:
 *
 *   DW5821e    slot module on a ROCK 5B+, `mmcli --reset` back connected after
 *              32.5 to 32.8 s (3 runs); a USB rebind after 13.4 s (2 runs).
 *   RM520N-GL  on the USB-C data port, `mmcli --reset` back connected after
 *              51.5 to 53.6 s (3 runs); a USB rebind after 24 to 24.8 s (2 runs).
 *
 * The FM350-GL is deliberately absent: ModemManager answers `Unsupported` to its
 * reset, and its recorded USB behaviour includes crash and reset loops. Anything
 * not listed keeps the "unplug it and plug it back in" advice.
 *
 * `expectedSeconds` is what the confirmation tells the operator: how long the
 * link is out of the bond. `boundSeconds` is how long the backend waits for the
 * modem to show up again in its own modem list, connected, before it reports
 * that it did not. That list follows ModemManager through the status poll, which
 * lagged the link by up to about 35 s on the bench, so the bound is the slowest
 * measured restart plus two poll periods, rounded up.
 */
export const MODEM_RESTART_MODELS = [
	{
		family: 'dw5821e',
		pattern: /^DW5821e\b/i,
		usbIds: ['413c:81d7'],
		expectedSeconds: 35,
		boundSeconds: 120,
	},
	{
		family: 'rm520n-gl',
		pattern: /^RM520N-GL\b/i,
		usbIds: ['2c7c:0801'],
		expectedSeconds: 55,
		boundSeconds: 150,
	},
] as const;

export type ModemRestartFamily = (typeof MODEM_RESTART_MODELS)[number]['family'];

export type ModemRestartQualification = {
	readonly family: ModemRestartFamily;
	/** USB `vendor:product` ids a USB rebind may act on for this model. */
	readonly usbIds: readonly string[];
	readonly expectedSeconds: number;
	readonly boundSeconds: number;
};

/** The qualification for a ModemManager model string, or undefined when it has none. */
export function modemRestartQualification(
	model: string | undefined,
): ModemRestartQualification | undefined {
	if (!model) return undefined;
	const entry = MODEM_RESTART_MODELS.find((candidate) => candidate.pattern.test(model.trim()));
	return entry === undefined
		? undefined
		: {
				family: entry.family,
				usbIds: entry.usbIds,
				expectedSeconds: entry.expectedSeconds,
				boundSeconds: entry.boundSeconds,
			};
}

/** Seconds a modem must rest after a restart attempt before the next one. */
export const MODEM_RESTART_COOLDOWN_SECONDS = 180;

export const restartModemInputSchema = z
	.object({
		/** The ModemManager index ("2") or object path, as every modem procedure takes. */
		device: z.string().min(1),
		/**
		 * The `stable_key` of the modem the operator confirmed. The index alone can
		 * name a different modem by the time the request lands (a replug or another
		 * restart renumbers them), so a mismatch is refused as `unknown_modem`.
		 */
		stableKey: z.string().min(1),
		confirm: z.literal(true),
		/**
		 * The operator confirmed that this modem is the only connection carrying
		 * the running stream, and that the stream stops sending until it is back.
		 * Without it such a restart is refused with `only_link_live`.
		 */
		onlyLinkConfirmed: z.boolean().optional(),
	})
	.strict();
export type RestartModemInput = z.infer<typeof restartModemInputSchema>;

/**
 * Why a restart was not started.
 *
 *   unknown_modem        no modem answers to that selector.
 *   not_qualified        this model has no bench-qualified software restart.
 *   restart_in_progress  another modem is restarting; one at a time.
 *   cooldown             this modem restarted less than three minutes ago.
 *   only_link_live       a stream is running and no other connection carries it.
 *
 * Plus every shared modem-safety refusal (another change on this modem, journal
 * replay, a blocked identity, a stream being launched).
 */
export const restartModemRefusalSchema = z.enum([
	...modemMutationRefusalSchema.options,
	'unknown_modem',
	'not_qualified',
	'restart_in_progress',
	'cooldown',
	'only_link_live',
]);
export type RestartModemRefusal = z.infer<typeof restartModemRefusalSchema>;

/**
 * What happened once a restart was started.
 *
 *   back_connected      the same modem (same USB port) is listed again and connected.
 *   back_not_connected  it is listed again but not connected within the wait.
 *   not_back            no modem on that port within the wait.
 *   unchanged           ModemManager accepted the reset, but the modem never left
 *                       its index within the wait, so nothing proves it restarted.
 *   failed              ModemManager refused the reset and the USB rebind did not run or failed.
 */
export const restartModemOutcomeSchema = z.enum([
	'back_connected',
	'back_not_connected',
	'not_back',
	'unchanged',
	'failed',
]);
export type RestartModemOutcome = z.infer<typeof restartModemOutcomeSchema>;

export const restartModemMethodSchema = z.enum(['mm-reset', 'usb-rebind']);
export type RestartModemMethod = z.infer<typeof restartModemMethodSchema>;

export const restartModemOutputSchema = z.object({
	started: z.boolean(),
	refusal: restartModemRefusalSchema.optional(),
	/** `cooldown` only: seconds until this modem may restart again. */
	retryAfterSeconds: z.number().int().nonnegative().optional(),
	outcome: restartModemOutcomeSchema.optional(),
	method: restartModemMethodSchema.optional(),
	/** Seconds from the command until the outcome was decided. */
	elapsedSeconds: z.number().nonnegative().optional(),
	/** The ModemManager index the modem came back under. */
	device: z.string().optional(),
	/** `back_not_connected` only: the connection state it was in. */
	connection: z.string().optional(),
});
export type RestartModemOutput = z.infer<typeof restartModemOutputSchema>;
