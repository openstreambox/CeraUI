// Auth status store using Svelte 5 runes with manual subscriber pattern
// (Cannot use $effect in subscribe - it only works during component initialization)
import type {
	LocalClaimInput,
	LoginInput,
	LoginOutput,
	SetPasswordInput,
} from "@ceraui/rpc/schemas";

import { rpc, rpcClient } from "$lib/rpc/client";
import { NotSentError, RpcError } from "$lib/rpc/rpc-error";
import {
	clearAuthenticatedLink,
	getLinkEpoch,
	noteAuthenticatedLink,
} from "$lib/rpc/session-epoch.svelte";
import { push as pushNotification } from "$lib/stores/notifications.svelte";

let authStatus = $state(false);
let sessionExpired = $state(false);
let interaction = new AbortController();

export function getSessionExpired(): boolean {
	return sessionExpired;
}

export function setSessionExpired(expired: boolean): void {
	sessionExpired = expired;
}

export type AuthAttempt =
	// `remembered: false`: the device accepted the sign-in but this browser
	// refused to store the credential, so the session lasts only this visit.
	| { kind: "ok"; remembered?: false }
	| { kind: "rejected" }
	| { kind: "cancelled" }
	| {
			kind: "unreachable";
			cause: "socket-not-ready" | "rpc-error" | "timeout";
	  };

// Last login/create-password RESULT. Mutated ONLY by `ingestAuth` — the single
// auth-message write path that replaces the old AuthStore._set race.
let authMessage = $state<LoginOutput | undefined>(undefined);

// Manual subscriber management
type Subscriber = (status: boolean) => void;
// biome-ignore lint/nursery/useSvelteReactiveClasses: Imperative subscriptions notify synchronously; tracking Set reads would subscribe effects to listener registration.
const subscribers = new Set<Subscriber>();

function notifySubscribers(): void {
	for (const callback of subscribers) {
		callback(authStatus);
	}
}

export function getAuthStatus(): boolean {
	return authStatus;
}

export function setAuthStatus(status: boolean): void {
	if (!status) clearAuthenticatedLink();
	clearAuthInteraction();
	authStatus = status;
	notifySubscribers();
}

/** Retire local pending auth before notifying the interaction's field owner. */
export function clearAuthInteraction(): void {
	interaction.abort();
	interaction = new AbortController();
	notifySubscribers();
}

// Subscribe pattern compatible with Svelte store contract
export function subscribeAuthStatus(callback: Subscriber): () => void {
	subscribers.add(callback);
	// Call immediately with current value (standard store behavior)
	callback(authStatus);
	// Return unsubscribe function
	return () => {
		subscribers.delete(callback);
	};
}

// Legacy-compatible store-like object for easier migration
export const authStatusStore = {
	get value() {
		return authStatus;
	},
	set: setAuthStatus,
	subscribe: subscribeAuthStatus,
};

if (typeof window !== "undefined") {
	window.addEventListener("pagehide", clearAuthInteraction);
	window.addEventListener("pagehide", discardPendingClaim);
	window.addEventListener("pagehide", () => {
		visitToken = undefined;
	});
	window.addEventListener("pageshow", (event) => {
		if (event.persisted) clearAuthInteraction();
	});
}

export function getAuthMessage(): LoginOutput | undefined {
	return authMessage;
}

export function ingestAuth(message: LoginOutput | undefined): void {
	authMessage = message;
}

// The session token of a remembered sign-in this browser refused to store.
// Reconnect re-authentication falls back to it, so a dropped socket does not
// end the session before the page closes. Memory only, wiped on pagehide.
let visitToken: string | undefined;

/** The visit-scoped token, for reconnect re-authentication only. */
export function getVisitToken(): string | undefined {
	return visitToken;
}

/** Forget the visit-scoped token once the box rejects it. */
export function forgetVisitToken(rejected: string): void {
	if (visitToken === rejected) visitToken = undefined;
}

/** False when the browser refused storage; the live session still holds. */
function persistCredential(
	result: LoginOutput,
	persistentToken: boolean,
): boolean {
	try {
		if (!persistentToken) {
			localStorage.removeItem("auth");
		} else if (result.auth_token) {
			localStorage.setItem("auth", result.auth_token);
		}
		return true;
	} catch (error) {
		console.warn("Failed to store the sign-in:", error);
		return false;
	}
}

/** Whether this browser lets the page keep a remembered sign-in. */
export function canRememberSignIn(): boolean {
	try {
		const probe = "auth-storage-probe";
		localStorage.setItem(probe, "1");
		localStorage.removeItem(probe);
		return true;
	} catch {
		return false;
	}
}

