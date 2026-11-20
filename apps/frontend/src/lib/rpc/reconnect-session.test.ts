// @vitest-environment jsdom
/**
 * The device authenticates each WebSocket, not the page. When the link drops
 * and comes back, the page must sign the NEW socket in again before anything
 * else goes out on it, whichever way the operator signed in:
 *
 * - from the login form with "Remember me" (the remembered token),
 * - from the login form without it (the token of this visit, in memory),
 *
 * and an action the operator starts while that happens must either go out
 * after the sign-in or fail with a clear reason, never reach the device
 * unauthenticated and come back as "Authentication required".
 *
 * Everything is real here: the `rpc` proxy and `RPCClient` on a scripted
 * socket, the subscription store with its reconnect re-auth, the auth store
 * with its login, and the connection-UX store. Only the socket is fake.
 */
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { rpc, rpcClient } from "$lib/rpc/client";
import { NotSentError } from "$lib/rpc/rpc-error";
import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";
import {
	type AuthAttempt,
	authenticate,
	authStatusStore,
	createPassword,
} from "$lib/stores/auth-status.svelte";
import {
	destroyConnectionUxStore,
	getSessionExpired,
} from "$lib/stores/connection-ux.svelte";
import {
	clearNotifications,
	getActive as getActiveNotifications,
} from "$lib/stores/notifications.svelte";

import {
	answer,
	dropLink,
	elapse,
	FakeWebSocket,
	flush,
	outstanding,
	restoreLink,
	sentCount,
	socket,
} from "../../tests/helpers/update-device";

const RPC_TIMEOUT_MS = 30_000;
const ISSUED_TOKEN = "issued-token-1";

// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
const realGetUrl = rpcClient["getUrl"];
const realWebSocket = globalThis.WebSocket;
let jitter: { mockRestore(): void } | undefined;

