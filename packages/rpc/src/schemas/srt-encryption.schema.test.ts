import { describe, expect, it } from 'bun:test';
import {
	DEFAULT_SRT_KEY_LENGTH,
	srtEncryptionUnavailable,
	srtKeyLengthSchema,
	srtPassphraseSchema,
} from './srt-encryption.schema';
import {
	configMessageSchema,
	streamingConfigInputSchema,
	streamingSetConfigOutputSchema,
} from './streaming.schema';

describe('SRT output encryption admission', () => {
	it('validates byte boundaries without trimming secrets', () => {
		for (const size of [10, 79])
			expect(srtPassphraseSchema.safeParse('x'.repeat(size)).success).toBe(true);
		for (const size of [1, 9, 80])
			expect(srtPassphraseSchema.safeParse('x'.repeat(size)).success).toBe(false);
		expect(srtPassphraseSchema.parse('')).toBe('');
		expect(srtPassphraseSchema.safeParse('界'.repeat(27)).success).toBe(false);
		expect(srtPassphraseSchema.parse(' dummy secret ')).toBe(' dummy secret ');
	});
	it('accepts only AES key lengths and uses AES-128 by default', () => {
		expect(DEFAULT_SRT_KEY_LENGTH).toBe(16);
		for (const size of [16, 24, 32]) expect(srtKeyLengthSchema.parse(size)).toBe(size);
		for (const size of [0, 128, 17]) expect(srtKeyLengthSchema.safeParse(size).success).toBe(false);
	});
	it('keeps secrets write-only across config reply projections', () => {
		const input = streamingConfigInputSchema.parse({
			srt_passphrase: 'dummy-secret',
			srt_pbkeylen: 16,
		});
		expect(
			streamingSetConfigOutputSchema.parse({ success: true, applied: input }).applied,
		).not.toHaveProperty('srt_passphrase');
		expect(configMessageSchema.parse(input)).not.toHaveProperty('srt_passphrase');
		expect(srtEncryptionUnavailable(input)).toBe(true);
		expect(srtEncryptionUnavailable({ srt_pbkeylen: 32 })).toBe(true);
		expect(srtEncryptionUnavailable({ srt_passphrase: '' })).toBe(false);
		expect(srtEncryptionUnavailable({})).toBe(false);
	});
});
