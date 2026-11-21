// @vitest-environment jsdom
/**
 * Auth.svelte — the first-run password minimum is helper text, not placeholder.
 *
 * At 390 px the create-password placeholder was cut mid-sentence ("Create a
 * secure password (min"), so the one rule the field enforces was the part a
 * phone could not show. The minimum now sits under the field as helper text the
 * field is described by, and the placeholder is short. The same line turns into
 * the error while the entry is too short, so the rule is never said twice.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getNotificationsFeed,
	getStatusFeed,
	publishNotifications,
	publishStatus,
	resetAuthFeeds,
} from "./__fixtures__/auth-feed.svelte";
import Auth from "./Auth.svelte";

const authenticate = vi.hoisted(() => vi.fn());
const createPassword = vi.hoisted(() => vi.fn());

vi.mock("$lib/config", () => ({
	deviceName: "CeraLive",
	siteName: "ceralive.tv",
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const feed = await import("./__fixtures__/auth-feed.svelte");
	return {
		getStatus: feed.getStatusFeed,
		getNotifications: feed.getNotificationsFeed,
	};
});

vi.mock("$lib/stores/auth-status.svelte", () => ({
	authenticate,
	createPassword,
	clearAuthInteraction: vi.fn(),
	subscribeAuthStatus: () => () => undefined,
}));

vi.mock("$lib/stores/connection-ux.svelte", () => ({
	getSessionExpired: () => false,
}));

vi.mock("$lib/stores/offline-state.svelte", () => ({
	getConnectionState: () => "connected",
}));

const passwordField = () =>
	document.querySelector<HTMLInputElement>("#password");
const confirmField = () =>
	document.querySelector<HTMLInputElement>("#confirm-password");
const inlineError = () => document.querySelector("#password-error");

beforeEach(() => {
	resetAuthFeeds();
	localStorage.clear();
	authenticate.mockReset();
	createPassword.mockReset();
	authenticate.mockResolvedValue({ kind: "ok" });
	createPassword.mockResolvedValue(true);
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("Auth — create-password helper text", () => {
	async function createForm() {
		render(Auth);
		publishStatus({ set_password: true } as never);
		await waitFor(() => expect(confirmField()).not.toBeNull());
	}

	it("states the minimum length under the field and links it to the field", async () => {
		await createForm();
		const hint = document.querySelector("#password-hint");
		expect(hint?.textContent?.trim()).toBe("Use at least 8 characters");
		expect(passwordField()?.getAttribute("aria-describedby")).toBe(
			"password-hint",
		);
	});

	it("keeps the placeholder short enough for a phone", async () => {
		await createForm();
		const placeholder = passwordField()?.getAttribute("placeholder") ?? "";
		expect(placeholder).toBe("Create a password");
		expect(placeholder).not.toMatch(/8|min/i);
	});

	it("shows the rule once: the helper becomes the error while too short", async () => {
		await createForm();
		const field = passwordField() as HTMLInputElement;
		await fireEvent.input(field, { target: { value: "short" } });
		await waitFor(() => expect(inlineError()).not.toBeNull());
		expect(document.querySelector("#password-hint")).toBeNull();
		expect(field.getAttribute("aria-describedby")).toBe("password-error");
	});

	it("shows no helper on the sign-in form", async () => {
		render(Auth);
		publishStatus({ set_password: false } as never);
		await waitFor(() => expect(passwordField()).not.toBeNull());
		expect(document.querySelector("#password-hint")).toBeNull();
	});
});
