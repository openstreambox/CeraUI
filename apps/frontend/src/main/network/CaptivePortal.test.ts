// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, expect, it, vi } from "vitest";
import { NotSentError } from "$lib/rpc/rpc-error";
import CaptivePortal from "./CaptivePortal.svelte";

const venue = {
	ifname: "wlan2",
	conn: "saved",
	hw: "Wi-Fi 2",
	mode: "station",
	incarnation: "venue-2",
} as Record<string, unknown>;
const { portal, gate, wifi, uplinks } = vi.hoisted(() => ({
	portal: vi.fn(),
	gate: { enabled: true as boolean | undefined },
	wifi: { rows: {} as Record<string, Record<string, unknown>> },
	uplinks: { rows: [] as Array<Record<string, unknown>> },
}));
vi.mock("$lib/rpc/client", () => ({ rpc: { wifi: { portal } } }));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => ({ captive_portal_enabled: gate.enabled }),
	getWifi: () => wifi.rows,
	getUplinks: () => uplinks.rows,
}));
beforeEach(() => {
	gate.enabled = true;
	wifi.rows = { "2": { ...venue } };
	uplinks.rows = [
		{ iface: "wlan2", kind: "wifi", state: "down", reason: "captive_portal" },
	];
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
		expect(portal).toHaveBeenCalledWith({
			action: "start",
			radio: 2,
			incarnation: "venue-2",
		}),
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
		"A sign-in is already in progress. Try again in a moment. An open sign-in window closes within ten minutes.",
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

// The shapes a box with two USB radios reports: both carry the hotspot
// capability object, only one runs the hotspot.
it("offers a station radio that can also host a hotspot, not the hotspot radio", async () => {
	const capability = {
		available_channels: {},
		available_security: {},
		max_width_mhz: 80,
	};
	wifi.rows = {
		"1": {
			ifname: "wlan1",
			incarnation: "hotspot-1",
			conn: "hotspot-profile",
			hw: "Hotspot radio",
			mode: "hotspot",
			hotspot: { ...capability, name: "Box", channel: "auto", clients: [] },
		},
		"2": {
			ifname: "wlan2",
			incarnation: "venue-2",
			conn: "venue-profile",
			hw: "Venue radio",
			mode: "station",
			hotspot: capability,
		},
	};
	uplinks.rows = [
		{ iface: "wlan1", kind: "wifi", state: "down", reason: "captive_portal" },
		{ iface: "wlan2", kind: "wifi", state: "down", reason: "captive_portal" },
	];
	const view = render(CaptivePortal);
	const options = await view.findAllByRole("option");
	expect(options.map((o) => o.textContent)).toEqual([
		"Choose Wi-Fi",
		"Venue radio",
	]);
});

it("offers a qualified hybrid row that also hosts the box's AP", () => {
	wifi.rows = {
		"2": {
			...venue,
			supports_ap_sta_concurrency: true,
			hotspot: { name: "Box AP", available_channels: {} },
		},
		"3": {
			ifname: "wlan3",
			conn: "ap-profile",
			hw: "AP radio",
			mode: "hotspot",
			incarnation: "ap-3",
			hotspot: { name: "Box AP", available_channels: {} },
		},
	};
	uplinks.rows = [
		{ iface: "wlan2", kind: "wifi", state: "down", reason: "captive_portal" },
		{ iface: "wlan3", kind: "wifi", state: "down", reason: "captive_portal" },
	];
	const view = render(CaptivePortal);
	const options = view
		.getAllByRole("option")
		.map((option) => (option as HTMLOptionElement).value);
	expect(options).toEqual(["", "2"]);
});

it.each([
	["an AP-only row", { mode: "hotspot" }],
	["a row without a station connection", { conn: "" }],
	["a degraded radio", { degraded_reason: "permanent-mac-unresolved" }],
	["a row without a published identity", { incarnation: undefined }],
])("hides %s", (_name, changes) => {
	wifi.rows = { "2": { ...venue, ...changes } };
	const view = render(CaptivePortal);
	expect(view.queryByRole("region")).toBeNull();
});

it("hides a connected station that does not read captive", () => {
	uplinks.rows = [{ iface: "wlan2", kind: "wifi", state: "up" }];
	const view = render(CaptivePortal);
	expect(view.queryByRole("region")).toBeNull();
});

it("a changed Wi-Fi must be chosen again before retrying", async () => {
	vi.spyOn(window, "open").mockReturnValue(null);
	const view = render(CaptivePortal);
	await waitFor(() =>
		expect(portal).toHaveBeenCalledWith({ action: "status" }),
	);
	await fireEvent.change(view.getByRole("combobox"), {
		target: { value: "2" },
	});
	const open = view.getByRole("button", { name: "Open the hotel's page" });
	expect((open as HTMLButtonElement).disabled).toBe(false);
	portal.mockRejectedValueOnce(new Error("wifi_changed"));
	await fireEvent.click(open);
	await waitFor(() =>
		expect(view.getByRole("status").textContent).toBe(
			"The Wi-Fi changed. Choose it again, then retry.",
		),
	);
	expect((view.getByRole("combobox") as HTMLSelectElement).value).toBe("");
	expect((open as HTMLButtonElement).disabled).toBe(true);
});

it("asks to try again when the action was dropped by a reconnect", async () => {
	const view = render(CaptivePortal);
	await waitFor(() =>
		expect(portal).toHaveBeenCalledWith({ action: "status" }),
	);
	await fireEvent.change(view.getByRole("combobox"), {
		target: { value: "2" },
	});
	vi.spyOn(window, "open").mockReturnValue(null);
	portal.mockRejectedValue(new NotSentError("reconnected"));
	await fireEvent.click(
		view.getByRole("button", { name: "Open the hotel's page" }),
	);
	await waitFor(() =>
		expect(view.getByRole("status").textContent).toBe(
			"The connection to the box was restored. Try again.",
		),
	);
});
