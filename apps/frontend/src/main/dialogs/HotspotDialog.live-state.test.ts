// @vitest-environment jsdom
/**
 * The dialog says what is on right now, whoever turned it on.
 *
 * A current device sends the saved hotspot setup on every radio that can host
 * one, on or off. The dialog used to read that block as "the AP is up", so a
 * radio configured off in Station mode was labelled Active with a Turn Off
 * action. And because the mode badge reads the adapter-mode PULL, a Start from
 * the API or another client left the open dialog showing Station under a live
 * AP. Both are asserted here against the rendered DOM.
 */
import type { WifiAdapterModeStatus, WifiInterface } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	destroyAsyncOperations,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import {
	resetWifiAdapterModes,
	setWifiAdapterModesForTest,
} from "$lib/rpc/wifi-adapter-modes.svelte";
import HotspotDialog from "./HotspotDialog.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		wifi: {
			hotspotStart: vi.fn(async () => ({ success: true, accepted: true })),
			hotspotStop: vi.fn(async () => ({ success: true })),
			hotspotDelete: vi.fn(async () => ({ success: true })),
			hotspotPrepare: vi.fn(async () => ({
				success: true,
				name: "CERALIVE_ef48",
				password: "Xk7mQ2pR9tLw",
			})),
			hotspotConfigure: vi.fn(async () => ({ success: true })),
			getAdapterModes: vi.fn(async () => ({})),
			setAdapterMode: vi.fn(async () => ({ success: true, accepted: true })),
		},
	},
	rpcClient: {
		onConnectionChange: () => () => {},
		getConnectionState: () => "connected",
	},
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("qrcode", () => ({
	default: { toDataURL: vi.fn(async () => "data:image/png;base64,") },
}));

const SAVED_SETUP = {
	name: "CERALIVE_ef48",
	password: "Xk7mQ2pR9tLw",
	channel: "1",
	available_channels: {
		auto: { name: "Automatic" },
		"1": { name: "Channel 1 (2.4 GHz)" },
	},
	available_security: { wpa2: { name: "WPA2 (Personal)" } },
	security: "wpa2",
} satisfies NonNullable<WifiInterface["hotspot"]>;

// The shape the device sends for a USB radio whose hotspot is saved but
// configured off: a station, disconnected, still carrying its saved setup.
const SAVED_OFF: WifiInterface = {
	ifname: "wlx00c0ca000001",
	conn: "",
	hw: "Example 802.11ac NIC",
	saved: {},
	available: [],
	supports_hotspot: true,
	supports_ap_sta_concurrency: false,
	mode: "station",
	radio_identity: {
		id: "00:c0:ca:00:00:01",
		permanent_mac: "00:c0:ca:00:00:01",
	},
	hotspot: SAVED_SETUP,
} as WifiInterface;

// The same radio once a Start completed: exclusive AP, clients read.
const LIVE_AP: WifiInterface = {
	...SAVED_OFF,
	conn: "hotspot-uuid",
	available: undefined,
	mode: "hotspot",
	hotspot: { ...SAVED_SETUP, clients: { count: 0, stations: [] } },
} as WifiInterface;

const MODE_OPTIONS = [
	{ mode: "station", available: true },
	{ mode: "hotspot", available: true },
	{ mode: "hybrid", available: false, reason: "capability-absent" },
] as const;

function adapterModes(
	mode: "station" | "hotspot" | "hybrid",
): WifiAdapterModeStatus {
	return {
		"2": {
			ifname: SAVED_OFF.ifname,
			mode,
			options: [...MODE_OPTIONS],
		},
	} as WifiAdapterModeStatus;
}

function dialog(): HTMLElement {
	const el = document.querySelector<HTMLElement>('[role="dialog"]');
	if (!el) throw new Error("dialog not open");
	return el;
}

function buttonLabels(): string[] {
	return [...dialog().querySelectorAll("button")].map(
		(b) => b.textContent?.trim() ?? "",
	);
}

/** The status row's one-word state, the first line beside the radio icon. */
function statusWord(): string | undefined {
	return dialog()
		.querySelector('[data-testid="hotspot-status"]')
		?.textContent?.trim();
}

function modeBadge(): string | undefined {
	return dialog().querySelector<HTMLElement>('[data-testid="wifi-mode-badge"]')
		?.dataset.mode;
}

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
});

beforeEach(() => {
	initAsyncOperations();
});

