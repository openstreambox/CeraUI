import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { generateP256, spkiOf } from "./keys.ts";
import { keyFingerprint } from "./transcript.ts";

/**
 * The box side of the companion channel's key store.
 *
 * Lives in one root-only directory on the data partition (default
 * `/data/ceralive/companion`), next to the per-device TLS key, so it survives
 * reboots and A/B slot switches and goes away with a reflash. Two files:
 *
 * - `identity.key`: the box identity key (P-256, PKCS#8 PEM, 0600). Made once.
 *   Companions pin its fingerprint. It is separate from the TLS key because
 *   the image replaces the TLS key when the hostname changes; the identity key
 *   endorses whichever TLS key is current.
 * - `state.json`: ownership generation, access sequence, the unused setup
 *   verifier (claim public key and setup proof key), retired claim keys and
 *   the device roster. Written atomically (temp file, fsync, rename, fsync).
 *
 * A malformed or unreadable store never resets itself: the channel reports
 * itself unavailable until someone repairs or resets it deliberately, so a
 * damaged file cannot reopen setup.
 */
export const DEFAULT_COMPANION_STATE_DIR = "/data/ceralive/companion";

const deviceSchema = z
	.object({
		id: z.string().regex(/^dev-[0-9a-f]{16}$/),
		key: z.string().min(1).max(256),
		fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
		name: z.string().min(1).max(64),
		kind: z.enum(["phone", "pc", "companion"]),
		role: z.literal("owner"),
		added_at: z.string(),
		added_by: z.string(),
		revoked_at: z.string().optional(),
	})
	.strict();

const stateSchema = z
	.object({
		format: z.literal("osb-companion-state"),
		v: z.literal(1),
		generation: z.number().int().min(1),
		access_seq: z.number().int().min(0),
		setup: z
			.object({
				setup_id: z.string(),
				claim_key: z.string().min(1).max(128),
				proof_key: z.string().length(44),
			})
			.strict()
			.nullable(),
		retired_claims: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(1024),
		devices: z.array(deviceSchema).max(64),
	})
	.strict();

export type CompanionState = z.infer<typeof stateSchema>;
export type DeviceRecord = z.infer<typeof deviceSchema>;

export class CompanionStoreError extends Error {}

export function freshState(): CompanionState {
	return {
		format: "osb-companion-state",
		v: 1,
		generation: 1,
		access_seq: 0,
		setup: null,
		retired_claims: [],
		devices: [],
	};
}

export interface BoxIdentity {
	privateKey: ReturnType<typeof createPrivateKey>;
	publicKey: Buffer;
	fingerprint: string;
}

export class CompanionStore {
	#identity: BoxIdentity | undefined;

	constructor(readonly dir: string) {}

	#ensureDir() {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const stat = lstatSync(this.dir);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new CompanionStoreError("Companion store is not a directory");
		chmodSync(this.dir, 0o700);
	}

	identity(): BoxIdentity {
		if (this.#identity) return this.#identity;
		this.#ensureDir();
		const path = join(this.dir, "identity.key");
		let pem: string;
		try {
			pem = readFileSync(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw new CompanionStoreError("Identity key unreadable");
			const made = generateP256();
			pem = String(made.privateKey.export({ type: "pkcs8", format: "pem" }));
			writeExclusive(path, pem);
		}
		let privateKey: BoxIdentity["privateKey"];
		try {
			privateKey = createPrivateKey(pem);
		} catch {
			throw new CompanionStoreError("Identity key malformed");
		}
		if (privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1")
			throw new CompanionStoreError("Identity key is not P-256");
		const publicKey = spkiOf(createPublicKey(privateKey));
		this.#identity = {
			privateKey,
			publicKey,
			fingerprint: keyFingerprint(publicKey),
		};
		return this.#identity;
	}

	read(): CompanionState {
		this.#ensureDir();
		let text: string;
		try {
			text = readFileSync(join(this.dir, "state.json"), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return freshState();
			throw new CompanionStoreError("Companion state unreadable");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new CompanionStoreError("Companion state malformed");
		}
		const result = stateSchema.safeParse(parsed);
		if (!result.success)
			throw new CompanionStoreError("Companion state malformed");
		return result.data;
	}

	/** Durable once this returns: the caller may acknowledge afterwards. */
	write(state: CompanionState): void {
		this.#ensureDir();
		const checked = stateSchema.parse(state);
		const path = join(this.dir, "state.json");
		const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
		try {
			writeExclusive(temp, `${JSON.stringify(checked, null, "\t")}\n`);
			renameSync(temp, path);
		} catch (error) {
			rmSync(temp, { force: true });
			throw error;
		}
		const dir = openSync(this.dir, "r");
		try {
			fsyncSync(dir);
		} finally {
			closeSync(dir);
		}
	}
}

function writeExclusive(path: string, text: string) {
	const fd = openSync(path, "wx", 0o600);
	try {
		writeFileSync(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
