import { z } from 'zod';
export const phoneWaySchema = z.enum(['moblin', 'srt', 'internet']);
export const phonePartSchema = z.enum([
	'cellular',
	'moblink',
	'srt-forward',
	'hotspot',
	'update-orchestrator-maintenance',
]);
export const phoneBoxSettingsSchema = z.object({
	way: phoneWaySchema.nullable(),
	srt: z.object({ address: z.string(), passphrase: z.string() }).nullable(),
});
export type PhoneWay = z.infer<typeof phoneWaySchema>;
export type PhoneBoxSettings = z.infer<typeof phoneBoxSettingsSchema>;
/**
 * Restart input. `acceptCarryingCost` records that the local operator read the
 * cost to a carried phone stream and chose to restart anyway. It never admits a
 * restart over the box's own encoder stream, an update or the startup check.
 */
export const rebootInputSchema = z
	.object({ acceptCarryingCost: z.literal(true).optional() })
	.strict()
	.optional();
export type RebootInput = z.infer<typeof rebootInputSchema>;
