/**
 * The join notice reuses the app's toast and nothing else, and stays quiet while
 * a Wi-Fi code card for the hotspot that was joined is on screen (the card says
 * it in place). A card for another hotspot never claims the join.
 */
import type { WifiInterface, WifiStatus } from "@ceraui/rpc/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => vi.fn());
vi.mock("svelte-sonner", () => ({ toast }));

import {
	getLastHotspotJoin,
	noteHotspotRoster,
	registerWifiCodeCard,
	resetHotspotJoinsForTest,
} from "./hotspot-joins.svelte";

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

const HOTSPOT_0 = { device: "0", incarnation: undefined };
const A = { device: "0", incarnation: "radio-A" };
const B = { device: "1", incarnation: "radio-B" };

function twoHotspots(a: string[], b: string[]): WifiStatus {
	return { "0": ap(a, "radio-A"), "1": ap(b, "radio-B") };
}

afterEach(() => {
	resetHotspotJoinsForTest();
	toast.mockReset();
});

describe("hotspot join notice", () => {
	it("toasts once per reading with a new device, never for the baseline", () => {
		noteHotspotRoster(roster("aa:aa:aa:aa:aa:01"), 1_000);
		expect(toast).not.toHaveBeenCalled();
		expect(getLastHotspotJoin(HOTSPOT_0)).toBeNull();

		noteHotspotRoster(roster("aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02"), 2_000);
		expect(toast).toHaveBeenCalledTimes(1);
		expect(toast).toHaveBeenCalledWith("A new device joined the box's Wi-Fi", {
			description:
				"Not yours? Choose New Wi-Fi password in the box's Wi-Fi settings.",
		});
		expect(getLastHotspotJoin(HOTSPOT_0)).toEqual({
			device: "0",
			incarnation: undefined,
			at: 2_000,
			seq: 1,
		});

		noteHotspotRoster(roster("aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02"), 3_000);
		expect(toast).toHaveBeenCalledTimes(1);
	});

	it("leaves the notice to a mounted Wi-Fi code card", () => {
		noteHotspotRoster(roster(), 1_000);
		const unregister = registerWifiCodeCard(HOTSPOT_0);
		noteHotspotRoster(roster("aa:aa:aa:aa:aa:01"), 2_000);
		expect(toast).not.toHaveBeenCalled();
		expect(getLastHotspotJoin(HOTSPOT_0)?.seq).toBe(1);

		unregister();
		unregister();
		noteHotspotRoster(roster("aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02"), 3_000);
		expect(toast).toHaveBeenCalledTimes(1);
		expect(getLastHotspotJoin(HOTSPOT_0)?.seq).toBe(2);
	});

	it("with two hotspots, a join on A is A's: B's card neither claims it nor hides the toast", () => {
		noteHotspotRoster(
			twoHotspots(["aa:aa:aa:aa:aa:01"], ["bb:bb:bb:bb:bb:01"]),
		);
		const unregister = registerWifiCodeCard(B);
		noteHotspotRoster(
			twoHotspots(
				["aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02"],
				["bb:bb:bb:bb:bb:01"],
			),
			2_000,
		);
		expect(getLastHotspotJoin(B)).toBeNull();
		expect(getLastHotspotJoin(A)).toMatchObject({
			device: "0",
			incarnation: "radio-A",
			at: 2_000,
		});
		// No card for A is on screen, so the app's toast says it.
		expect(toast).toHaveBeenCalledTimes(1);
		unregister();
	});

	it("a card for A takes A's join in place while B's card stays quiet", () => {
		noteHotspotRoster(
			twoHotspots(["aa:aa:aa:aa:aa:01"], ["bb:bb:bb:bb:bb:01"]),
		);
		registerWifiCodeCard(A);
		registerWifiCodeCard(B);
		noteHotspotRoster(
			twoHotspots(
				["aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02"],
				["bb:bb:bb:bb:bb:01"],
			),
		);
		expect(toast).not.toHaveBeenCalled();
		expect(getLastHotspotJoin(A)).not.toBeNull();
		expect(getLastHotspotJoin(B)).toBeNull();
	});

	it("a join on a new radio incarnation is not the old radio's", () => {
		noteHotspotRoster({ "0": ap(["aa:aa:aa:aa:aa:01"], "radio-A") });
		registerWifiCodeCard(A);
		noteHotspotRoster({
			"0": ap(["aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02"], "radio-C"),
		});
		expect(getLastHotspotJoin(A)).toBeNull();
		expect(toast).toHaveBeenCalledTimes(1);
	});
});
