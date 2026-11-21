import { z } from 'zod';

export const moblinkCredentialInputSchema = z.object({ password: z.string() });
export const moblinkStatusSchema = z.object({ available: z.boolean(), configured: z.boolean() });
export const moblinkResultSchema = z.object({
	success: z.boolean(),
	error: z.enum(['busy', 'unavailable', 'invalid', 'failed']).optional(),
});

export type MoblinkStatus = z.infer<typeof moblinkStatusSchema>;
export type MoblinkResult = z.infer<typeof moblinkResultSchema>;