// rpcClient.call() rejects synchronously on a non-OPEN socket, so the mount-time
// token login must wait for the connection first (the boot connect is async).
function whenSocketReady(signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	if (rpcClient.isConnected()) return Promise.resolve(true);
	return new Promise<boolean>((resolve) => {
		let settled = false;
		let unsubscribe: (() => void) | undefined;
		const finish = (ready: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe?.();
			signal.removeEventListener("abort", cancelled);
			resolve(ready);
		};
		const cancelled = () => finish(false);
		const timer = setTimeout(() => finish(false), 10_000);
		signal.addEventListener("abort", cancelled, { once: true });
		unsubscribe = rpcClient.onConnectionChange((state) => {
			if (state !== "connected" || settled) return;
			finish(true);
		});
	});
}

async function authenticateInput(
	input: LoginInput,
	cancelled?: AbortSignal,
): Promise<AuthAttempt> {
	const signal = AbortSignal.any([
		interaction.signal,
		...(cancelled ? [cancelled] : []),
	]);
	const clearPassword = () => {
		if (input.password !== undefined) input.password = "";
	};
	signal.addEventListener("abort", clearPassword, { once: true });
	const persistent = input.persistent_token;
	try {
		const ready = await whenSocketReady(signal);
		if (signal.aborted) return { kind: "cancelled" };
		if (!ready) {
			return { kind: "unreachable", cause: "socket-not-ready" };
		}
		let result: LoginOutput;
		const link = getLinkEpoch();
		try {
			const reply = rpc.auth.login(input);
			// The client serializes synchronously; the pending reply needs no plaintext.
			clearPassword();
			result = await reply;
		} catch (error) {
			if (signal.aborted) return { kind: "cancelled" };
			console.error("Failed to authenticate:", error);
			return {
				kind: "unreachable",
				cause:
					error instanceof Error && error.message.startsWith("Request timeout:")
						? "timeout"
						: "rpc-error",
			};
		}
		if (signal.aborted) return { kind: "cancelled" };
		if (link !== getLinkEpoch() || !rpcClient.isConnected()) {
			return { kind: "unreachable", cause: "rpc-error" };
		}
		if (!result.success) {
			ingestAuth(result);
			return { kind: "rejected" };
		}
		// Token reauthentication succeeds without issuing a replacement. In that
		// case retain the existing token, just as on an unreachable attempt.
		const remembered = persistCredential(result, persistent);
		if (persistent && result.auth_token)
			visitToken = remembered ? undefined : result.auth_token;
		ingestAuth(result);
		setSessionExpired(false);
		noteAuthenticatedLink(link);
		setAuthStatus(true);
		return remembered ? { kind: "ok" } : { kind: "ok", remembered: false };
	} finally {
		clearPassword();
		signal.removeEventListener("abort", clearPassword);
	}
}

export function authenticate(
	password: string,
	persistentToken: boolean,
	signal?: AbortSignal,
): Promise<AuthAttempt> {
	return authenticateInput(
		{ password, persistent_token: persistentToken },
		signal,
	);
}

export function authenticateWithToken(token: string): Promise<AuthAttempt> {
	return authenticateInput({ token, persistent_token: true });
}

export type ClaimOutcome =
	| { kind: "ok"; remembered: boolean }
	// The box refused this code and nothing was committed.
	| { kind: "refused" }
	// The request never left this page; the code is still unused.
	| { kind: "unreachable" }
	// The box may hold the new owner credential; `getClaimPending()` is set and
	// the generated secret is retained for this visit.
	| { kind: "uncertain" }
	| { kind: "cancelled" };

// The generated credential of a claim this page could not confirm. Every later
// attempt in this visit reuses it, so whichever request the box committed, the
// same secret signs in. Memory only: wiped on sign-in, discard and pagehide.
let pendingOwnerSecret: string | undefined;
let claimPending = $state(false);
let stopReconnectRetry: (() => void) | undefined;
let finishing: Promise<ClaimOutcome> | undefined;

/** True once a claim's outcome is unknown and its secret is retained. */
export function getClaimPending(): boolean {
	return claimPending;
}

