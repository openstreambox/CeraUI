// @vitest-environment jsdom
/**
 * The adapter-mode answer is a pull. A hotspot started or stopped from the API,
 * another client or the device itself must still refresh it, or every surface
 * reading it keeps the old mode under a live AP.
 */
import type { WifiInterface, WifiStatus } from "@ceraui/rpc/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";

let captured: ((type: string, data: unknown, seq?: number) => void) | undefined;
const getAdapterModes = vi.fn(async () => ({}));
vi.mock("$lib/rpc/client", () => ({
	rpc: { wifi: { getAdapterModes: () => getAdapterModes() } },
	rpcClient: {
		onMessage: (h: (type: string, data: unknown, seq?: number) => void) => {
			captured = h;
			return () => {};
		},
		onConnectionChange: () => () => {},
		connect: () => {},
		getSocket: () => null,
		sendLegacy: () => {},
	},
}));

import { initSubscriptions, resetState } from "./subscriptions.svelte";
import {
	refreshWifiAdapterModes,
	wifiLiveApSignature,
} from "./wifi-adapter-modes.svelte";

function push(type: string, data: unknown): void {
	if (!captured) throw new Error("message handler was never registered");
	captured(type, data);
}

const SETUP = { name: "AP", password: "pw", available_channels: {} };

function radio(overrides: Partial<WifiInterface>): WifiStatus {
	return {
		"2": {
			ifname: "wlx00c0ca000001",
			conn: "",
			hw: "hw",
			saved: {},
			mode: "station",
			hotspot: SETUP,
			...overrides,
		} as WifiInterface,
	};
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(async () => {
	resetState();
	initSubscriptions();
	await settle();
	getAdapterModes.mockClear();
});

describe("external hotspot transitions refresh the adapter-mode answer", () => {
	it("a wifi snapshot whose radio became an AP pulls again", async () => {
		push("status", { wifi: radio({}) });
		await settle();
		expect(getAdapterModes).not.toHaveBeenCalled();

		push("status", {
			wifi: radio({
				mode: "hotspot",
				hotspot: { ...SETUP, clients: { count: 0, stations: [] } },
			}),
		});
		await settle();
		expect(getAdapterModes).toHaveBeenCalledTimes(1);
	});

	it("an unchanged snapshot (throughput ticks) does not pull", async () => {
		push("status", { wifi: radio({}) });
		push("status", { wifi: radio({ conn: "" }) });
		push("status", { wifi: radio({}) });
		await settle();
		expect(getAdapterModes).not.toHaveBeenCalled();
	});

	it("a terminal hotspot.start or hotspot.stop frame pulls, a pending one does not", async () => {
		push("wifi", { hotspot: { start: { device: 2, pending: true } } });
		await settle();
		expect(getAdapterModes).not.toHaveBeenCalled();

		push("wifi", { hotspot: { start: { device: 2, success: true } } });
		await settle();
		expect(getAdapterModes).toHaveBeenCalledTimes(1);

		push("wifi", { hotspot: { stop: { device: 2, success: true } } });
		await settle();
		expect(getAdapterModes).toHaveBeenCalledTimes(2);
	});
});

describe("refreshWifiAdapterModes coalesces without losing a change", () => {
	it("calls during an in-flight pull share it and get exactly one follow-up", async () => {
		let release: (() => void) | undefined;
		getAdapterModes.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve({});
				}),
		);
		const first = refreshWifiAdapterModes();
		await settle();
		const second = refreshWifiAdapterModes();
		const third = refreshWifiAdapterModes();
		expect(second).toBe(first);
		expect(third).toBe(first);
		release?.();
		await first;
		await settle();
		expect(getAdapterModes).toHaveBeenCalledTimes(2);
	});
});

describe("wifiLiveApSignature", () => {
	it("changes with mode, live-AP client read and transition, not with the saved setup", () => {
		const base = wifiLiveApSignature(radio({}));
		expect(wifiLiveApSignature(radio({ mode: "hotspot" }))).not.toBe(base);
		expect(wifiLiveApSignature(radio({ transition: "activating" }))).not.toBe(
			base,
		);
		expect(
			wifiLiveApSignature(
				radio({ hotspot: { ...SETUP, clients: { count: 1, stations: [] } } }),
			),
		).not.toBe(base);
		expect(
			wifiLiveApSignature(radio({ hotspot: { ...SETUP, name: "Renamed" } })),
		).toBe(base);
	});
});
