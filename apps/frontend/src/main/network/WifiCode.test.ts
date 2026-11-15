// @vitest-environment jsdom
/**
 * The box's Wi-Fi code never sits on screen by itself: hidden behind Show code,
 * off-camera reminder while shown, and it hides itself (2 minutes, focus lost,
 * a join, a new password). New Wi-Fi password always asks first and names the
 * cost; with a stream that may go through the box, it names that too.
 */
import type { WifiInterface, WifiStatus } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toDataURL = vi.hoisted(() =>
	vi.fn(async () => "data:image/png;base64,QR"),
);
vi.mock("qrcode", () => ({ default: { toDataURL } }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("svelte-sonner", () => ({ toast }));

import {
	noteHotspotRoster,
	resetHotspotJoinsForTest,
} from "$lib/stores/hotspot-joins.svelte";

import WifiCode, { WIFI_CODE_SHOW_MS } from "./WifiCode.svelte";

const flush = async () => {
	await tick();
	await Promise.resolve();
	await Promise.resolve();
	await tick();
};

function roster(...macs: string[]): WifiStatus {
	const iface: WifiInterface = {
		ifname: "wlan0",
		conn: "hotspot-uuid",
		hw: "58:02:05:e1:79:1c",
		saved: {},
		mode: "hotspot",
		hotspot: {
			name: "Box",
			password: "correcthorse",
			channel: "auto",
			clients: { count: macs.length, stations: macs.map((mac) => ({ mac })) },
		},
	};
	return { "0": iface };
}

const showButton = () => screen.getByRole("button", { name: "Show code" });
const frame = () => screen.getByTestId("wifi-code-frame");

beforeEach(() => {
	resetHotspotJoinsForTest();
});
afterEach(() => {
	vi.useRealTimers();
	toDataURL.mockClear();
	toast.mockReset();
});

describe("WifiCode — hidden by default", () => {
	it("starts hidden: an empty frame, Show code, no picture", () => {
		render(WifiCode, { name: "Box", password: "correcthorse" });
		const button = showButton();
		expect(button.getAttribute("aria-expanded")).toBe("false");
		expect(button.getAttribute("aria-controls")).toBe(frame().id);
		expect(frame().querySelector("img")).toBeNull();
		expect(screen.queryByText(/Keep this off camera/)).toBeNull();
		expect(toDataURL).not.toHaveBeenCalled();
	});

	it("Show reveals the QR with the off-camera line; Hide takes Show's place", async () => {
		render(WifiCode, {
			name: "Box",
			password: "correcthorse",
			security: "wpa2",
		});
		await fireEvent.click(showButton());
		await flush();
		expect(frame().querySelector("img")?.getAttribute("src")).toBe(
			"data:image/png;base64,QR",
		);
		expect(toDataURL.mock.calls[0]?.[0]).toBe(
			"WIFI:T:WPA;S:Box;P:correcthorse;;",
		);
		expect(
			screen.getByText(
				"Keep this off camera. It hides itself after 2 minutes.",
			),
		).toBeTruthy();
		const hide = screen.getByRole("button", { name: "Hide" });
		expect(hide.getAttribute("aria-expanded")).toBe("true");
		await fireEvent.click(hide);
		await flush();
		expect(frame().querySelector("img")).toBeNull();
		expect(showButton()).toBeTruthy();
	});

	it("hides itself after two minutes", async () => {
		vi.useFakeTimers();
		render(WifiCode, { name: "Box", password: "correcthorse" });
		await fireEvent.click(showButton());
		await flush();
		vi.advanceTimersByTime(WIFI_CODE_SHOW_MS - 1);
		await flush();
		expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
		vi.advanceTimersByTime(1);
		await flush();
		expect(showButton().getAttribute("aria-expanded")).toBe("false");
	});

	it("hides itself when the page loses focus", async () => {
		render(WifiCode, { name: "Box", password: "correcthorse" });
		await fireEvent.click(showButton());
		await flush();
		window.dispatchEvent(new Event("blur"));
		await flush();
		expect(showButton().getAttribute("aria-expanded")).toBe("false");
	});

	it("hides itself when the password changes", async () => {
		const view = render(WifiCode, { name: "Box", password: "correcthorse" });
		await fireEvent.click(showButton());
		await flush();
		await view.rerender({ name: "Box", password: "brand-new-pass" });
		await flush();
		expect(showButton().getAttribute("aria-expanded")).toBe("false");
	});

	it("a screen without a QR (phone, kiosk) shows no code and no Show", () => {
		render(WifiCode, { name: "Box", password: "correcthorse", qr: false });
		expect(screen.queryByRole("button", { name: "Show code" })).toBeNull();
		expect(screen.queryByTestId("wifi-code-frame")).toBeNull();
	});

	it("cannot show a code it does not have", () => {
		render(WifiCode, { name: "Box" });
		expect(showButton()).toHaveProperty("disabled", true);
	});
});

describe("WifiCode — join notice", () => {
	it("a join hides the code and says so in place, instead of a toast", async () => {
		noteHotspotRoster(roster("aa:aa:aa:aa:aa:01"));
		render(WifiCode, { name: "Box", password: "correcthorse" });
		await fireEvent.click(showButton());
		await flush();
		noteHotspotRoster(roster("aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02"));
		await flush();
		expect(showButton().getAttribute("aria-expanded")).toBe("false");
		expect(screen.getByTestId("wifi-code-joined").textContent).toContain(
			"A new device joined · just now",
		);
		expect(toast).not.toHaveBeenCalled();
	});

	it("Not mine? opens the New Wi-Fi password confirmation", async () => {
		noteHotspotRoster(roster());
		const onrenew = vi.fn();
		render(WifiCode, {
			name: "Box",
			password: "correcthorse",
			renew: { phase: "idle", streaming: false, onrenew },
		});
		noteHotspotRoster(roster("aa:aa:aa:aa:aa:01"));
		await flush();
		await fireEvent.click(screen.getByRole("button", { name: "Not mine?" }));
		expect(
			screen.getByRole("group", { name: "Make a new Wi-Fi password?" }),
		).toBeTruthy();
		expect(onrenew).not.toHaveBeenCalled();
	});
});

describe("WifiCode — New Wi-Fi password", () => {
	it("asks first, names the cost, and only then renews", async () => {
		const onrenew = vi.fn();
		render(WifiCode, {
			name: "Box",
			password: "correcthorse",
			renew: { phase: "idle", streaming: false, onrenew },
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "New Wi-Fi password" }),
		);
		expect(
			screen.getByText(
				"Every device on the box's Wi-Fi drops and has to join again with the new code.",
			),
		).toBeTruthy();
		expect(screen.queryByText(/that stream drops/)).toBeNull();
		await fireEvent.click(
			screen.getByRole("button", { name: "Keep this one" }),
		);
		expect(onrenew).not.toHaveBeenCalled();

		await fireEvent.click(
			screen.getByRole("button", { name: "New Wi-Fi password" }),
		);
		await fireEvent.click(
			screen.getByRole("button", { name: "Change the password" }),
		);
		expect(onrenew).toHaveBeenCalledTimes(1);
	});

	it("names the stream that may go through the box", async () => {
		render(WifiCode, {
			name: "Box",
			password: "correcthorse",
			renew: { phase: "idle", streaming: true, onrenew: vi.fn() },
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "New Wi-Fi password" }),
		);
		expect(
			screen.getByText(
				"If your phone is streaming through the box, that stream drops",
			),
		).toBeTruthy();
		// Never as if the stream were already off.
		expect(screen.queryByText(/not live|offline/i)).toBeNull();
	});

	it("shows progress, then that the new password is set", async () => {
		const onrenew = vi.fn();
		const view = render(WifiCode, {
			name: "Box",
			password: "correcthorse",
			renew: { phase: "idle", streaming: false, onrenew },
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "New Wi-Fi password" }),
		);
		await fireEvent.click(
			screen.getByRole("button", { name: "Change the password" }),
		);
		await view.rerender({
			name: "Box",
			password: "correcthorse",
			renew: { phase: "pending", streaming: false, onrenew },
		});
		await flush();
		const pending = screen.getByRole("button", {
			name: /Changing the password/,
		});
		expect(pending).toHaveProperty("disabled", true);
		await view.rerender({
			name: "Box",
			password: "fresh-password",
			renew: { phase: "confirmed", streaming: false, onrenew },
		});
		await flush();
		expect(screen.getByTestId("wifi-code-renewed").textContent).toContain(
			"New password set. Join again with the new code.",
		);
	});

	it("offers no renewal when the hotspot cannot take one", () => {
		render(WifiCode, { name: "Box", password: "correcthorse" });
		expect(
			screen.queryByRole("button", { name: "New Wi-Fi password" }),
		).toBeNull();
	});
});
