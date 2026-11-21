// @vitest-environment jsdom
/**
 * Reconnect re-auth decisions in the real subscriptions layer. A dropped
 * control socket comes back unauthenticated; the backend sends device state
 * only after `auth.login`. These tests drive the genuine
 * `handleConnectionChange` through a doubled transport and check which
 * credential the new socket logs in with, when "Connection restored" is shown,
 * and when the page has to sign in again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
	connection: undefined as ((state: string) => void) | undefined,
	loginResult: { success: true } as { success: boolean },
	// When set, the safety hydrate's config read waits for this promise.
	hydrateGate: null as Promise<void> | null,
}));
const auth = vi.hoisted(() => ({
	status: true,
	sessionToken: null as string | null,
	set: vi.fn((value: boolean) => {
		auth.status = value;
	}),
}));
const login = vi.hoisted(() =>
	vi.fn(
		async (_input: { token: string; persistent_token: boolean }) =>
			transport.loginResult,
	),
);
const push = vi.hoisted(() => vi.fn());
const markSessionExpired = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		auth: { login },
		streaming: {
			getConfig: vi.fn(async () => {
				if (transport.hydrateGate) await transport.hydrateGate;
				return {};
			}),
		},
		status: { getStatus: vi.fn(async () => ({})) },
	},
	rpcClient: {
		onMessage: () => undefined,
		onConnectionChange: (fn: (state: string) => void) => {
			transport.connection = fn;
			return () => undefined;
		},
		connect: () => undefined,
		isConnected: () => true,
		getSocket: () => undefined,
		sendLegacy: () => undefined,
	},
}));

vi.mock("$lib/stores/connection-ux.svelte", () => ({
	markSessionExpired,
	wasAuthenticated: () => true,
}));

vi.mock("$lib/stores/auth-status.svelte", () => ({
	getSessionToken: () => auth.sessionToken,
	authStatusStore: {
		get value() {
			return auth.status;
		},
		set: auth.set,
		subscribe: (cb: (v: boolean) => void) => {
			cb(auth.status);
			return () => {};
		},
	},
}));

vi.mock("$lib/stores/notifications.svelte", async (original) => ({
	...(await original<typeof import("$lib/stores/notifications.svelte")>()),
	push,
}));

import { initSubscriptions, resetState } from "./subscriptions.svelte.ts";

function recovered(): boolean {
	return push.mock.calls.some(
		([n]) => (n as { name?: string }).name === "connection-recovered",
	);
}

/** Drop and restore the socket, then let the re-auth promise chain settle. */
async function dropAndReconnect(): Promise<void> {
	transport.connection?.("disconnected");
	transport.connection?.("connected");
	for (let i = 0; i < 5; i++)
		await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
	// Page load: the first connect happens before anyone has signed in.
	auth.status = false;
	auth.sessionToken = null;
	transport.loginResult = { success: true };
	transport.hydrateGate = null;
	resetState();
	initSubscriptions();
	transport.connection?.("connected");
	for (let i = 0; i < 5; i++)
		await new Promise((resolve) => setTimeout(resolve, 0));
	vi.clearAllMocks();
	auth.status = true;
});

afterEach(() => {
	localStorage.clear();
});

describe("reconnect re-auth", () => {
	it("re-authenticates a session without remember-me using its in-memory token", async () => {
		auth.sessionToken = "session-token";

		await dropAndReconnect();

		expect(login).toHaveBeenCalledExactlyOnceWith({
			token: "session-token",
			persistent_token: true,
		});
		await vi.waitFor(() => expect(recovered()).toBe(true));
		expect(auth.set).not.toHaveBeenCalled();
	});

	it("falls back to the remembered credential", async () => {
		localStorage.setItem("auth", "remembered-token");

		await dropAndReconnect();

		expect(login).toHaveBeenCalledExactlyOnceWith({
			token: "remembered-token",
			persistent_token: true,
		});
	});

	it("shows Connection restored only after the new socket is signed in", async () => {
		auth.sessionToken = "revoked-token";
		transport.loginResult = { success: false };

		await dropAndReconnect();

		await vi.waitFor(() => expect(auth.set).toHaveBeenCalledWith(false));
		expect(markSessionExpired).toHaveBeenCalled();
		expect(recovered()).toBe(false);
	});

	it("sends a signed-in page with nothing to re-authenticate with back to sign-in", async () => {
		await dropAndReconnect();

		expect(login).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(auth.set).toHaveBeenCalledWith(false));
		expect(recovered()).toBe(false);
	});

	it("reports nothing when the link drops again while it is hydrating", async () => {
		auth.sessionToken = "session-token";
		let release = () => {};
		transport.hydrateGate = new Promise<void>((resolve) => {
			release = resolve;
		});

		await dropAndReconnect();
		expect(login).toHaveBeenCalledTimes(1);
		transport.connection?.("disconnected");
		release();
		for (let i = 0; i < 5; i++)
			await new Promise((resolve) => setTimeout(resolve, 0));

		expect(recovered()).toBe(false);
		expect(auth.set).not.toHaveBeenCalled();
	});

	it("lets a newer link re-authenticate while an older re-auth is still running", async () => {
		auth.sessionToken = "session-token";
		let release = () => {};
		transport.hydrateGate = new Promise<void>((resolve) => {
			release = resolve;
		});

		await dropAndReconnect();
		await dropAndReconnect();
		expect(login).toHaveBeenCalledTimes(2);
		release();
		await vi.waitFor(() => expect(recovered()).toBe(true));
		expect(
			push.mock.calls.filter(
				([n]) => (n as { name?: string }).name === "connection-recovered",
			),
			"only the current link reports recovery",
		).toHaveLength(1);
	});

	it("does nothing for a signed-out page", async () => {
		auth.status = false;
		localStorage.setItem("auth", "remembered-token");

		await dropAndReconnect();

		expect(login).not.toHaveBeenCalled();
		expect(auth.set).not.toHaveBeenCalled();
		expect(recovered()).toBe(false);
	});
});
