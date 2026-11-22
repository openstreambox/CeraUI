// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearAuthInteraction,
	discardPendingClaim,
	getAuthStatus,
	getClaimPending,
	setAuthStatus,
} from "../lib/stores/auth-status.svelte";
import {
	captureClaimFragment,
	getScannedClaimCode,
	takeScannedClaimCode,
} from "../lib/stores/claim-fragment.svelte";
import { publishStatus, resetAuthFeeds } from "./__fixtures__/auth-feed.svelte";
import Layout from "./Layout.svelte";

const transport = vi.hoisted(() => ({
	login: vi.fn(),
	setPassword: vi.fn(),
	claimLocalOwner: vi.fn(),
	connection: new Set<(state: string) => void>(),
	warning: vi.fn(),
}));
vi.mock("$lib/rpc/client", () => ({
	rpc: {
		auth: {
			login: (input: unknown) => transport.login(structuredClone(input)),
			setPassword: (input: unknown) =>
				transport.setPassword(structuredClone(input)),
			claimLocalOwner: (input: unknown) =>
				transport.claimLocalOwner(structuredClone(input)),
		},
		ui: { heartbeat: async () => ({ success: true }) },
	},
	rpcClient: {
		isConnected: () => true,
		getConnectionState: () => "connected",
		onConnectionChange: (handler: (state: string) => void) => {
			transport.connection.add(handler);
			return () => transport.connection.delete(handler);
		},
	},
}));
vi.mock("svelte-sonner", () => ({ toast: { warning: transport.warning } }));
vi.mock("$lib/rpc", async () => ({
	rpc: (await import("../lib/rpc/client")).rpc,
}));
vi.mock("$lib/rpc/subscriptions.svelte", async () => ({
	clearPasswordSetup: vi.fn(),
	getStatus: (await import("./__fixtures__/auth-feed.svelte")).getStatusFeed,
	getNotifications: (await import("./__fixtures__/auth-feed.svelte"))
		.getNotificationsFeed,
	getUpdating: () => null,
}));
vi.mock("$lib/stores/offline-state.svelte", async () => ({
	getShouldShowOfflinePage: (await import("./__fixtures__/auth-feed.svelte"))
		.getOfflineFeed,
	getConnectionState: () => "connected",
}));
const noop = vi.hoisted(() => async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("./MainView.svelte", noop);
vi.mock("./DisconnectedBanner.svelte", noop);
vi.mock("./layout/LayoutToastHost.svelte", noop);
vi.mock("./layout/UpdateBanner.svelte", noop);
vi.mock("./layout/UpdateOrchestratorBadge.svelte", noop);
vi.mock("$lib/components/updating-overlay.svelte", noop);
vi.mock("$lib/components/custom/pwa", async () => ({
	OfflinePage: (await import("../tests/fixtures/OfflinePageStub.svelte"))
		.default,
	PWAStatus: (await import("../tests/fixtures/Noop.svelte")).default,
}));

const CODE = "0123456789abcdef0123456789abcdef";
const codeField = () => screen.getByLabelText<HTMLInputElement>("Setup code");
const submit = () => screen.getByRole("button", { name: "Set up box" });
const retry = () => screen.getByRole("button", { name: "Try again" });
const lost = () => Promise.reject(new Error("Request timeout: auth"));
const reconnect = () => {
	for (const handler of [...transport.connection]) handler("connected");
};
const sentSecrets = () =>
	transport.claimLocalOwner.mock.calls.map(
		(call) => (call[0] as { ownerSecret: string }).ownerSecret,
	);

async function claimWith(code = CODE) {
	await fireEvent.input(codeField(), { target: { value: code } });
	await fireEvent.click(submit());
}

// The component setup installs an in-memory Storage with own methods.
function denyStorage(denied: (key: string) => boolean) {
	const realSetItem = localStorage.setItem.bind(localStorage);
	vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
		if (denied(key)) throw new DOMException("denied", "SecurityError");
		realSetItem(key, value);
	});
}

