/**
 * Common Zod schemas shared across multiple domains
 */
import { z } from 'zod';

// Notification types
export const notificationTypeSchema = z.enum(['success', 'warning', 'error', 'info']);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

// Generic nullable helper
export const nullable = <T extends z.ZodTypeAny>(schema: T) => schema.nullable();

// Success response schema (common pattern)
export const successResponseSchema = z.object({
	success: z.boolean(),
	// Optional structured failure code, e.g. 'DEVICE_BUSY' from withDeviceLock.
	error: z.string().optional(),
});
export type SuccessResponse = z.infer<typeof successResponseSchema>;

// Error response schema
export const errorResponseSchema = z.object({
	success: z.literal(false),
	error: z.string(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const powerFailureReasonSchema = z.enum([
	'shutdown_inhibited',
	'other_users',
	'shutdown_unavailable',
	'shutdown_uncertain',
]);
export type PowerFailureReason = z.infer<typeof powerFailureReasonSchema>;
export const powerResponseSchema = successResponseSchema.extend({
	failureReason: powerFailureReasonSchema.optional(),
});

export type PowerResponse = z.infer<typeof powerResponseSchema>;
