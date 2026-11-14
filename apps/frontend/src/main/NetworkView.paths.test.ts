// @vitest-environment jsdom

import { render } from "@testing-library/svelte";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ connected: true }));
const noop = vi.hoisted(() => async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("./network/BluetoothSection.svelte", noop);
vi.mock("./network/CellularSection.svelte", noop);
vi.mock("./network/CollisionBands.svelte", noop);
vi.mock("./network/EthernetSection.svelte", noop);
vi.mock("./network/HotspotSection.svelte", noop);
vi.mock("./network/SharingSection.svelte", noop);
vi.mock("./network/UnclaimedAdaptersBand.svelte", noop);
vi.mock("./network/WifiSection.svelte", noop);
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getIsConnected: () => state.connected,
	getStatus: () => ({ link_paths: { eth0: "ipv6" } }),
	getNetif: () => ({}),
	getWifi: () => ({}),
	getModems: () => ({}),
	getBluetooth: () => undefined,
	getCapabilities: () => undefined,
	getConfig: () => undefined,
	getLinkTelemetry: () => null,
	getSharingDiag: () => undefined,
	getUplinkShaper: () => undefined,
	getUplinkSteering: () => undefined,
	getUplinks: () => undefined,
}));
vi.mock("$lib/stores/hud.svelte", () => ({
	getHudState: () => ({
		links: [
			{
				id: "eth0",
				type: "ethernet",
				linkIndex: 0,
				signal: null,
				label: "eth0",
				isConnected: true,
				isStale: false,
				throughputKbps: 5000,
				enabled: true,
				connectionState: "connected",
			},
		],
		isFullyStale: false,
		staleInterfaces: new Set(),
		unbondedLinkCount: 0,
	}),
}));

import NetworkView from "./NetworkView.svelte";

it.each([true, false])(
	"marks retained receiver paths stale only when disconnected (connected=%s)",
	(connected) => {
		state.connected = connected;
		const { getByText, queryByText } = render(NetworkView);
		expect(
			getByText(connected ? "Native IPv6" : "Receiver path is out of date"),
		).toBeTruthy();
		expect(
			queryByText(connected ? "Receiver path is out of date" : "Native IPv6"),
		).toBeNull();
	},
);
