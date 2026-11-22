import {
	createHmac,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	hkdfSync,
	type KeyObject,
	randomBytes,
	sign,
	verify,
} from "node:crypto";

import { COMPANION_PROTOCOL, constantTimeEqual } from "./transcript.ts";

/**
 * Key handling for the companion channel. Only primitives from the runtime's
 * crypto library (BoringSSL under Bun): HKDF-SHA256, HMAC-SHA256, Ed25519 and
 * ECDSA P-256 with SHA-256. Nothing here implements a primitive.
 *
 * - The box identity key and every device key are ECDSA P-256, because the
 *   phone key stores that keep a private key in hardware (Secure Enclave,
 *   StrongBox) only offer P-256. Signatures use the fixed 64-byte r||s
 *   encoding (IEEE P1363), as WebCrypto and CryptoKit produce.
 * - The one-time claim key is Ed25519, derived from the setup secret, so the
 *   box can hold only its public half.
 */

export const SETUP_SECRET_BYTES = 16;
const SETUP_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const SETUP_ID = /^[0-9A-HJKMNP-TV-Z]{6}$/;
const ED25519_PKCS8_PREFIX = Buffer.from(
	"302e020100300506032b657004220420",
	"hex",
);

export function newSetupId(): string {
	const bytes = randomBytes(6);
	return Array.from(bytes, (b) => SETUP_ID_ALPHABET[b & 31]).join("");
}

function setupKey(secret: Uint8Array, setupId: string, label: string): Buffer {
	if (secret.length !== SETUP_SECRET_BYTES || !SETUP_ID.test(setupId))
		throw Error("Invalid setup material");
	return Buffer.from(
		hkdfSync(
			"sha256",
			secret,
			Buffer.from(`${COMPANION_PROTOCOL} setup ${setupId}`),
			Buffer.from(label),
			32,
		),
	);
}

/** The one-time claim key. Its private half never exists on the box. */
export function deriveClaimKey(secret: Uint8Array, setupId: string) {
	const seed = setupKey(secret, setupId, "claim-ed25519");
	const privateKey = createPrivateKey({
		key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
		format: "der",
		type: "pkcs8",
	});
	return { privateKey, publicKey: spkiOf(createPublicKey(privateKey)) };
}

/**
 * The box's setup proof key. The box holds it until claim and uses it to show
 * a companion that it holds this box's setup material, which covers a QR that
 * does not carry the identity fingerprint (a card written before first boot).
 */
export function deriveSetupProofKey(secret: Uint8Array, setupId: string) {
	return setupKey(secret, setupId, "box-setup-proof");
}

export function spkiOf(key: KeyObject): Buffer {
	return Buffer.from(key.export({ type: "spki", format: "der" }));
}

export function generateP256(): { privateKey: KeyObject; publicKey: Buffer } {
	const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
	return { privateKey: pair.privateKey, publicKey: spkiOf(pair.publicKey) };
}

/** A P-256 public key from DER SPKI, or undefined for anything else. */
export function importP256(spki: Uint8Array): KeyObject | undefined {
	try {
		const key = createPublicKey({
			key: Buffer.from(spki),
			format: "der",
			type: "spki",
		});
		return key.asymmetricKeyType === "ec" &&
			key.asymmetricKeyDetails?.namedCurve === "prime256v1"
			? key
			: undefined;
	} catch {
		return undefined;
	}
}

export function importEd25519(spki: Uint8Array): KeyObject | undefined {
	try {
		const key = createPublicKey({
			key: Buffer.from(spki),
			format: "der",
			type: "spki",
		});
		return key.asymmetricKeyType === "ed25519" ? key : undefined;
	} catch {
		return undefined;
	}
}

export function signP256(privateKey: KeyObject, message: Uint8Array): Buffer {
	return sign("sha256", message, {
		key: privateKey,
		dsaEncoding: "ieee-p1363",
	});
}

export function verifyP256(
	publicKey: KeyObject,
	message: Uint8Array,
	signature: Uint8Array,
): boolean {
	if (signature.length !== 64) return false;
	try {
		return verify(
			"sha256",
			message,
			{ key: publicKey, dsaEncoding: "ieee-p1363" },
			signature,
		);
	} catch {
		return false;
	}
}

export function signEd25519(
	privateKey: KeyObject,
	message: Uint8Array,
): Buffer {
	return sign(null, message, privateKey);
}

export function verifyEd25519(
	publicKey: KeyObject,
	message: Uint8Array,
	signature: Uint8Array,
): boolean {
	if (signature.length !== 64) return false;
	try {
		return verify(null, message, publicKey, signature);
	} catch {
		return false;
	}
}

export function mac(key: Uint8Array, message: Uint8Array): Buffer {
	return createHmac("sha256", key).update(message).digest();
}

export function verifyMac(
	key: Uint8Array,
	message: Uint8Array,
	tag: Uint8Array,
): boolean {
	return constantTimeEqual(mac(key, message), tag);
}
