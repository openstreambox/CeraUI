// @vitest-environment jsdom
import type { WifiAdapterModeStatus, WifiInterface } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
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
	incarnation: "radio-2",
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

function footer(): HTMLElement {
	const el = dialog().querySelector<HTMLElement>("[data-app-dialog-footer]");
	if (!el) throw new Error("no footer");
	return el;
}

function footerLabels(): string[] {
	return [...footer().querySelectorAll("button")].map(
		(b) => b.textContent?.trim() ?? "",
	);
}

// The Button primitive carries its variant only as classes.
function isPrimary(b: HTMLElement): boolean {
	return b.classList.contains("bg-primary");
}
function footerButton(label: string): HTMLButtonElement {
	const button = [...footer().querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === label,
	);
	if (!button) throw new Error(`no footer button ${label}`);
	return button;
}

describe("HotspotDialog footer — the action the dialog was opened for comes first", () => {
	it("keeps Turn on hotspot primary and uses the bound editor to save while off", async () => {
		setWifiAdapterModesForTest(adapterModes("station"));
		const view = render(HotspotDialog, {
			props: { open: true, deviceId: "2", iface: SAVED_OFF },
		});
		await tick();

		expect(isPrimary(footerButton("Turn on hotspot"))).toBe(true);
		expect(footerLabels()).toEqual(["Turn on hotspot"]);
		await fireEvent.click(view.getByTestId("hotspot-off-edit"));
		expect(await view.findByTestId("hotspot-off-save")).toBeTruthy();
	});

	it("has no Close button of its own: the sheet's close icon closes", async () => {
		setWifiAdapterModesForTest(adapterModes("station"));
		render(HotspotDialog, {
			props: { open: true, deviceId: "2", iface: SAVED_OFF },
		});
		await tick();

		expect(footerLabels()).not.toContain("Close");
		expect(
			dialog().querySelector('[data-testid="app-dialog-close"]'),
		).not.toBeNull();
	});

	it("while on: Turn Off is not styled as the primary", async () => {
		setWifiAdapterModesForTest(adapterModes("hotspot"));
		render(HotspotDialog, {
			props: { open: true, deviceId: "2", iface: LIVE_AP },
		});
		await tick();

		expect(isPrimary(footerButton("Turn Off"))).toBe(false);
		expect(footerLabels()).not.toContain("Forget");
	});
});