beforeAll(() => {
	// The suppressed console noise of a failed re-auth is expected here.
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

beforeEach(() => {
	vi.useFakeTimers();
	jitter = vi.spyOn(Math, "random").mockReturnValue(0.5);
	FakeWebSocket.current = undefined;
	FakeWebSocket.log.length = 0;
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
	rpcClient["getUrl"] = () => "ws://device.test/ws";
	localStorage.clear();
	clearNotifications();
	resetState();
	initSubscriptions();
	// Later tests: the store is initialised and its client was disconnected by
	// the previous teardown, so it reopens here (the store's own socket).
	if (FakeWebSocket.current === undefined) rpcClient.connect();
	socket().readyState = FakeWebSocket.OPEN;
	socket().onopen?.();
});

afterEach(async () => {
	authStatusStore.set(false);
	rpcClient.disconnect();
	destroyConnectionUxStore();
	await flush();
	// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
	rpcClient["getUrl"] = realGetUrl;
	globalThis.WebSocket = realWebSocket;
	jitter?.mockRestore();
	vi.useRealTimers();
	localStorage.clear();
});

/** The operator signs in from the login form; the device accepts. */
async function signInFromForm(remember: boolean): Promise<void> {
	const attempt: Promise<AuthAttempt> = authenticate("hunter22", remember);
	await flush();
	answer("auth.login", { success: true, auth_token: ISSUED_TOKEN });
	expect((await attempt).kind).toBe("ok");
	expect(authStatusStore.value).toBe(true);
}

/** The link drops (the phone's socket is closed) and the client reconnects. */
async function reconnect(): Promise<void> {
	dropLink();
	await restoreLink();
}

/** The `auth.login` requests the client sent on the CURRENT socket. */
function loginsOnThisSocket(): unknown[] {
	return socket()
		.sent.filter((request) => request.path === "auth.login")
		.map((request) => request.input);
}

/** The operator presses an action (e.g. "Open") on the page. */
function startAction(): Promise<unknown> {
	return rpcClient.call(["captive", "open"], { ifname: "wlan1" });
}

describe("reconnect re-authentication", () => {
	it("signs the new socket in with the remembered token after a form login with Remember me", async () => {
		await signInFromForm(true);
		expect(localStorage.getItem("auth")).toBe(ISSUED_TOKEN);

		await reconnect();

		expect(loginsOnThisSocket()).toEqual([
			{ token: ISSUED_TOKEN, persistent_token: true },
		]);
		answer("auth.login", { success: true });
		await flush();

		// Signed in again: the page stays in, and actions go straight out.
		expect(authStatusStore.value).toBe(true);
		const action = startAction();
		await flush();
		expect(outstanding("captive.open")).toHaveLength(1);
		answer("captive.open", { ok: true });
		await expect(action).resolves.toEqual({ ok: true });
	});

	it("signs the new socket in with the visit's token after a form login without Remember me", async () => {
		await signInFromForm(false);
		expect(localStorage.getItem("auth")).toBeNull();

		await reconnect();

		expect(loginsOnThisSocket()).toEqual([
			{ token: ISSUED_TOKEN, persistent_token: true },
		]);
		answer("auth.login", { success: true });
		await flush();
		expect(authStatusStore.value).toBe(true);
		// Remember me stays off: nothing was written to storage.
		expect(localStorage.getItem("auth")).toBeNull();
	});

	it("signs in again on every reconnect, not only the first", async () => {
		await signInFromForm(false);
		for (let round = 0; round < 3; round += 1) {
			await reconnect();
			expect(loginsOnThisSocket()).toEqual([
				{ token: ISSUED_TOKEN, persistent_token: true },
			]);
			answer("auth.login", { success: true });
			await flush();
		}
		expect(authStatusStore.value).toBe(true);
	});

	it("holds an action started during the re-auth and sends it once the socket is signed in", async () => {
		await signInFromForm(true);
		await reconnect();

		const action = startAction();
		await flush();
		// Not on the wire while the new socket is still signed out.
		expect(sentCount("captive.open")).toBe(0);

		answer("auth.login", { success: true });
		await flush();

		expect(sentCount("captive.open")).toBe(1);
		const [login, open] = socket().sent.filter(
			(request) =>
				request.path === "auth.login" || request.path === "captive.open",
		);
		expect(login?.path).toBe("auth.login");
		expect(open?.path).toBe("captive.open");
		answer("captive.open", { ok: true });
		await expect(action).resolves.toEqual({ ok: true });
	});

	it("fails a held action with a clear 'reconnected, try again' error when the re-auth does not finish", async () => {
		await signInFromForm(false);
		await reconnect();
		const recycled = socket();

		const action = startAction();
		const failure = action.catch((error: unknown) => error);
		await flush();

		// The device keeps the socket warm but never answers the sign-in.
		await elapse(RPC_TIMEOUT_MS);

		const error = await failure;
		expect(error).toBeInstanceOf(NotSentError);
		expect((error as NotSentError).reason).toBe("reconnected");
		expect((error as Error).message).toBe(
			"Reconnected to the device. Please try again.",
		);
		expect(sentCount("captive.open")).toBe(0);
		// The socket that could not be signed in is replaced, and the next one
		// is signed in again.
		expect(recycled.readyState).toBe(FakeWebSocket.CLOSED);
		await restoreLink();
		expect(loginsOnThisSocket()).toEqual([
			{ token: ISSUED_TOKEN, persistent_token: true },
		]);
		expect(authStatusStore.value).toBe(true);
	});

	it.each([{ remember: true }, { remember: false }])(
		"goes to the login screen when the device refuses the token (remember: $remember)",
		async ({ remember }) => {
			await signInFromForm(remember);
			await reconnect();

			const action = startAction();
			const failure = action.catch((error: unknown) => error);
			await flush();

			expect(loginsOnThisSocket()).toEqual([
				{ token: ISSUED_TOKEN, persistent_token: true },
			]);
			answer("auth.login", { success: false });
			await flush();

			expect(authStatusStore.value).toBe(false);
			expect(getSessionExpired()).toBe(true);
			// A reconnect never touches the shared slot: only an explicit sign-in or
			// sign-out writes it (the next page load drops a dead token itself).
			expect(localStorage.getItem("auth")).toBe(remember ? ISSUED_TOKEN : null);
			const error = await failure;
			expect(error).toBeInstanceOf(NotSentError);
			expect((error as NotSentError).reason).toBe("signed-out");
			expect(sentCount("captive.open")).toBe(0);

			// Signed out for good: the next reconnect presents no stale token.
			await reconnect();
			expect(loginsOnThisSocket()).toEqual([]);
		},
	);

	it("does not gate the socket before the first sign-in", async () => {
		const action = startAction();
		await flush();
		expect(sentCount("captive.open")).toBe(1);
		answer("captive.open", { ok: true });
		await expect(action).resolves.toEqual({ ok: true });
	});
});

describe("held calls on a reconnecting socket", () => {
	it("sends a held call with the payload it was started with", async () => {
		await signInFromForm(true);
		await reconnect();

		const input = { action: "start" as const, radio: 1 };
		const action = rpc.wifi.portal(input);
		await flush();
		// The caller reuses its object after the call returned.
		input.radio = 2;

		answer("auth.login", { success: true });
		await flush();
		expect(outstanding("wifi.portal").map((request) => request.input)).toEqual([
			{ action: "start", radio: 1 },
		]);
		answer("wifi.portal", { phase: "signing_in" });
		await expect(action).resolves.toEqual({ phase: "signing_in" });
	});

	it("never holds a password change: it fails unsent and nothing is replayed", async () => {
		await signInFromForm(false);
		await reconnect();

		const changed = createPassword("a-new-password-9");
		await flush();
		await expect(changed).resolves.toBe(false);

		answer("auth.login", { success: true });
		await flush();
		expect(sentCount("auth.setPassword")).toBe(0);
		expect(authStatusStore.value).toBe(true);
	});

	it.each([
		["system", "reboot"],
		["system", "poweroff"],
		["auth", "revokeToken"],
	])("never holds %s.%s", async (group, name) => {
		await signInFromForm(false);
		await reconnect();

		const call = rpcClient.call([group, name], {});
		const error = await call.catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(NotSentError);
		expect((error as NotSentError).reason).toBe("reconnected");

		answer("auth.login", { success: true });
		await flush();
		expect(sentCount(`${group}.${name}`)).toBe(0);
	});

	it("does not carry a held call over to a replacement socket", async () => {
		await signInFromForm(false);
		await reconnect();
		const action = startAction();
		const failure = action.catch((error: unknown) => error);
		await flush();

		// The socket starts closing, and a new one is opened before its close
		// event arrives.
		socket().readyState = FakeWebSocket.CLOSING;
		rpcClient.connect();
		socket().readyState = FakeWebSocket.OPEN;
		socket().onopen?.();
		await flush();
		answer("auth.login", { success: true });
		await flush();

		expect(await failure).toBeInstanceOf(NotSentError);
		expect(sentCount("captive.open")).toBe(0);
	});
});

describe("a re-auth that keeps stalling", () => {
	it("backs off further on every stalled socket, then returns to the login screen", async () => {
		await signInFromForm(false);
		await reconnect();

		const gaps: number[] = [];
		for (let stall = 0; stall < 2; stall += 1) {
			await elapse(RPC_TIMEOUT_MS);
			const closedAt = Date.now();
			await restoreLink();
			gaps.push(Date.now() - closedAt);
			expect(loginsOnThisSocket()).toEqual([
				{ token: ISSUED_TOKEN, persistent_token: true },
			]);
		}
		expect(gaps[1]).toBeGreaterThan(gaps[0] ?? 0);

		await elapse(RPC_TIMEOUT_MS);
		expect(authStatusStore.value).toBe(false);
	});

	it("announces the connection as restored only once the session is back", async () => {
		await signInFromForm(false);
		await reconnect();
		const restored = () =>
			getActiveNotifications().some(
				(notification) => notification.name === "connection-recovered",
			);

		expect(restored()).toBe(false);
		answer("auth.login", { success: true });
		await flush();
		expect(restored()).toBe(true);
	});
});

describe("tabs share the remembered token", () => {
	const OTHER_TAB_TOKEN = "other-tab-token";

	it("presents this tab's own token, not one another tab remembered", async () => {
		await signInFromForm(false);
		// Another tab signs in with Remember me.
		localStorage.setItem("auth", OTHER_TAB_TOKEN);

		await reconnect();
		expect(loginsOnThisSocket()).toEqual([
			{ token: ISSUED_TOKEN, persistent_token: true },
		]);
	});

	it("leaves another tab's remembered token in place when this tab's token is refused", async () => {
		await signInFromForm(true);
		await reconnect();
		// Another tab signs in with Remember me while this tab's login is out.
		localStorage.setItem("auth", OTHER_TAB_TOKEN);

		answer("auth.login", { success: false });
		await flush();

		expect(authStatusStore.value).toBe(false);
		expect(localStorage.getItem("auth")).toBe(OTHER_TAB_TOKEN);
	});

	it("does not sign a signed-out tab back in with another tab's token", async () => {
		await signInFromForm(true);
		await reconnect();
		answer("auth.login", { success: false });
		await flush();
		expect(authStatusStore.value).toBe(false);

		localStorage.setItem("auth", OTHER_TAB_TOKEN);
		await reconnect();
		await flush();

		expect(loginsOnThisSocket()).toEqual([]);
		expect(sentCount("streaming.getConfig")).toBe(0);
	});
});
