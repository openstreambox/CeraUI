// @vitest-environment jsdom
/**
 * WifiSection — a saved Hybrid choice on a radio that cannot run it.
 *
 * The device keeps the persisted `hybrid` preference and the hotspot settings,
 * stays a station and starts no AP. The row has to say so (the mode popover may
 * be closed) and offer the explicit exclusive-hotspot switch, which still goes
 * through the #413 credential gate and dispatches `setAdapterMode('hotspot')`.
 */
import type {
	NetifMessage,
	WifiAdapterModeEntry,
	WifiInterface,
} from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearOperation,
	destroyAsyncOperations,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";
import {
	resetWifiAdapterModes,
	setWifiAdapterModesForTest,
} from "$lib/rpc/wifi-adapter-modes.svelte";

import WifiModeSelector from "./WifiModeSelector.svelte";
import WifiSection from "./WifiSection.svelte";
import { deriveWifiAdapterModeView } from "./wifi-adapter-mode-view";

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		network: { configure: vi.fn() },
		wifi: {
			hotspotStart: vi.fn(),
			hotspotStop: vi.fn(),
			hotspotPrepare: vi.fn(async () => ({
				success: true,
				name: "Saved AP",
				password: "saved-password",
			})),
			getAdapterModes: vi.fn(async () => ({})),
			setAdapterMode: vi.fn(async () => ({ success: true, accepted: true })),
		},
	},
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));

const UNQUALIFIED = [
	{ mode: "station" as const, available: true },
	{ mode: "hotspot" as const, available: true },
	{
		mode: "hybrid" as const,
		available: false,
		reason: "capability-unknown" as const,
	},
];

/** The pull the row refreshes on mount answers the same entry the test seeds. */
function seedModes(entry: WifiAdapterModeEntry): void {
	setWifiAdapterModesForTest({ wifi0: entry });
	vi.mocked(rpc.wifi.getAdapterModes).mockResolvedValue({ wifi0: entry });
}

function renderSection(overrides: Partial<WifiInterface> = {}) {
	const iface = {
		incarnation: "radio-A",
		ifname: "wlan0",
		conn: "MyNet",
		hw: "hw0",
		mode: "station",
		available: [
			{ active: true, ssid: "MyNet", signal: 72, security: "WPA2", freq: 5200 },
		],
		saved: {},
		supports_hotspot: true,
		...overrides,
	} as WifiInterface;
	return render(WifiSection, {
		props: {
			wifiRadios: [["wifi0", iface]],
			netif: {
				wlan0: { tp: 1000, enabled: true, ip: "192.168.1.5" },
			} as unknown as NetifMessage,
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConnect: vi.fn(),
			onOpenCountry: vi.fn(),
		},
	});
}

beforeEach(() => {
	initAsyncOperations();
	resetWifiAdapterModes();
});

afterEach(() => {
	clearOperation("wifi-mode:wifi0");
	destroyAsyncOperations();
	resetWifiAdapterModes();
	vi.clearAllMocks();
});

describe("WifiSection — a saved hybrid this radio cannot run", () => {
	it("states the refusal on the row and switches to an exclusive hotspot only through the credential gate", async () => {
		seedModes({
			ifname: "wlan0",
			mode: "station",
			desired: "hybrid",
			options: UNQUALIFIED,
		});
		const { getByTestId, queryByTestId } = renderSection();

		const band = getByTestId("wifi-mode-saved-hybrid-wifi0");
		expect(band.getAttribute("role")).toBe("status");
		expect(band.textContent).not.toContain("network.wifiMode.");
		expect(band.textContent).toContain("Hybrid");
		// The popover is closed: the row is the only place this can be seen.
		expect(queryByTestId("wifi-mode-selector")).toBeNull();

		const switchButton = getByTestId("wifi-mode-saved-hybrid-switch-wifi0");
		expect(switchButton.textContent?.trim()).toBe("Switch to Hotspot");
		await fireEvent.click(switchButton);
		await tick();

		// The selector opens straight onto the activation gate, withholding its
		// own copy of the band, and nothing is dispatched before acknowledgement.
		expect(getByTestId("wifi-mode-selector")).toBeTruthy();
		expect(
			document.querySelectorAll('[data-testid="wifi-mode-saved-hybrid-wifi0"]'),
		).toHaveLength(1);
		expect(rpc.wifi.setAdapterMode).not.toHaveBeenCalled();
		const gate = await vi.waitFor(() => {
			const el = document.querySelector<HTMLElement>(
				'[data-testid="hotspot-activation-confirm"][data-phase="ready"]',
			);
			if (!el) throw new Error("the credential gate is not ready");
			return el;
		});
		const ack = gate.querySelector<HTMLElement>('[role="checkbox"]');
		if (!ack) throw new Error("no acknowledgement checkbox");
		await fireEvent.click(ack);
		await tick();
		const activate = gate.querySelector<HTMLElement>(
			'[data-testid="hotspot-confirm-activate"]',
		);
		if (!activate) throw new Error("no confirm button");
		await fireEvent.click(activate);
		await tick();
		expect(rpc.wifi.setAdapterMode).toHaveBeenCalledWith({
			device: "wifi0",
			incarnation: "radio-A",
			mode: "hotspot",
		});
	});

	it("offers no switch when the radio cannot host an exclusive hotspot either", () => {
		seedModes({
			ifname: "wlan0",
			mode: "station",
			desired: "hybrid",
			options: [
				{ mode: "station", available: true },
				{ mode: "hotspot", available: false, reason: "unsupported" },
				{ mode: "hybrid", available: false, reason: "unsupported" },
			],
		});
		const { getByTestId, queryByTestId } = renderSection({
			supports_hotspot: false,
		});
		expect(getByTestId("wifi-mode-saved-hybrid-wifi0")).toBeTruthy();
		expect(queryByTestId("wifi-mode-saved-hybrid-switch-wifi0")).toBeNull();
	});

	it("stays silent for a station preference on the same radio", () => {
		seedModes({
			ifname: "wlan0",
			mode: "station",
			desired: "station",
			options: UNQUALIFIED,
		});
		const { queryByTestId } = renderSection();
		expect(queryByTestId("wifi-mode-saved-hybrid-wifi0")).toBeNull();
	});
});

describe("WifiModeSelector — the inline placement", () => {
	it("renders the band itself and its switch opens the activation gate", async () => {
		const view = deriveWifiAdapterModeView({
			device: "wifi0",
			iface: {
				incarnation: "radio-A",
				ifname: "wlan0",
				conn: "MyNet",
				hw: "hw0",
				mode: "station",
				available: [],
				saved: {},
				supports_hotspot: true,
			} as WifiInterface,
			entry: {
				ifname: "wlan0",
				mode: "station",
				desired: "hybrid",
				options: UNQUALIFIED,
			},
			phase: "idle",
		});
		const { getByTestId, queryByTestId } = render(WifiModeSelector, {
			props: {
				view,
				context: { stationLinkLive: true, hotspotLive: false },
			},
		});
		expect(getByTestId("wifi-mode-saved-hybrid-wifi0")).toBeTruthy();
		expect(queryByTestId("hotspot-activation-confirm")).toBeNull();
		await fireEvent.click(getByTestId("wifi-mode-saved-hybrid-switch-wifi0"));
		await tick();
		expect(getByTestId("hotspot-activation-confirm")).toBeTruthy();
		expect(rpc.wifi.setAdapterMode).not.toHaveBeenCalled();
	});
});
