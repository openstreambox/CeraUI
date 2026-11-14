import { expect, test } from 'bun:test';
import { linkTelemetryMessageSchema } from './status.schema';

test('preserves the sender observation time across the RPC boundary', () => {
	expect(linkTelemetryMessageSchema.parse({ links: [], lastReadMs: 1234 }).lastReadMs).toBe(1234);
	expect(linkTelemetryMessageSchema.parse({ links: [] }).lastReadMs).toBeUndefined();
	expect(linkTelemetryMessageSchema.safeParse({ links: [], lastReadMs: -1 }).success).toBe(false);
});
