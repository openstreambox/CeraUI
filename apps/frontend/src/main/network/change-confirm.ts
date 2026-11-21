/**
 * change-confirm.ts: the browser's half of confirming a protected network
 * change.
 *
 * The device keeps a protected change (one that may cut this browser off)
 * only if THIS browser proves it can still reach the device after the
 * change: a NEW connection of the same login, to the same address, opened at
 * least the settle time after the change, presenting the one-time code this
 * page minted for that change. The device stores only the code's hash.
 *
 * Why the page mints the code: the change may cut the socket that sent it
 * before the reply comes back, so a code minted by the device could be lost.
 * The page creates it before sending the request and keeps it in
 * `sessionStorage`: a reload of this tab keeps it, other tabs never see it.
 *
 * The flow, driven by the confirm banner:
 * 1. `mintConfirmationCode()` + `rememberConfirmationCode()` before the
 *    request; the code goes out as `confirmationCode`.
 * 2. `prepareConfirmation()` waits until the device accepts a confirmation
 *    (`confirmAfterMs`) and makes sure the current socket opened after that
 *    point, reconnecting if not. Then the banner shows its Confirm button.
 * 3. `confirmFromThisBrowser()` sends the code over that socket. A
 *    `too_early` refusal reconnects once and tries again; any other refusal
 *    is final for that change.
 *
 * Pure and rune-free: everything that touches the socket, the clock or
 * storage is injected, so it runs under plain vitest.
 */

import type {
	ChangeSafetyConfirmOutput,
	ChangeSafetyConfirmRefusal,
} from "@ceraui/rpc/schemas";
import { confirmationCodeSchema } from "@ceraui/rpc/schemas";

/** The `sessionStorage` key; one pending change at a time on a device. */
export const CONFIRMATION_CODE_STORAGE_KEY = "ceralive.networkChangeCode";
const CODE_BYTES = 32;
/** Margin past the device's floor, for timer and transit jitter. */
export const FLOOR_MARGIN_MS = 500;

type CodeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** 32 random bytes, base64url without padding (43 characters). */
export function mintConfirmationCode(
	random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (bytes) =>
		crypto.getRandomValues(bytes),
): string {
	const bytes = random(new Uint8Array(new ArrayBuffer(CODE_BYTES)));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

export interface StoredConfirmationCode {
	readonly code: string;
	/** Client clock when the request went out. */
	readonly requestedAt: number;
}

export function rememberConfirmationCode(
	storage: CodeStorage,
	code: string,
	now: number,
): void {
	storage.setItem(
		CONFIRMATION_CODE_STORAGE_KEY,
		JSON.stringify({ code, requestedAt: now }),
	);
}

/** The stored code, or undefined when absent or not a code. */
export function readConfirmationCode(
	storage: CodeStorage,
): StoredConfirmationCode | undefined {
	let raw: string | null;
	try {
		raw = storage.getItem(CONFIRMATION_CODE_STORAGE_KEY);
	} catch {
		return undefined;
	}
	if (!raw) return undefined;
	try {
		const value = JSON.parse(raw) as Partial<StoredConfirmationCode>;
		if (
			confirmationCodeSchema.safeParse(value.code).success &&
			typeof value.requestedAt === "number" &&
			Number.isFinite(value.requestedAt)
		)
			return { code: value.code as string, requestedAt: value.requestedAt };
	} catch {
		// Not ours: treated as absent.
	}
	return undefined;
}

export function forgetConfirmationCode(storage: CodeStorage): void {
	try {
		storage.removeItem(CONFIRMATION_CODE_STORAGE_KEY);
	} catch {
		// Storage unavailable: nothing to forget.
	}
}

/** What the device says about the pending change (`network.getChangeSafety`). */
export interface PendingChange {
	readonly id: string;
	readonly msLeft: number;
	readonly confirmAfterMs: number;
	readonly canConfirm: boolean;
}

export interface ConfirmDeps {
	readonly storage: CodeStorage;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	/** The pending change, read over the current socket. */
	readonly pending: () => Promise<PendingChange | null>;
	/** Client clock when the current socket opened; undefined while closed. */
	readonly socketOpenedAt: () => number | undefined;
	/** Close the socket, open a new one to the same address, sign in again. */
	readonly reconnect: () => Promise<void>;
	readonly confirm: (
		id: string,
		code: string,
	) => Promise<ChangeSafetyConfirmOutput>;
}

export type PrepareOutcome =
	/** Ready: show Confirm. `msLeft` is the time left for it. */
	| { readonly kind: "ready"; readonly id: string; readonly msLeft: number }
	/** This tab holds no code: another tab or browser made the change. */
	| { readonly kind: "no-code" }
	/** Nothing pending any more (confirmed elsewhere, or undone). */
	| { readonly kind: "nothing-pending" }
	/** The change was made by a session that can't confirm it. */
	| { readonly kind: "cannot-confirm" };

/**
 * Wait until the device accepts a confirmation, then make sure the socket is
 * one opened after that point.
 */
export async function prepareConfirmation(
	deps: ConfirmDeps,
): Promise<PrepareOutcome> {
	if (!readConfirmationCode(deps.storage)) return { kind: "no-code" };
	const pending = await deps.pending();
	if (!pending) {
		forgetConfirmationCode(deps.storage);
		return { kind: "nothing-pending" };
	}
	if (!pending.canConfirm) return { kind: "cannot-confirm" };
	const readAt = deps.now();
	const floorAt = readAt + pending.confirmAfterMs + FLOOR_MARGIN_MS;
	if (pending.confirmAfterMs > 0) await deps.sleep(floorAt - readAt);
	const opened = deps.socketOpenedAt();
	if (opened === undefined || opened < floorAt) await deps.reconnect();
	return {
		kind: "ready",
		id: pending.id,
		msLeft: Math.max(0, pending.msLeft - (deps.now() - readAt)),
	};
}

export type ConfirmOutcome =
	| { readonly kind: "kept"; readonly via: string | null }
	| { readonly kind: "no-code" }
	| { readonly kind: "refused"; readonly reason: ChangeSafetyConfirmRefusal }
	| { readonly kind: "failed"; readonly error: string };

/** The person pressed Confirm: present this tab's code for change `id`. */
export async function confirmFromThisBrowser(
	deps: ConfirmDeps,
	id: string,
): Promise<ConfirmOutcome> {
	const stored = readConfirmationCode(deps.storage);
	if (!stored) return { kind: "no-code" };
	let result = await deps.confirm(id, stored.code);
	if (!result.success && result.refusal === "too_early") {
		// The socket predates the floor (it reconnected on its own early):
		// one fresh connection, then once more.
		await deps.reconnect();
		result = await deps.confirm(id, stored.code);
	}
	if (result.success) {
		forgetConfirmationCode(deps.storage);
		return { kind: "kept", via: result.confirmedVia ?? null };
	}
	if (result.refusal) {
		if (result.refusal !== "too_early") forgetConfirmationCode(deps.storage);
		return { kind: "refused", reason: result.refusal };
	}
	return { kind: "failed", error: result.error ?? "unavailable" };
}
