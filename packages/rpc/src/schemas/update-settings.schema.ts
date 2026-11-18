import { z } from 'zod';

const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const updateScheduleSchema = z
	.object({
		mode: z.enum(['any-idle', 'window']).default('any-idle'),
		start: timeOfDaySchema.default('03:00'),
		end: timeOfDaySchema.default('05:00'),
	})
	.strict();

export const updateChannelUrlSchema = z.url().refine((value) => {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	return (
		url.protocol === 'https:' &&
		!url.username &&
		!url.password &&
		!url.search &&
		!url.hash &&
		(url.pathname === '/' || !url.pathname.endsWith('/'))
	);
}, 'Use an HTTPS base address without credentials, query, fragment or trailing slash');

export const updateSettingsSchema = z
	.object({
		channelUrl: updateChannelUrlSchema.optional(),
		packagesAuto: z.boolean().default(true),
		systemAuto: z.boolean().default(true),
		schedule: updateScheduleSchema.default({ mode: 'any-idle', start: '03:00', end: '05:00' }),
		channel: z.enum(['stable', 'beta']).default('beta'),
		allowPackagesOverCellular: z.boolean().default(true),
		allowSystemOverCellular: z.boolean().default(false),
	})
	.strict();

export const updateSettingsInputSchema = updateSettingsSchema
	.required()
	.extend({ channelUrl: updateChannelUrlSchema.optional() });
export type UpdateSettings = z.infer<typeof updateSettingsSchema>;
