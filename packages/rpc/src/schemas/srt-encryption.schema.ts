import { z } from 'zod';

/** libsrt counts UTF-8 bytes, not UTF-16 code units. Empty explicitly clears. */
export const srtPassphraseSchema = z.string().refine((value) => {
	const length = new TextEncoder().encode(value).length;
	return length === 0 || (length >= 10 && length <= 79);
}, 'SRT passphrase must contain 10–79 UTF-8 bytes');
export const srtKeyLengthSchema = z.union([z.literal(16), z.literal(24), z.literal(32)]);
export const DEFAULT_SRT_KEY_LENGTH = 16;

/**
 * The pinned producer has no encryption contract. Keep admission closed until
 * a published binding supplies both capability evidence and Start fields.
 * Do not infer support from an engine version or forward unknown IPC fields.
 */
export const SRT_OUTPUT_ENCRYPTION_AVAILABLE = false;
export function srtEncryptionUnavailable(input: {
	srt_passphrase?: string | undefined;
	srt_pbkeylen?: number | undefined;
}): boolean {
	return (
		!SRT_OUTPUT_ENCRYPTION_AVAILABLE &&
		(Boolean(input.srt_passphrase) || input.srt_pbkeylen !== undefined)
	);
}
