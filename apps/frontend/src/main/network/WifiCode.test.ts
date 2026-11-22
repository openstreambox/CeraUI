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
	getHotspotLifetime,
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

function ap(macs: readonly string[], incarnation?: string): WifiInterface {
	return {
		ifname: "wlan0",
		conn: "hotspot-uuid",
		hw: "58:02:05:e1:79:1c",
		saved: {},
		mode: "hotspot",
		hotspot: {
			available_channels: { auto: { name: "Automatic" } },
			name: "Box",
			password: "correcthorse",
			channel: "auto",
			clients: { count: macs.length, stations: macs.map((mac) => ({ mac })) },
		},
		...(incarnation === undefined ? {} : { incarnation }),
	};
}

function roster(...macs: string[]): WifiStatus {
	return { "0": ap(macs) };
}

const owner = { device: "0", incarnation: undefined };
const A = { device: "0", incarnation: "radio-A" };
const B = { device: "1", incarnation: "radio-B" };

function twoHotspots(a: string[], b: string[]): WifiStatus {
	return { "0": ap(a, "radio-A"), "1": ap(b, "radio-B") };
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
		render(WifiCode, { name: "Box", password: "correcthorse", owner });
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
			owner,
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

describe("WifiCode — two hotspots", () => {
	it("a join on A while B is shown: B keeps its code, claims nothing, offers no renewal for it", async () => {
		noteHotspotRoster(
			twoHotspots(["aa:aa:aa:aa:aa:01"], ["bb:bb:bb:bb:bb:01"]),
		);
		const renewB = vi.fn();
		render(WifiCode, {
			name: "Box B",
			password: "password-b",
			owner: B,
			renew: { phase: "idle", streaming: false, onrenew: renewB },
		});
		await fireEvent.click(showButton());
		await flush();
		noteHotspotRoster(
			twoHotspots(
				["aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02"],
				["bb:bb:bb:bb:bb:01"],
			),
		);
		await flush();
		expect(screen.queryByTestId("wifi-code-joined")).toBeNull();
		expect(screen.queryByRole("button", { name: "Not mine?" })).toBeNull();
		expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
		expect(renewB).not.toHaveBeenCalled();
		// Nobody on screen speaks for A, so the app's toast does.
		expect(toast).toHaveBeenCalledTimes(1);
	});

	it("with both cards up, only A's card says it and only A's renewal is offered", async () => {
		noteHotspotRoster(
			twoHotspots(["aa:aa:aa:aa:aa:01"], ["bb:bb:bb:bb:bb:01"]),
		);
		const renewA = vi.fn();
		const renewB = vi.fn();
		render(WifiCode, {
			name: "Box A",
			password: "password-a",
			owner: A,
			renew: { phase: "idle", streaming: false, onrenew: renewA },
		});
		render(WifiCode, {
			name: "Box B",
			password: "password-b",
			owner: B,
			renew: { phase: "idle", streaming: false, onrenew: renewB },
		});
		noteHotspotRoster(
			twoHotspots(
				["aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02"],
				["bb:bb:bb:bb:bb:01"],
			),
		);
		await flush();
		expect(screen.getAllByTestId("wifi-code-joined")).toHaveLength(1);
		await fireEvent.click(screen.getByRole("button", { name: "Not mine?" }));
		await fireEvent.click(
			screen.getByRole("button", { name: "Change the password" }),
		);
		expect(renewA).toHaveBeenCalledTimes(1);
		expect(renewB).not.toHaveBeenCalled();
		expect(toast).not.toHaveBeenCalled();
	});

	it("rebinding a card to another hotspot drops its open question", async () => {
		noteHotspotRoster(
			twoHotspots(["aa:aa:aa:aa:aa:01"], ["bb:bb:bb:bb:bb:01"]),
		);
		const renewA = vi.fn();
		const renewB = vi.fn();
		const view = render(WifiCode, {
			name: "Box A",
			password: "password-a",
			owner: A,
			renew: { phase: "idle", streaming: false, onrenew: renewA },
		});
		noteHotspotRoster(
			twoHotspots(
				["aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02"],
				["bb:bb:bb:bb:bb:01"],
			),
		);
		await flush();
		await fireEvent.click(screen.getByRole("button", { name: "Not mine?" }));
		await view.rerender({
			name: "Box B",
			password: "password-b",
			owner: B,
			renew: { phase: "idle", streaming: false, onrenew: renewB },
		});
		await flush();
		expect(screen.queryByTestId("wifi-code-renew-confirm")).toBeNull();
		expect(screen.queryByTestId("wifi-code-joined")).toBeNull();
		expect(renewB).not.toHaveBeenCalled();
	});
});

describe("WifiCode — AP lifetime", () => {
	it("a Stop and Start drops the old lifetime's join line and open question, and hides the code", async () => {
		const live = (...macs: string[]) => ({ "0": ap(macs, "radio-A") });
		noteHotspotRoster(live());
		const first = getHotspotLifetime("0", ap([], "radio-A"));
		const onrenew = vi.fn();
		const view = render(WifiCode, {
			name: "Box",
			password: "correcthorse",
			owner: { ...A, lifetime: first },
			renew: { phase: "idle", streaming: false, onrenew },
		});
		noteHotspotRoster(live("aa:aa:aa:aa:aa:01"));
		await flush();
		await fireEvent.click(screen.getByRole("button", { name: "Not mine?" }));
		await fireEvent.click(showButton());
		await flush();
		expect(frame().dataset.shown).toBe("true");

		// Stop, then Start: the same radio, a new AP lifetime.
		noteHotspotRoster({
			"0": { ...ap([], "radio-A"), hotspot: undefined, mode: "station" },
		});
		noteHotspotRoster(live());
		const second = getHotspotLifetime("0", ap([], "radio-A"));
		expect(second).not.toBe(first);
		await view.rerender({
			name: "Box",
			password: "correcthorse",
			owner: { ...A, lifetime: second },
			renew: { phase: "idle", streaming: false, onrenew },
		});
		await flush();
		expect(screen.queryByTestId("wifi-code-joined")).toBeNull();
		expect(screen.queryByTestId("wifi-code-renew-confirm")).toBeNull();
		expect(frame().dataset.shown).toBe("false");
		expect(onrenew).not.toHaveBeenCalled();
	});

	it("a card still naming the earlier lifetime claims no join of the restarted AP", async () => {
		const live = (...macs: string[]) => ({ "0": ap(macs, "radio-A") });
		noteHotspotRoster(live());
		const first = getHotspotLifetime("0", ap([], "radio-A"));
		render(WifiCode, {
			name: "Box",
			password: "correcthorse",
			owner: { ...A, lifetime: first },
		});
		await fireEvent.click(showButton());
		await flush();
		noteHotspotRoster({
			"0": { ...ap([], "radio-A"), hotspot: undefined, mode: "station" },
		});
		noteHotspotRoster(live());
		noteHotspotRoster(live("aa:aa:aa:aa:aa:01"));
		await flush();
		expect(screen.queryByTestId("wifi-code-joined")).toBeNull();
		// Not this card's join: its code stays as the operator left it.
		expect(frame().dataset.shown).toBe("true");
		expect(toast).toHaveBeenCalledTimes(1);
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