beforeEach(() => {
	Object.defineProperty(window, "isSecureContext", {
		value: true,
		configurable: true,
	});
	discardPendingClaim();
	setAuthStatus(false);
	resetAuthFeeds();
	publishStatus({ local_claim: "ready" });
	transport.login.mockReset();
	transport.setPassword.mockReset();
	transport.claimLocalOwner.mockReset();
	transport.warning.mockReset();
	localStorage.clear();
});
afterEach(() => {
	vi.restoreAllMocks();
	discardPendingClaim();
	clearAuthInteraction();
	takeScannedClaimCode();
});

describe("local claim settlement", () => {
	it("signs in with the generated secret after a confirmed claim", async () => {
		transport.claimLocalOwner.mockResolvedValue({ success: true });
		transport.login.mockResolvedValue({ success: true, auth_token: "t1" });
		render(Layout);
		await claimWith();
		await waitFor(() => expect(getAuthStatus()).toBe(true));
		const [secret] = sentSecrets();
		expect(secret).toMatch(/^[a-f0-9]{64}$/);
		expect(transport.login.mock.calls[0]?.[0]).toEqual({
			password: secret,
			persistent_token: true,
		});
		expect(localStorage.getItem("auth")).toBe("t1");
		expect(getClaimPending()).toBe(false);
	});

	it("keeps no secret after the box refuses the code", async () => {
		transport.claimLocalOwner.mockResolvedValue({ success: false });
		render(Layout);
		await claimWith();
		expect((await screen.findByRole("alert")).textContent).toContain(
			"Check the code",
		);
		expect(transport.login).not.toHaveBeenCalled();
		expect(getClaimPending()).toBe(false);
		expect(codeField().value).toBe("");
		expect(submit().hasAttribute("disabled")).toBe(true);
	});

	it("keeps the secret after a lost reply and signs in on reconnect", async () => {
		transport.claimLocalOwner.mockImplementation(lost);
		transport.login.mockImplementation(lost);
		render(Layout);
		await claimWith();
		await screen.findByRole("button", { name: "Try again" });
		expect(getClaimPending()).toBe(true);
		expect(screen.queryByText(/Check the code/)).toBeNull();
		expect(submit().hasAttribute("disabled")).toBe(true);

		// The socket comes back; the box committed before the reply was lost.
		transport.login.mockResolvedValue({ success: true, auth_token: "t2" });
		reconnect();
		await waitFor(() => expect(getAuthStatus()).toBe(true));
		expect(transport.login.mock.calls.at(-1)?.[0]).toEqual({
			password: sentSecrets()[0],
			persistent_token: true,
		});
		expect(transport.claimLocalOwner).toHaveBeenCalledTimes(1);
		expect(getClaimPending()).toBe(false);
	});

	it("keeps the secret when the claim commits but the login reply is lost", async () => {
		transport.claimLocalOwner.mockResolvedValue({ success: true });
		transport.login.mockImplementation(lost);
		render(Layout);
		await claimWith();
		await screen.findByRole("button", { name: "Try again" });
		transport.login.mockResolvedValue({ success: true, auth_token: "t3" });
		await fireEvent.click(retry());
		await waitFor(() => expect(getAuthStatus()).toBe(true));
		expect(transport.login.mock.calls.map((call) => call[0].password)).toEqual([
			sentSecrets()[0],
			sentSecrets()[0],
		]);
	});

	it("reuses the retained secret when the code is entered again", async () => {
		transport.claimLocalOwner.mockImplementationOnce(lost);
		transport.login.mockImplementation(lost);
		render(Layout);
		await claimWith();
		await screen.findByRole("button", { name: "Try again" });

		// The first request did commit, so the box now refuses the spent code.
		transport.claimLocalOwner.mockResolvedValueOnce({ success: false });
		transport.login.mockResolvedValue({ success: true, auth_token: "t4" });
		await claimWith();
		await waitFor(() => expect(getAuthStatus()).toBe(true));
		const [first, second] = sentSecrets();
		expect(second).toBe(first);
	});

	it("signs in for the visit and warns when storage is denied after the commit", async () => {
		denyStorage((key) => key === "auth");
		transport.claimLocalOwner.mockResolvedValue({ success: true });
		transport.login.mockResolvedValue({ success: true, auth_token: "t5" });
		render(Layout);
		await claimWith();
		await waitFor(() => expect(getAuthStatus()).toBe(true));
		await waitFor(() => expect(transport.warning).toHaveBeenCalledTimes(1));
		expect(String(transport.warning.mock.calls[0]?.[0])).toContain(
			"did not keep the sign-in",
		);
		expect(getClaimPending()).toBe(false);
	});

	it("does not start a browser claim when storage is refused up front", async () => {
		denyStorage((key) => key.startsWith("auth"));
		render(Layout);
		expect(await screen.findByText(/cannot keep the sign-in/)).toBeTruthy();
		expect(screen.queryByLabelText("Setup code")).toBeNull();
		expect(transport.claimLocalOwner).not.toHaveBeenCalled();
	});

	it("keeps an unconfirmed claim on an owned box until the operator gives it up", async () => {
		transport.claimLocalOwner.mockImplementation(lost);
		transport.login.mockImplementation(lost);
		render(Layout);
		await claimWith();
		await screen.findByRole("button", { name: "Try again" });

		// Reconnect reports an owner; the retained secret is still the way in.
		publishStatus({});
		await tick();
		expect(retry()).toBeTruthy();
		expect(screen.queryByLabelText("Setup code")).toBeNull();
		await fireEvent.click(
			screen.getByRole("button", { name: "Use a password instead" }),
		);
		expect(getClaimPending()).toBe(false);
		expect(await screen.findByLabelText("Password")).toBeTruthy();
	});

	it("drops the retained secret when the page is hidden", async () => {
		transport.claimLocalOwner.mockImplementation(lost);
		transport.login.mockImplementation(lost);
		render(Layout);
		await claimWith();
		await screen.findByRole("button", { name: "Try again" });
		window.dispatchEvent(new PageTransitionEvent("pagehide"));
		expect(getClaimPending()).toBe(false);
		transport.login.mockClear();
		reconnect();
		await tick();
		expect(transport.login).not.toHaveBeenCalled();
	});

	it("moves a stale setup page to sign-in once the box reports an owner", async () => {
		render(Layout);
		expect(codeField()).toBeTruthy();
		// Another page claimed the box; this socket reconnects without setup.
		publishStatus({});
		expect(await screen.findByLabelText("Password")).toBeTruthy();
		expect(screen.queryByLabelText("Setup code")).toBeNull();
	});
});

