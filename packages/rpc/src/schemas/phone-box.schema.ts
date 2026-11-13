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
