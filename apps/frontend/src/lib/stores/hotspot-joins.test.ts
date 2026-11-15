/**
 * The join notice reuses the app's toast and nothing else, and stays quiet while
 * a Wi-Fi code card is on screen (the card says it in place).
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

function roster(...macs: string[]): WifiStatus {
	const iface: WifiInterface = {
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
	};
	return { "0": iface };
}

afterEach(() => {
	resetHotspotJoinsForTest();
	toast.mockReset();
});

describe("hotspot join notice", () => {
	it("toasts once per reading with a new device, never for the baseline", () => {
		noteHotspotRoster(roster("aa:aa:aa:aa:aa:01"), 1_000);
		expect(toast).not.toHaveBeenCalled();
		expect(getLastHotspotJoin()).toBeNull();

		noteHotspotRoster(roster("aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02"), 2_000);
		expect(toast).toHaveBeenCalledTimes(1);
		expect(toast).toHaveBeenCalledWith("A new device joined the box's Wi-Fi", {
			description:
				"Not yours? Choose New Wi-Fi password in the box's Wi-Fi settings.",
		});
		expect(getLastHotspotJoin()).toEqual({ at: 2_000, seq: 1 });

		noteHotspotRoster(roster("aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02"), 3_000);
		expect(toast).toHaveBeenCalledTimes(1);
	});

	it("leaves the notice to a mounted Wi-Fi code card", () => {
		noteHotspotRoster(roster(), 1_000);
		const unregister = registerWifiCodeCard();
		noteHotspotRoster(roster("aa:aa:aa:aa:aa:01"), 2_000);
		expect(toast).not.toHaveBeenCalled();
		expect(getLastHotspotJoin()?.seq).toBe(1);

		unregister();
		unregister();
		noteHotspotRoster(roster("aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02"), 3_000);
		expect(toast).toHaveBeenCalledTimes(1);
		expect(getLastHotspotJoin()?.seq).toBe(2);
	});
});
