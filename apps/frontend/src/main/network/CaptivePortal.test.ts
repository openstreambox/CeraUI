// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, expect, it, vi } from "vitest";
import CaptivePortal from "./CaptivePortal.svelte";

const { portal, gate } = vi.hoisted(() => ({
	portal: vi.fn(),
	gate: { enabled: true as boolean | undefined },
}));
vi.mock("$lib/rpc/client", () => ({ rpc: { wifi: { portal } } }));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => ({ captive_portal_enabled: gate.enabled }),
	getWifi: () => ({ "2": { conn: "saved", hw: "Wi-Fi 2" } }),
}));
beforeEach(() => {
	gate.enabled = true;
	portal.mockReset();
	portal.mockResolvedValue({ phase: "idle" });
});
it("opens only the selected radio and lets the phone cancel", async () => {
	const close = vi.fn();
	const popup = { opener: {}, location: { href: "about:blank" }, close };
	vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
	const view = render(CaptivePortal);
	await waitFor(() =>
		expect(portal).toHaveBeenCalledWith({ action: "status" }),
	);
	await fireEvent.change(view.getByRole("combobox"), {
		target: { value: "2" },
	});
	portal.mockResolvedValue({ phase: "signing_in" });
	await fireEvent.click(
		view.getByRole("button", { name: "Open the hotel's page" }),
	);
	await waitFor(() =>
		expect(portal).toHaveBeenCalledWith({ action: "start", radio: 2 }),
	);
	expect(popup.location.href).toBe("http://www.gstatic.com/generate_204");
	expect(popup.opener).toBeNull();
	portal.mockResolvedValue({ phase: "needs_sign_in" });
	await fireEvent.click(view.getByRole("button", { name: "Cancel sign-in" }));
	await waitFor(() =>
		expect(portal).toHaveBeenCalledWith({ action: "finish" }),
	);
});

it.each([
	[
		"ipv4_required",
		"This sign-in needs IPv4. Reconnect to the box’s Wi-Fi, then try again.",
	],
	["not_captive", "This Wi-Fi does not need sign-in."],
	["wifi_changed", "The Wi-Fi changed. Choose it again, then retry."],
	[
		"identity_unavailable",
		"The box cannot confirm this Wi-Fi yet. Wait a moment, then retry.",
	],
	[
		"cleanup_required",
		"The previous sign-in could not be cleared. Try again later.",
	],
	["not_on_box_wifi", "Join the box's own Wi-Fi, then try again."],
	[
		"Sign in from the box's Wi-Fi.",
		"Join the box's own Wi-Fi, then try again.",
	],
	[
		"busy_other_phone",
		"Sign-in is open on another phone. It closes within ten minutes.",
	],
	[
		"wifi_unavailable",
		"This Wi-Fi is no longer connected. Connect it, then retry.",
	],
	[
		"unexpected",
		"The sign-in window could not be opened. Try again in a moment.",
	],
])("renders a calm reason for %s", async (reason, copy) => {
	vi.spyOn(window, "open").mockReturnValue(null);
	const view = render(CaptivePortal);
	await waitFor(() =>
		expect(portal).toHaveBeenCalledWith({ action: "status" }),
	);
	await fireEvent.change(view.getByRole("combobox"), {
		target: { value: "2" },
	});
	portal.mockRejectedValueOnce(new Error(reason));
	await fireEvent.click(
		view.getByRole("button", { name: "Open the hotel's page" }),
	);
	await waitFor(() => expect(view.getByRole("status").textContent).toBe(copy));
});

it("keeps an uncertain window closable and shows its expiry", async () => {
	portal.mockResolvedValue({
		phase: "cleanup_unknown",
		expiresAt: Date.now() + 600000,
	});
	const view = render(CaptivePortal);
	await waitFor(() =>
		expect(view.getByRole("button", { name: "Close again" })).toBeTruthy(),
	);
	expect(view.getByText(/Web forwarding ends by/)).toBeTruthy();
});

it("hides a forwarding deadline that has already passed", async () => {
	portal.mockResolvedValue({
		phase: "cleanup_unknown",
		expiresAt: Date.now() - 1000,
	});
	const view = render(CaptivePortal);
	await waitFor(() =>
		expect(view.getByRole("button", { name: "Close again" })).toBeTruthy(),
	);
	expect(view.queryByText(/Web forwarding ends by/)).toBeNull();
});

it.each([undefined, false])(
	"hides the experimental card when the gate is %s",
	async (enabled) => {
		gate.enabled = enabled;
		const view = render(CaptivePortal);
		expect(view.queryByRole("region")).toBeNull();
		expect(view.queryByRole("button")).toBeNull();
		expect(portal).not.toHaveBeenCalled();
	},
);

it("labels the venue selector with localized copy", () => {
	const view = render(CaptivePortal);
	expect(view.getByRole("combobox", { name: "Venue Wi-Fi" })).toBeTruthy();
});

it.each(["signing_in", "checking", "cleanup_unknown"])(
	"retains %s controls after the gate is disabled",
	async (phase) => {
		portal.mockResolvedValue({ phase });
		const view = render(CaptivePortal);
		await waitFor(() => expect(view.getByRole("region")).toBeTruthy());
		gate.enabled = false;
		portal.mockResolvedValue({ phase });
		await new Promise((resolve) => setTimeout(resolve, 3100));
		await waitFor(() => expect(view.getByRole("region")).toBeTruthy());
		expect(view.queryByRole("combobox")).toBeNull();
		if (phase !== "checking") {
			portal.mockResolvedValue({ phase: "needs_sign_in" });
			await fireEvent.click(
				view.getByRole("button", {
					name: phase === "signing_in" ? "Cancel sign-in" : "Close again",
				}),
			);
			await waitFor(() => expect(view.queryByRole("region")).toBeNull());
		}
	},
);
it("offers a privacy-settings hint while signing in", async () => {
	portal.mockResolvedValue({ phase: "signing_in" });
	const view = render(CaptivePortal);
	await waitFor(() =>
		expect(
			view.getByText(
				/temporarily pause VPN, Private Relay or Private DNS \/ secure DNS/,
			),
		).toBeTruthy(),
	);
});

it.each([
	"idle",
	"checking",
	"web_available",
	"needs_sign_in",
	"cleanup_unknown",
])("hides the privacy hint in phase %s", async (phase) => {
	portal.mockResolvedValue({ phase });
	const view = render(CaptivePortal);
	await waitFor(() =>
		expect(portal).toHaveBeenCalledWith({ action: "status" }),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(view.queryByText(/temporarily pause VPN/)).toBeNull();
});