function generateOwnerSecret(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function holdPendingClaim(secret: string): void {
	pendingOwnerSecret = secret;
	// A reconnect is the usual way a lost reply resolves; sign in on it.
	stopReconnectRetry ??= rpcClient.onConnectionChange((state) => {
		if (state === "connected" && !authStatus) void finishLocalClaim();
	});
}

/** Forget an unconfirmed claim, as the operator asked or the visit ended. */
export function discardPendingClaim(): void {
	pendingOwnerSecret = undefined;
	claimPending = false;
	stopReconnectRetry?.();
	stopReconnectRetry = undefined;
}

/** Claim a fresh box with its one-time code and sign in with a new secret. */
export async function claimLocalOwner(code: string): Promise<ClaimOutcome> {
	const signal = interaction.signal;
	const resumed = pendingOwnerSecret !== undefined;
	const input: LocalClaimInput = {
		code,
		ownerSecret: pendingOwnerSecret ?? generateOwnerSecret(),
	};
	try {
		if (!(await whenSocketReady(signal))) {
			if (signal.aborted) return { kind: "cancelled" };
			return { kind: resumed ? "uncertain" : "unreachable" };
		}
		let committed: boolean | undefined;
		try {
			const reply = rpc.auth.claimLocalOwner(input);
			// Hold the secret before the reply: a lost reply can follow a commit.
			holdPendingClaim(input.ownerSecret);
			input.code = "";
			committed = (await reply).success;
		} catch (error) {
			if (error instanceof NotSentError && !resumed) {
				discardPendingClaim();
				return { kind: "unreachable" };
			}
			// Lost, timed out or failed on the box: the outcome is unknown.
		}
		if (committed === false && !resumed) {
			discardPendingClaim();
			return { kind: "refused" };
		}
		// Confirmed, unknown, or refused after an earlier unconfirmed attempt that
		// may itself have committed: the retained secret decides.
		return await finishLocalClaim();
	} finally {
		input.code = "";
		input.ownerSecret = "";
	}
}

/** An in-flow, persistent notice; a toast would overlay controls forever. */
function publishNotRememberedNotice(): void {
	pushNotification({
		name: "local-claim-not-remembered",
		type: "warning",
		key: "auth.claimNotRemembered",
		msg: "This browser did not keep the sign-in. Set a password in Settings before you close this page.",
		is_dismissable: true,
		is_persistent: true,
		duration: 0,
	});
}

/** Sign in with the retained secret of an unconfirmed claim. */
export function finishLocalClaim(): Promise<ClaimOutcome> {
	const secret = pendingOwnerSecret;
	if (secret === undefined) return Promise.resolve({ kind: "cancelled" });
	finishing ??= (async (): Promise<ClaimOutcome> => {
		try {
			const result = await authenticate(secret, true);
			if (result.kind === "ok") {
				if (pendingOwnerSecret === secret) discardPendingClaim();
				const remembered = result.remembered !== false;
				// Settlement owns the warning, whichever path signed in.
				if (!remembered) publishNotRememberedNotice();
				return { kind: "ok", remembered };
			}
			if (pendingOwnerSecret === undefined) return { kind: "cancelled" };
			claimPending = true;
			return { kind: "uncertain" };
		} finally {
			finishing = undefined;
		}
	})();
	return finishing;
}

export function createPassword(
	password: string,
	cancelled?: AbortSignal,
): Promise<boolean> {
	return createPasswordInput({ password }, cancelled);
}

async function createPasswordInput(
	input: SetPasswordInput,
	cancelled?: AbortSignal,
): Promise<boolean> {
	const signal = AbortSignal.any([
		interaction.signal,
		...(cancelled ? [cancelled] : []),
	]);
	const clearPassword = () => {
		input.password = "";
	};
	signal.addEventListener("abort", clearPassword, { once: true });
	try {
		const ready = await whenSocketReady(signal);
		if (signal.aborted) return false;
		if (!ready) return false;
		let result: { success: boolean };
		try {
			const reply = rpc.auth.setPassword(input);
			// Do not retain the setup secret across the device reply.
			clearPassword();
			result = await reply;
		} catch (error) {
			if (signal.aborted) return false;
			if (
				error instanceof RpcError ||
				error instanceof NotSentError ||
				(error instanceof Error &&
					(error.name === "ConnectionResetError" ||
						(error.name === "Error" &&
							error.message.startsWith("Request timeout:"))))
			) {
				return false;
			}
			throw error;
		}
		if (signal.aborted) return false;
		// The device revokes all remembered tokens on a successful password change.
		if (result.success) localStorage.removeItem("auth");
		return result.success;
	} finally {
		clearPassword();
		signal.removeEventListener("abort", clearPassword);
	}
}

// Best-effort on purpose: the callers are recovery paths whose premise is that
// the stored token may already be dead, so the socket is unauthenticated and the
// device refuses. Clearing local storage is what the operator asked for either
// way, so a refusal must never block it.
export async function revokePersistentToken(token: string): Promise<void> {
	if (token.length === 0) return;
	try {
		if (!rpcClient.isConnected()) return;
		await rpc.auth.revokeToken({ token, scope: "token" });
	} catch (error) {
		console.warn("Failed to revoke the stored credential:", error);
	}
}
