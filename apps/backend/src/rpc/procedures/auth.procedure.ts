/**
 * Authentication Procedures
 * Wraps existing auth logic from modules/ui/auth.ts
 */

import { timingSafeEqual } from "node:crypto";
import {
	localClaimInputSchema,
	loginInputSchema,
	loginOutputSchema,
	logoutOutputSchema,
	revokeTokenInputSchema,
	revokeTokenOutputSchema,
	setPasswordInputSchema,
	successResponseSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import type { AuthTokens } from "../../helpers/config-schemas.ts";
import { randomBase64 } from "../../helpers/crypto.ts";
import { logger } from "../../helpers/logger.ts";
import { isDevelopment } from "../../mocks/mock-config.ts";
import {
	closeSocketSession,
	getAuthenticatedClients,
	getClients,
} from "../context.ts";
import {
	getPasswordHash,
	localClaimEnabled,
	setPasswordHash,
} from "../state/password.ts";
import { PersistentTokenStore } from "../state/persistent-token-store.ts";
import type { AppWebSocket, RPCContext } from "../types.ts";

const AUTH_TOKENS_FILE = "auth_tokens.json";
const BCRYPT_ROUNDS = 10;

const TOKEN_RECORD_RE = /^[0-9a-f]{64}$/;

// Token storage
const tempTokens: Record<string, true> = {};
const tokenStore = await PersistentTokenStore.open(AUTH_TOKENS_FILE);
const persistentTokens: AuthTokens = tokenStore.records;

// Re-export for backward compatibility
export { getPasswordHash, setPasswordHash };

// `auth_tokens.json` used to hold tokens VERBATIM, so reading the file handed
// you a working credential for every remembered browser. A digest makes it a
// lookup table instead: a leak proves which credentials exist, not what they
// are. SHA-256 rather than a KDF because the token is 32 CSPRNG bytes — there
// is no guessable structure for a slow hash to defend, and every reconnect
// pays this.
function tokenRecord(token: string): string {
	return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

// Every write is revalidated against the file, so it also drops any inert
// pre-digest record that reread brought back.
function savePersistentTokens() {
	tokenStore.save();
}

// A pre-migration file holds raw tokens. They are already inert — lookup is
// keyed on the digest, which a base64 token cannot match — but leaving them
// keeps credential material on disk and makes "log out everywhere" count
// entries nothing can use. Returns false while the migration is still owed.
function pruneLegacyTokenRecords(): boolean {
	if (!tokenStore.prepareWrite()) return false;
	const legacy = Object.keys(persistentTokens).filter(
		(key) => !TOKEN_RECORD_RE.test(key),
	);
	if (legacy.length === 0) return true;
	for (const key of legacy) delete persistentTokens[key];
	savePersistentTokens();
	logger.info(
		`Auth: pruned ${legacy.length} pre-digest persistent token record(s); affected browsers re-authenticate with the password once`,
	);
	return true;
}

// The prune runs off a timer, so a write fault (EIO, ENOSPC) must not escape it
// and kill the backend; the file is left as it was and the prune is retried.
const LEGACY_PRUNE_RETRY_MS = [1000, 5000, 30_000, 60_000] as const;
let legacyPruneTimer: ReturnType<typeof setTimeout> | undefined;
let legacyPruneStopped = false;

function scheduleLegacyPrune(delay: number, attempt: number): void {
	if (legacyPruneStopped) return;
	legacyPruneTimer = setTimeout(() => {
		legacyPruneTimer = undefined;
		let done = false;
		try {
			done = pruneLegacyTokenRecords();
		} catch (error) {
			logger.warn("Auth: pre-digest token prune failed; retrying", { error });
		}
		const wait =
			LEGACY_PRUNE_RETRY_MS[
				Math.min(attempt, LEGACY_PRUNE_RETRY_MS.length - 1)
			];
		if (!done && wait !== undefined) scheduleLegacyPrune(wait, attempt + 1);
	}, delay);
	legacyPruneTimer.unref();
}

/** Shutdown: no further prune attempt may start. */
export function stopLegacyTokenMigration(): void {
	tokenStore.stop();
	legacyPruneStopped = true;
	clearTimeout(legacyPruneTimer);
	legacyPruneTimer = undefined;
}

if (!isDevelopment() && process.env.NODE_ENV !== "test")
	scheduleLegacyPrune(0, 0);

function genAuthToken(isPersistent: boolean): string {
	const token = randomBase64(32);
	// A store that could not be read yields a session that lasts this browser
	// visit; persisting would replace remembered memberships nobody has read. A
	// failed write does the same instead of failing the password login.
	if (isPersistent && tokenStore.prepareWrite()) {
		const record = tokenRecord(token);
		persistentTokens[record] = true;
		try {
			savePersistentTokens();
			return token;
		} catch (error) {
			delete persistentTokens[record];
			logger.warn(
				"Auth: remembered login not persisted; session is temporary",
				{
					error,
				},
			);
		}
	}
	tempTokens[token] = true;
	return token;
}

function knownToken(token: string): boolean {
	return (
		tempTokens[token] === true || persistentTokens[tokenRecord(token)] === true
	);
}

function closeRevokedPeer(ws: AppWebSocket): void {
	closeSocketSession(ws);
	ws.close(1008, "Session revoked");
}

function invalidateToken(token: string, caller: AppWebSocket): number {
	for (const ws of getAuthenticatedClients())
		if (ws !== caller && ws.data.authToken === token) closeRevokedPeer(ws);
	let revoked = 0;
	if (tempTokens[token]) {
		delete tempTokens[token];
		revoked += 1;
	}
	revoked += tokenStore.revoke(tokenRecord(token));
	return revoked;
}

function invalidateAllTokens(caller: AppWebSocket | undefined): number {
	for (const ws of getAuthenticatedClients())
		if (ws !== caller && ws.data.authToken !== undefined) closeRevokedPeer(ws);
	let revoked = 0;
	for (const token of Object.keys(tempTokens)) {
		delete tempTokens[token];
		revoked += 1;
	}
	revoked += tokenStore.revoke();
	return revoked;
}

/**
 * Physical reset (companion channel): forget the owner password and every
 * remembered or temporary session, closing every signed-in socket. The caller
 * must lock legacy first-password setup first (modules/companion/reset.ts).
 */
export async function clearLegacyCredentialsForReset(): Promise<number> {
	await tokenStore.settle();
	const { getConfig, saveConfig } = await import("../../modules/config.ts");
	const config = getConfig();
	setPasswordHash(undefined);
	config.password = undefined;
	saveConfig();
	return invalidateAllTokens(undefined);
}

/**
 * Mint a non-persistent session token for the single-use loopback kiosk
 * exchange (DC-3). Same in-memory temp-token store as a password login, so the
 * kiosk browser can authenticate the WebSocket with it. Not persisted to disk;
 * unrelated to the PASETO device token.
 */
export function issueKioskSessionToken(): string {
	return genAuthToken(false);
}

// Base procedure with context
const baseProcedure = os.$context<RPCContext>();

/**
 * Login procedure
 */
export const loginProcedure = baseProcedure
	.input(loginInputSchema)
	.output(loginOutputSchema)
	.handler(async ({ input, context }) => {
		await tokenStore.settle();
		const passwordHash = getPasswordHash();
		logger.debug(
			`Login attempt: passwordHash=${passwordHash ? "set" : "not set"}, input.password=${input.password ? "provided" : "none"}, input.token=${input.token ? "provided" : "none"}`,
		);
		if (!passwordHash) {
			logger.debug("Login failed: no password hash set");
			return { success: false };
		}

		// Password authentication
		if (input.password) {
			try {
				const match = await Bun.password.verify(
					input.password,
					passwordHash,
					"bcrypt",
				);
				if (match) {
					const token = genAuthToken(input.persistent_token);
					context.authenticate(token);
					logger.info("Auth: password login successful");
					return { success: true, auth_token: token };
				}
			} catch (_e) {
				// Password verification failed
			}
			logger.warn("Auth: invalid password");
			return { success: false };
		}

		// Token authentication
		if (input.token) {
			if (knownToken(input.token)) {
				context.authenticate(input.token);
				logger.info("Auth: token login successful");
				return { success: true };
			}
			logger.warn("Auth: invalid token");
			return { success: false };
		}

		return { success: false };
	});

/**
 * Set password procedure
 */
export const setPasswordProcedure = baseProcedure
	.input(setPasswordInputSchema)
	.output(successResponseSchema)
	.handler(async ({ input, context }) => {
		await tokenStore.settle();
		const { getConfig, saveConfig } = await import("../../modules/config.ts");
		const isAuthed = context.isAuthenticated();
		const currentHash = getPasswordHash();
		if (localClaimEnabled() && !currentHash) return { success: false };

		// Allow setting password if authenticated or if no password is set yet
		if (isAuthed || !currentHash) {
			// Lazy import to avoid circular dependency. Read config FIRST: while it
			// is unavailable this throws before the in-memory hash changes, so an
			// unknown stored password can never be replaced by a first-run claim.
			const config = getConfig();
			const newHash = Bun.password.hashSync(input.password, {
				algorithm: "bcrypt",
				cost: BCRYPT_ROUNDS,
			});
			setPasswordHash(newHash);
			config.password = undefined;
			saveConfig();

			// A credential issued against the OLD password must not outlive it —
			// otherwise changing the password after losing a device leaves that
			// device signed in. The calling socket is re-authenticated on a fresh
			// token so the operator who just changed it is not thrown out.
			context.deauthenticate();
			const revoked = invalidateAllTokens(context.ws);
			const replacement = genAuthToken(false);
			context.authenticate(replacement);
			logger.info(
				`Auth: password updated; revoked ${revoked} outstanding credential(s)`,
			);
			return { success: true };
		}

		return { success: false };
	});

export const claimLocalOwnerProcedure = baseProcedure
	.input(localClaimInputSchema)
	.output(successResponseSchema)
	.handler(async ({ input, context }) => {
		if (!localClaimEnabled() || context.ws.data.senderId !== undefined)
			return { success: false };

		await tokenStore.settle();
		const { commitLocalClaim, getLocalClaimDigest, settleLocalClaimWrite } =
			await import("../../modules/config.ts");
		const digest = getLocalClaimDigest();
		if (getPasswordHash() || !digest) return { success: false };

		const submitted = new Bun.CryptoHasher("sha256")
			.update(input.code)
			.digest();
		if (!timingSafeEqual(submitted, Buffer.from(digest, "hex"))) {
			return { success: false };
		}

		// No await from the eligibility check through the atomic commit. The
		// next request sees the owner hash and a spent code.
		const ownerHash = Bun.password.hashSync(input.ownerSecret, {
			algorithm: "bcrypt",
			cost: BCRYPT_ROUNDS,
		});
		// A pre-claim token store can survive a partial reset. Clear it before
		// publishing an owner hash that would make those tokens eligible again.
		invalidateAllTokens(context.ws);
		if (!tokenStore.writable) return { success: false };
		try {
			commitLocalClaim(ownerHash);
		} catch (error) {
			// Config writes stay frozen until the file says which state is on disk.
			// Answer from the file when it is readable; otherwise the recovery
			// owner reloads it and the caller's retained secret settles the claim.
			try {
				if (!(await settleLocalClaimWrite(ownerHash)))
					return { success: false };
			} catch {
				const { recoverRuntimeConfig } = await import(
					"../../modules/config-boot.ts"
				);
				recoverRuntimeConfig();
				throw error;
			}
		}
		closeStaleSetupPages(context.ws);
		return { success: true };
	});

/** Pages still showing setup reconnect and get the normal sign-in view. */
function closeStaleSetupPages(caller: AppWebSocket): void {
	for (const ws of getClients()) {
		if (ws === caller || ws.data.isAuthenticated) continue;
		if (ws.data.senderId !== undefined) continue;
		ws.close(1012, "Owner setup finished");
	}
}

/**
 * Logout procedure
 */
export const logoutProcedure = baseProcedure
	.output(logoutOutputSchema)
	.handler(async ({ context }) => {
		await tokenStore.settle();
		const token = context.ws.data.authToken;
		context.deauthenticate();
		if (token) {
			invalidateToken(token, context.ws);
		}
		logger.info("Auth: logout successful");
		return { success: true };
	});

// Gated here rather than by `authedProcedure`: every procedure in this file
// takes the raw context, because setPassword must also serve first-run setup.
export const revokeTokenProcedure = baseProcedure
	.input(revokeTokenInputSchema)
	.output(revokeTokenOutputSchema)
	.handler(async ({ input, context }) => {
		await tokenStore.settle();
		if (!context.isAuthenticated()) {
			logger.warn("Auth: revokeToken refused — socket is not authenticated");
			return { success: false, revoked: 0 };
		}

		if (input.scope === "all") {
			context.deauthenticate();
			const revoked = invalidateAllTokens(context.ws);
			logger.info(`Auth: revoked all ${revoked} credential(s)`);
			return { success: true, revoked };
		}

		const target = input.token ?? context.ws.data.authToken;
		if (target === undefined) {
			return { success: true, revoked: 0 };
		}

		// Only a socket revoking its OWN credential loses its session; retiring
		// some other browser's token must not sign the caller out.
		if (target === context.ws.data.authToken) {
			context.deauthenticate();
		}
		const revoked = invalidateToken(target, context.ws);
		logger.info(`Auth: revoked ${revoked} credential record(s)`);
		return { success: true, revoked };
	});
