// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, expect, it, vi } from "vitest";
import CaptivePortal from "./CaptivePortal.svelte";

const { portal } = vi.hoisted(() => ({ portal: vi.fn() }));
vi.mock("$lib/rpc/client", () => ({ rpc: { wifi: { portal } } }));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getWifi: () => ({ "2": { conn: "saved", hw: "Wi-Fi 2" } }),
}));
beforeEach(() => {
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
		"The previous sign-in is still closing. Wait a moment, then retry.",
	],
	["not_on_box_wifi", "Join the box's own Wi-Fi, then try again."],
	[
		"Sign in from the box's Wi-Fi.",
		"Join the box's own Wi-Fi, then try again.",
	],
	[
		"busy_other_phone",
		"A sign-in window is already open. Close it before starting another.",
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
