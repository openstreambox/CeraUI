// @vitest-environment jsdom
// allow: SIZE_OK - socket lifecycle cases share one scripted transport and auth fixture.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

import {
	COMPILE_MS,
	compileTab,
	flushReplies,
	RESTORE,
	resetTab,
	ScriptedSocket,
	start,
	TOKEN,
} from "../../tests/harness/scripted-socket";

vi.mock("../env", () => ({ getRpcSocketUrl: () => "ws://test.local/ws" }));

beforeAll(async () => {
	await compileTab();
	await import("@testing-library/svelte");
	await import("../../main/Auth.svelte");
}, COMPILE_MS);

/** The socket the client opens next, after its reconnect backoff. */
async function nextSocket(): Promise<ScriptedSocket> {
	const count = ScriptedSocket.instances.length;
	for (
		let waited = 0;
		waited < 60_000 && ScriptedSocket.instances.length === count;
		waited += 250
	)
		await vi.advanceTimersByTimeAsync(250);
	const socket = ScriptedSocket.instances.at(-1);
	if (!socket) throw new Error("No pending WebSocket");
	socket.open();
	return socket;
}

beforeEach(resetTab);

it("retains the token and offers sign-in after repeated live replay timeouts after first-run setup", async () => {
	const { first, replace, setupPassword, signIn, auth, subscriptions } =
		await start();
	await setupPassword(true);
	await signIn();

	// The train's re-auth recycles a socket whose replay gets no answer and
	// replays on the next one; only the third stall offers sign-in.
	let socket = replace(first);
	for (let stall = 1; stall <= 3; stall++) {
		expect(socket.request("auth.login").input).toEqual(RESTORE);
		// RPC deadline, not a sleep: no auth reply arrives on this open link.
		for (let elapsed = 0; elapsed < 30_000; elapsed += 10_000) {
			socket.push({ ping: { t: Date.now() } });
			await vi.advanceTimersByTimeAsync(10_000);
		}
		expect(socket.sent.map(({ path }) => path.join("."))).toEqual([
			"auth.login",
		]);
		if (stall < 3) {
			expect(auth.getAuthStatus()).toBe(true);
			socket = await nextSocket();
		}
	}
	expect(auth.getAuthStatus()).toBe(false);
	expect(localStorage.getItem("auth")).toBe(TOKEN);
	expect(subscriptions.getStatus()?.set_password).not.toBe(true);
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("replays the token issued to a fresh remembered password login", async () => {
	const { first, replace, session, signIn } = await start();
	await signIn();
	expect(localStorage.getItem("auth")).toBe(TOKEN);

	const second = replace(first);
	expect(session.getSessionReady()).toBe(false);
	expect(second.sent.map(({ path, input }) => [path.join("."), input])).toEqual(
		[["auth.login", RESTORE]],
	);
	second.reply("auth.login", { success: true });
	await flushReplies();
	expect(session.getSessionReady()).toBe(true);
	expect(session.getRestoredSessions()).toBe(0);
	second.reply("streaming.getConfig", {});
	second.reply("status.getStatus", {});
	await flushReplies();
	expect(session.getRestoredSessions()).toBe(1);
});

it.each(["after", "before", "without"] as const)(
	"a clear missed while offline is applied by the reconnect pull, %s the login snapshot, and autostart survives",
	async (order) => {
		const { first, replace, signIn, subscriptions } = await start();
		await signIn();
		first.push({
			config: { source: "cam-1", video_codec: "h264", autostart: true },
			seq: 1,
		});

		// Offline, another tab cleared video_codec: no frame reached this tab.
		const second = replace(first);
		second.reply("auth.login", { success: true });
		const snapshot = () =>
			second.push({ config: { source: "cam-1", autostart: true } });
		if (order === "after") snapshot();
		await flushReplies();
		second.reply("streaming.getConfig", { source: "cam-1" });
		await flushReplies();
		if (order === "before") snapshot();

		expect(subscriptions.getConfig()).toEqual({
			source: "cam-1",
			autostart: true,
		});
	},
);

it("signs out on rejection, without sending protected reads or replaying again", async () => {
	const { first, replace, signIn, auth } = await start();
	await signIn();

	const second = replace(first);
	second.reply("auth.login", { success: false });
	await flushReplies();
	expect(second.sent.map(({ path }) => path.join("."))).toEqual(["auth.login"]);
	expect(localStorage.getItem("auth")).toBeNull();
	expect(auth.getAuthStatus()).toBe(false);
	expect(replace(second).sent).toEqual([]);
});

it.each(["not remembered", "cleared by another tab"] as const)(
	"replays this tab's own token when the credential is %s, without writing the shared slot",
	async (reason) => {
		const { first, replace, signIn, auth } = await start();
		await signIn(reason !== "not remembered");
		if (reason === "cleared by another tab") localStorage.removeItem("auth");

		// The train signs every new socket in with the token this tab holds in
		// memory, whether or not it was remembered, so a dropped link does not
		// end a signed-in session. The shared slot stays as the sign-in left it.
		const second = replace(first);
		await flushReplies();
		expect(
			second.sent.map(({ path, input }) => [path.join("."), input]),
		).toEqual([["auth.login", RESTORE]]);
		second.reply("auth.login", { success: true });
		await flushReplies();
		expect(auth.getAuthStatus()).toBe(true);
		expect(localStorage.getItem("auth")).toBeNull();
	},
);

it("keeps another tab's new token if the token in flight is rejected", async () => {
	const { first, replace, signIn, auth } = await start();
	await signIn();
	const second = replace(first);
	localStorage.setItem("auth", "other-tab-token");

	second.reply("auth.login", { success: false });
	await flushReplies();
	expect(localStorage.getItem("auth")).toBe("other-tab-token");
	expect(auth.getAuthStatus()).toBe(false);
	expect(replace(second).sent).toEqual([]);
});

it("gives each replacement its own replay even when older login and hydration are interrupted", async () => {
	const { first, replace, session, signIn } = await start();
	await signIn();

	const second = replace(first);
	const third = replace(second);
	// The train settles the interrupted attempt before replaying on the newest
	// socket, one turn later.
	await flushReplies();
	expect(third.request("auth.login").input).toEqual(RESTORE);
	second.reply("auth.login", { success: false });
	third.reply("auth.login", { success: true });
	await flushReplies();
	third.reply("streaming.getConfig", {});
	const fourth = replace(third);
	await flushReplies();
	expect(fourth.request("auth.login").input).toEqual(RESTORE);
	third.reply("status.getStatus", {});
	await flushReplies();
	expect(session.getRestoredSessions()).toBe(0);
	expect(localStorage.getItem("auth")).toBe(TOKEN);

	fourth.reply("auth.login", { success: true });
	await flushReplies();
	fourth.reply("streaming.getConfig", {});
	fourth.reply("status.getStatus", {});
	await flushReplies();
	expect(session.getRestoredSessions()).toBe(1);
});

it("does not replay or authenticate on a device that still needs password setup", async () => {
	const { first, replace, auth, subscriptions } = await start();
	first.push({ status: { set_password: true } });
	const second = replace(first);
	second.push({ status: { set_password: true } });
	await flushReplies();
	expect(second.sent).toEqual([]);
	expect(auth.getAuthStatus()).toBe(false);
	expect(subscriptions.getStatus()?.set_password).toBe(true);
});

it("finishes first-run sign-in even when device status arrives during login", async () => {
	const { first, auth } = await start();
	const { fireEvent, render, screen } = await import("@testing-library/svelte");
	const { default: Auth } = await import("../../main/Auth.svelte");
	first.push({ status: { set_password: true } });
	const form = render(Auth);
	try {
		for (const field of [/new password/i, /confirm password/i]) {
			await fireEvent.input(screen.getByLabelText(field), {
				target: { value: "disposable-password" },
			});
		}
		await fireEvent.click(screen.getByRole("button", { name: "Set password" }));
		await flushReplies();
		first.reply("auth.setPassword", { success: true });
		await flushReplies();
		first.request("auth.login");

		first.push({ status: { is_streaming: true } });
		await flushReplies();
		first.reply("auth.login", { success: true });
		await flushReplies();
		expect(auth.getAuthStatus()).toBe(true);
		expect(screen.queryByLabelText(/confirm password/i)).toBeNull();
	} finally {
		form.unmount();
	}
});

it("offers sign-in rather than first-run setup when replay is rejected after setup", async () => {
	const { first, replace, setupPassword, signIn, auth, subscriptions } =
		await start();
	await setupPassword(true);
	await signIn();
	first.push({ status: { is_streaming: false } });

	const second = replace(first);
	second.reply("auth.login", { success: false });
	await flushReplies();
	expect(auth.getAuthStatus()).toBe(false);
	expect(localStorage.getItem("auth")).toBeNull();
	expect(subscriptions.getStatus()?.set_password).not.toBe(true);

	const pending = auth.authenticate("disposable-password", true);
	await flushReplies();
	expect(second.request("auth.login").input).toEqual({
		password: "disposable-password",
		persistent_token: true,
	});
	second.reply("auth.login", { success: true, auth_token: TOKEN });
	expect(await pending).toEqual({ kind: "ok" });
	expect(auth.getAuthStatus()).toBe(true);
});

it("offers sign-in on a replacement link after another tab sets the password", async () => {
	const { first, replace, subscriptions } = await start();
	first.push({ status: { set_password: true } });

	// Once configured, the server sends no setup prompt to a new guest socket.
	const second = replace(first);
	await flushReplies();
	expect(second.sent).toEqual([]);
	expect(subscriptions.getStatus()?.set_password).not.toBe(true);
});

it("still asks for setup when the set-password request is rejected", async () => {
	const { first, setupPassword, auth, subscriptions } = await start();
	await setupPassword(false);

	expect(first.sent.map(({ path }) => path.join("."))).toEqual([
		"auth.setPassword",
	]);
	expect(auth.getAuthStatus()).toBe(false);
	expect(subscriptions.getStatus()?.set_password).toBe(true);
});