afterEach(() => {
	destroyAsyncOperations();
	resetWifiAdapterModes();
	vi.clearAllMocks();
});

describe("HotspotDialog — Active only while the AP is live", () => {
	it("a saved hotspot configured off reads Inactive with Enable, never Active/Turn Off", async () => {
		setWifiAdapterModesForTest(adapterModes("station"));
		render(HotspotDialog, {
			props: { open: true, deviceId: "2", iface: SAVED_OFF },
		});
		await tick();

		expect(statusWord()).toBe("Inactive");
		expect(modeBadge()).toBe("station");
		const labels = buttonLabels();
		expect(labels).toContain("Enable Hotspot");
		expect(labels).not.toContain("Turn Off");
		// The saved setup stays editable and forgettable while off.
		expect(labels).toContain("Forget");
		expect(
			document.querySelector<HTMLInputElement>("#hotspot-name")?.value,
		).toBe("CERALIVE_ef48");
		expect(
			document.querySelector('[data-testid="hotspot-inactive-hint"]'),
		).not.toBeNull();
	});

	it("a live exclusive AP reads Active with Turn Off", async () => {
		setWifiAdapterModesForTest(adapterModes("hotspot"));
		render(HotspotDialog, {
			props: { open: true, deviceId: "2", iface: LIVE_AP },
		});
		await tick();

		expect(statusWord()).toBe("Active");
		expect(modeBadge()).toBe("hotspot");
		expect(buttonLabels()).toContain("Turn Off");
	});

	it("a concurrent AP on a station radio reads Active from its client read", async () => {
		const hybrid = {
			...SAVED_OFF,
			supports_ap_sta_concurrency: true,
			hotspot: { ...SAVED_SETUP, clients: { count: 1, stations: [] } },
		} as WifiInterface;
		render(HotspotDialog, {
			props: { open: true, deviceId: "2", iface: hybrid },
		});
		await tick();

		expect(statusWord()).toBe("Active");
		expect(buttonLabels()).toContain("Turn Off");
	});
});

describe("HotspotDialog — follows transitions it did not start", () => {
	it("an API Start while the dialog is open turns it Active, Turn Off and Hotspot", async () => {
		// The adapter-mode answer was pulled while the radio was a station and is
		// NOT refreshed here: the wire alone must carry the dialog.
		setWifiAdapterModesForTest(adapterModes("station"));
		const view = render(HotspotDialog, {
			props: { open: true, deviceId: "2", iface: SAVED_OFF },
		});
		await tick();
		expect(statusWord()).toBe("Inactive");

		// Steering not yet verified: the AP is up, Start has not completed.
		await view.rerender({
			open: true,
			deviceId: "2",
			iface: { ...LIVE_AP, transition: "activating" } as WifiInterface,
		});
		await tick();
		expect(modeBadge()).toBe("hotspot");

		await view.rerender({ open: true, deviceId: "2", iface: LIVE_AP });
		await tick();
		expect(statusWord()).toBe("Active");
		expect(modeBadge()).toBe("hotspot");
		const labels = buttonLabels();
		expect(labels).toContain("Turn Off");
		expect(labels).not.toContain("Enable Hotspot");
		expect(labels).not.toContain("Forget");
	});

	it("the mode badge follows an external Start even while the pulled answer still says Station", async () => {
		// Independent of the Active label: only the badge, which reads the
		// adapter-mode pull, is asserted across the transition.
		setWifiAdapterModesForTest(adapterModes("station"));
		const view = render(HotspotDialog, {
			props: { open: true, deviceId: "2", iface: SAVED_OFF },
		});
		await tick();
		expect(modeBadge()).toBe("station");

		await view.rerender({ open: true, deviceId: "2", iface: LIVE_AP });
		await tick();
		expect(modeBadge()).toBe("hotspot");
	});

	it("a Stop from elsewhere returns it to Inactive, Enable and Station", async () => {
		setWifiAdapterModesForTest(adapterModes("hotspot"));
		const view = render(HotspotDialog, {
			props: { open: true, deviceId: "2", iface: LIVE_AP },
		});
		await tick();
		expect(statusWord()).toBe("Active");

		await view.rerender({ open: true, deviceId: "2", iface: SAVED_OFF });
		await tick();
		expect(statusWord()).toBe("Inactive");
		expect(modeBadge()).toBe("station");
		const labels = buttonLabels();
		expect(labels).toContain("Enable Hotspot");
		expect(labels).not.toContain("Turn Off");
	});
});