describe("scanned setup codes", () => {
	function fakeLocation(hash: string) {
		const replaceState = vi.fn();
		const location = { hash, pathname: "/", search: "?x=1" } as Location;
		const history = { state: { k: 1 }, replaceState } as unknown as History;
		return { location, history, replaceState };
	}

	it("strips a code from the URL whatever the box state", () => {
		const { location, history, replaceState } = fakeLocation(
			`#claim=${CODE.toUpperCase()}`,
		);
		captureClaimFragment(location, history);
		expect(replaceState).toHaveBeenCalledWith({ k: 1 }, "", "/?x=1");
		expect(getScannedClaimCode()).toBe(CODE);
	});

	it("strips a malformed code without keeping it", () => {
		const { location, history, replaceState } = fakeLocation("#claim=nope");
		captureClaimFragment(location, history);
		expect(replaceState).toHaveBeenCalledTimes(1);
		expect(getScannedClaimCode()).toBeUndefined();
	});

	it("leaves other fragments to the router", () => {
		const { location, history, replaceState } = fakeLocation("#/settings");
		captureClaimFragment(location, history);
		expect(replaceState).not.toHaveBeenCalled();
	});

	it("fills the form on a box that offers setup", async () => {
		const { location, history } = fakeLocation(`#claim=${CODE}`);
		captureClaimFragment(location, history);
		render(Layout);
		await waitFor(() => expect(submit().hasAttribute("disabled")).toBe(false));
		expect(getScannedClaimCode()).toBeUndefined();
	});

	it("drops the code on a box without setup", async () => {
		publishStatus({ local_claim: "unavailable" });
		const { location, history } = fakeLocation(`#claim=${CODE}`);
		captureClaimFragment(location, history);
		render(Layout);
		await screen.findByText(/unavailable on this connection/);
		await tick();
		expect(getScannedClaimCode()).toBeUndefined();
	});
});
