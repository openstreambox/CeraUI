import { describe, expect, test } from 'bun:test';
import {
	configMessageSchema,
	streamingConfigInputSchema,
	streamingSetConfigOutputSchema,
	streamingStartOutputSchemaExtended,
} from './streaming.schema.ts';

describe('write-only Stream ID contract', () => {
	const keys = { srt_streamid: 'dummy-publish-key', relay_streamid_override: 'dummy-override' };
	test('accepts omission, replace and explicit clear', () => {
		for (const input of [{}, keys, { srt_streamid: '', relay_streamid_override: '' }])
			expect(streamingConfigInputSchema.parse(input)).toEqual({
				relay_protocol: 'srtla',
				...input,
			});
	});
	test('strips raw keys from config and both applied replies', () => {
		const state = { srt_streamid_configured: true, relay_streamid_override_configured: true };
		expect(configMessageSchema.parse({ ...keys, ...state })).toEqual({
			relay_protocol: 'srtla',
			...state,
		});
		for (const schema of [streamingSetConfigOutputSchema, streamingStartOutputSchemaExtended]) {
			const reply = schema.parse({ success: true, applied: { ...keys, ...state } });
			expect(reply.applied).toMatchObject(state);
			expect(JSON.stringify(reply)).not.toContain('dummy-');
		}
	});
});
