// @vitest-environment jsdom
// allow: SIZE_OK - socket lifecycle cases share one scripted transport and auth fixture.
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

vi.mock("../env", () => ({ getRpcSocketUrl: () => "ws://test.local/ws" }));

type Request = {
	readonly id: string;
	readonly path: string[];
	readonly input?: unknown;
};

class ScriptedSocket {
	static readonly OPEN = 1;
	static readonly CONNECTING = 0;
	static readonly CLOSED = 3;
	static instances: ScriptedSocket[] = [];
	readyState = ScriptedSocket.CONNECTING;
	onopen?: () => void;
	onclose?: () => void;
	onmessage?: (event: { data: string }) => void;
	readonly sent: Request[] = [];

	constructor() {
		ScriptedSocket.instances.push(this);
	}

	open() {
		this.readyState = ScriptedSocket.OPEN;
		this.onopen?.();
	}

	close() {
		this.readyState = ScriptedSocket.CLOSED;
		this.onclose?.();
	}

	send(data: string) {
		const request: Request = JSON.parse(data);
		if (request.path) this.sent.push(request);
	}

	request(path: string): Request {
		const request = this.sent.findLast((item) => item.path.join(".") === path);
		if (!request) throw new Error(`No ${path} request on this socket`);
		return request;
	}

	reply(path: string, result: unknown) {
		this.onmessage?.({
			data: JSON.stringify({ id: this.request(path).id, result }),
		});
	}

	push(message: object) {
		this.onmessage?.({ data: JSON.stringify(message) });
	}
}

const TOKEN = "issued-session-token";
const RESTORE = { token: TOKEN, persistent_token: true };

function openLatest() {
	const socket = ScriptedSocket.instances.at(-1);
	if (!socket) throw new Error("No pending WebSocket");
	socket.open();
	return socket;
}

async function start() {
	const subscriptions = await import("./subscriptions.svelte");
	const session = await import("./session-epoch.svelte");
	const auth = await import("$lib/stores/auth-status.svelte");
	const { rpcClient } = await import("./client");
	subscriptions.initSubscriptions();
	const first = openLatest();
	const replace = (old: ScriptedSocket) => {
		old.close();
		rpcClient.connect();
		return openLatest();
	};
	const setupPassword = async (success: boolean) => {
		first.push({ status: { set_password: true } });
		const pending = auth.createPassword("disposable-password");
		await flushReplies();
		first.reply("auth.setPassword", { success });
		expect(await pending).toBe(success);
	};
	const signIn = async (remember = true) => {
		const pending = auth.authenticate("disposable-password", remember);
		await flushReplies();
		first.reply("auth.login", { success: true, auth_token: TOKEN });
		expect(await pending).toEqual({ kind: "ok" });
	};
	return {
		auth,
		first,
		replace,
		session,
		setupPassword,
		signIn,
		subscriptions,
	};
}

async function flushReplies() {
	await vi.advanceTimersByTimeAsync(0);
}

// Compile the sign-in screen's module graph once, outside every test's
// timeout. vi.resetModules() below only drops module instances; the
// transform stays cached, so each test still imports fresh stores.
beforeAll(async () => {
	await import("../../main/Auth.svelte");
}, 120_000);

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers();
	vi.stubGlobal("WebSocket", ScriptedSocket);
	ScriptedSocket.instances = [];
	localStorage.clear();
});

it("retains the token and offers sign-in on a live replay timeout after first-run setup", async () => {
	const { first, replace, setupPassword, signIn, auth, subscriptions } =
		await start();
	await setupPassword(true);
	await signIn();

	const second = replace(first);
	expect(second.request("auth.login").input).toEqual(RESTORE);
	// RPC deadline, not a sleep: no auth reply arrives on this open link.
	for (let elapsed = 0; elapsed < 30_000; elapsed += 10_000) {
		second.push({ ping: { t: Date.now() } });
		await vi.advanceTimersByTimeAsync(10_000);
	}
	expect(auth.getAuthStatus()).toBe(false);
	expect(localStorage.getItem("auth")).toBe(TOKEN);
	expect(second.sent.map(({ path }) => path.join("."))).toEqual(["auth.login"]);
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
	"requires sign-in without replay when the credential is %s",
	async (reason) => {
		const { first, replace, signIn, auth } = await start();
		await signIn(reason !== "not remembered");
		if (reason === "cleared by another tab") localStorage.removeItem("auth");

		const second = replace(first);
		await flushReplies();
		expect(second.sent).toEqual([]);
		expect(auth.getAuthStatus()).toBe(false);
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
	expect(third.request("auth.login").input).toEqual(RESTORE);
	second.reply("auth.login", { success: false });
	third.reply("auth.login", { success: true });
	await flushReplies();
	third.reply("streaming.getConfig", {});
	const fourth = replace(third);
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

describe("a claim whose browser refuses token storage", () => {
	const CODE = "0123456789abcdef0123456789abcdef";
	const NOTICE = "local-claim-not-remembered";

	async function claimWithoutStorage() {
		const started = await start();
		const { first, auth } = started;
		const realSetItem = localStorage.setItem.bind(localStorage);
		vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
			if (key === "auth") throw new DOMException("denied", "SecurityError");
			realSetItem(key, value);
		});
		first.push({ status: { local_claim: "ready" } });
		const pending = auth.claimLocalOwner(CODE);
		await flushReplies();
		first.reply("auth.claimLocalOwner", { success: true });
		await flushReplies();
		expect(first.request("auth.login").input).toEqual({
			password: (
				first.request("auth.claimLocalOwner").input as {
					ownerSecret: string;
				}
			).ownerSecret,
			persistent_token: true,
		});
		first.reply("auth.login", { success: true, auth_token: TOKEN });
		expect(await pending).toEqual({ kind: "ok", remembered: false });
		expect(localStorage.getItem("auth")).toBeNull();
		return started;
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("replays a visit-scoped token after the socket drops", async () => {
		const { first, replace, session, auth } = await claimWithoutStorage();
		const second = replace(first);
		expect(second.request("auth.login").input).toEqual(RESTORE);
		second.reply("auth.login", { success: true });
		await flushReplies();
		expect(session.getSessionReady()).toBe(true);
		expect(auth.getAuthStatus()).toBe(true);

		// It survives more than one drop within the visit.
		const third = replace(second);
		expect(third.request("auth.login").input).toEqual(RESTORE);
	});

	it("publishes an in-flow notice from settlement, not a toast", async () => {
		await claimWithoutStorage();
		const notices = await import("$lib/stores/notifications.svelte");
		const notice = notices.getPersistent().find((n) => n.name === NOTICE);
		expect(notice?.type).toBe("warning");
		expect(notice?.isPersistent).toBe(true);
		expect(notice?.key).toBe("auth.claimNotRemembered");
	});

	it("forgets the visit token when the page is hidden", async () => {
		const { first, replace, auth } = await claimWithoutStorage();
		window.dispatchEvent(new PageTransitionEvent("pagehide"));
		const second = replace(first);
		await flushReplies();
		expect(second.sent).toEqual([]);
		expect(auth.getAuthStatus()).toBe(false);
	});

	it("drops a visit token the box rejects", async () => {
		const { first, replace } = await claimWithoutStorage();
		const second = replace(first);
		second.reply("auth.login", { success: false });
		await flushReplies();
		expect(replace(second).sent).toEqual([]);
	});
});
