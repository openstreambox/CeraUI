import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Protocol name and transcript encoding for the paired companion channel.
 *
 * Every signature and MAC covers a transcript: the protocol name and a purpose
 * label, then each field as a 4-byte big-endian length and its bytes. Numbers
 * are 8-byte big-endian unsigned integers, strings are UTF-8. Distinct purpose
 * labels keep a signature made for one step from verifying as another.
 */
export const COMPANION_PROTOCOL = "osb-companion/1";

export type TranscriptPurpose =
	| "box-hello"
	| "box-setup"
	| "claim"
	| "join"
	| "auth";
export type TranscriptField = Uint8Array | string | number | boolean;

function encodeField(field: TranscriptField): Buffer {
	if (typeof field === "string") return Buffer.from(field, "utf8");
	if (typeof field === "boolean") return Buffer.from([field ? 1 : 0]);
	if (typeof field === "number") {
		if (!Number.isSafeInteger(field) || field < 0)
			throw Error("Transcript numbers are non-negative safe integers");
		const out = Buffer.alloc(8);
		out.writeBigUInt64BE(BigInt(field));
		return out;
	}
	return Buffer.from(field);
}

export function transcript(
	purpose: TranscriptPurpose,
	fields: readonly TranscriptField[],
): Buffer {
	const parts: Buffer[] = [Buffer.from(`${COMPANION_PROTOCOL} ${purpose}`)];
	for (const field of fields) {
		const bytes = encodeField(field);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(bytes.length);
		parts.push(length, bytes);
	}
	return Buffer.concat(parts);
}

/** SHA-256 of a DER SubjectPublicKeyInfo, as lowercase hex. */
export function keyFingerprint(spki: Uint8Array): string {
	return createHash("sha256").update(spki).digest("hex");
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && timingSafeEqual(a, b);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict standard base64 with an exact decoded length range. */
export function decodeBase64(
	value: unknown,
	minBytes: number,
	maxBytes = minBytes,
): Buffer | undefined {
	if (typeof value !== "string" || value.length > 4 * maxBytes)
		return undefined;
	if (value.length % 4 !== 0 || !BASE64.test(value)) return undefined;
	const bytes = Buffer.from(value, "base64");
	if (bytes.toString("base64") !== value) return undefined;
	return bytes.length >= minBytes && bytes.length <= maxBytes
		? bytes
		: undefined;
}
