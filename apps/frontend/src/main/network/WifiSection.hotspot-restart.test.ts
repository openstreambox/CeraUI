// @vitest-environment jsdom
/**
 * The hotspot editor opened from a Wi-Fi row stays bound to its radio
 * lifetime while a peer restarts the AP and the device withholds the token for
 * a moment. Another token, or a token gone outside a transition, still closes
 * it, and a Save already sent still settles its own key from its terminal.
 * Frames go through the real subscription handler and the real dialog.
 */
import type { NetifMessage, WifiInterface } from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { toast } from "svelte-sonner";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
	destroyAsyncOperations,
	getOperationPhase,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";
import { noteLinkState } from "$lib/rpc/session-epoch.svelte";
import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";
import { setWifiAdapterModesForTest } from "$lib/rpc/wifi-adapter-modes.svelte";
import WifiSection from "./WifiSection.svelte";
import { wifiHotspotConfigOpKey } from "./wifi-station-lock";

const wire = vi.hoisted(() => ({
	message: (_type: string, _data: unknown) => {},
}));
vi.mock("$lib/rpc/client", async () => ({
	ConnectionResetError: (
		await vi.importActual<typeof import("$lib/rpc/client")>("$lib/rpc/client")
	).ConnectionResetError,
	rpc: {
		network: { configure: vi.fn() },
		wifi: {
			hotspotPrepare: vi.fn(),
			hotspotStart: vi.fn(),
			hotspotStop: vi.fn(),
			hotspotConfigure: vi.fn(),
			getAdapterModes: vi.fn(async () => ({})),
			setAdapterMode: vi.fn(),
		},
	},
	rpcClient: {
		onMessage: (fn: typeof wire.message) => {
			wire.message = fn;
			return () => {};
		},
		onConnectionChange: () => () => {},
		connect: () => {},
		getConnectionState: () => "connected",
		isAwaitingSignIn: () => false,
		getSocket: () => undefined,
		sendLegacy: () => {},
	},
}));
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "") } }));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
const configure = vi.mocked(rpc.wifi.hotspotConfigure);
const RADIO_LOST =
	"The radio you chose changed or was disconnected. Choose the hotspot radio again.";

function liveRow(incarnation?: string): WifiInterface {
	return {
		ifname: "wlan0",
		hw: "same-model",
		conn: "ap-uuid",
		saved: {},
		supports_hotspot: true,
		mode: "hotspot",
		...(incarnation ? { incarnation } : {}),
		hotspot: {
			name: "live-name",
			password: "live-password",
			channel: "auto",
			available_channels: { auto: { name: "Automatic" } },
			security: "wpa2",
			available_security: { wpa2: { name: "WPA2" } },
		},
	};
}

/** The same radio mid-restart: the device withholds its token for a moment. */
function withheld(marker: Pick<WifiInterface, "transition" | "leaving">) {
	return { ...liveRow(), ...marker };
}

const entry = {
	ifname: "wlan0",
	mode: "hotspot" as const,
	desired: "hotspot" as const,
	options: [
		{ mode: "station" as const, available: true },
		{ mode: "hotspot" as const, available: true },
	],
};

let view: ReturnType<typeof render<typeof WifiSection>> | undefined;

function props(row: WifiInterface | undefined) {
	return {
		wifiRadios: (row ? [["0", row]] : []) as [string, WifiInterface][],
		netif: {} as NetifMessage,
		isFullyStale: false,
		staleInterfaces: new Set<string>(),
		onConnect: vi.fn(),
		onOpenCountry: vi.fn(),
	};
}

/** One device frame, through the subscription layer and the section's prop. */
async function push(row: WifiInterface | undefined) {
	wire.message("status", { wifi: row ? { "0": row } : {} });
	if (view) await view.rerender(props(row));
	await tick();
	await tick();
}

async function openEditor() {
	view = render(WifiSection, { props: props(liveRow("radio-A")) });
	await fireEvent.click(await screen.findByTestId("open-hotspot-setup"));
	await screen.findByTestId("hotspot-status");
}

async function closedWithNotice() {
	await waitFor(() =>
		expect(screen.queryByTestId("hotspot-status")).toBeNull(),
	);
	expect(toast.warning).toHaveBeenCalledWith(RADIO_LOST);
}

beforeAll(() => {
	window.matchMedia ??= vi.fn().mockImplementation((query: string) => ({
		matches: true,
		media: query,
		onchange: null,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}));
});
beforeEach(() => {
	vi.resetAllMocks();
	resetState();
	initAsyncOperations();
	initSubscriptions();
	noteLinkState("disconnected");
	noteLinkState("connected");
	setWifiAdapterModesForTest({ "0": entry });
	vi.mocked(rpc.wifi.getAdapterModes).mockResolvedValue({ "0": entry });
	configure.mockResolvedValue({ success: true, accepted: true });
});
afterEach(() => {
	cleanup();
	view = undefined;
	destroyAsyncOperations();
	resetState();
	setWifiAdapterModesForTest(undefined);
});

it.each([
	["deactivating", { transition: "deactivating" }],
	["activating", { transition: "activating" }],
	["leaving", { leaving: "hotspot" }],
] as const)(
	"keeps the editor through a restart that withholds the token (%s)",
	async (_case, marker) => {
		await push(liveRow("radio-A"));
		await openEditor();

		await push(withheld(marker));
		expect(screen.getByTestId("hotspot-status")).toBeTruthy();
		await push(liveRow("radio-A"));
		expect(screen.getByTestId("hotspot-status")).toBeTruthy();
		expect(toast.warning).not.toHaveBeenCalled();
	},
);

it("closes when another token follows the withheld one", async () => {
	await push(liveRow("radio-A"));
	await openEditor();
	await push(withheld({ transition: "activating" }));
	await push(liveRow("radio-B"));
	await closedWithNotice();
});

it("closes when the token is gone outside a transition", async () => {
	await push(liveRow("radio-A"));
	await openEditor();
	await push(liveRow());
	await closedWithNotice();
});

it.each([
	["success", "withheld", { success: true }, "confirmed"],
	["failure", "withheld", { error: "radio-unverified" }, "failed"],
	["success", "direct", { success: true }, "confirmed"],
	["failure", "direct", { error: "radio-unverified" }, "failed"],
] as const)(
	"settles a Save whose %s terminal arrives after a replacement radio (%s)",
	async (_case, path, terminal, phase) => {
		await push(liveRow("radio-A"));
		await openEditor();
		await fireEvent.click(screen.getByTestId("hotspot-save"));
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		const original = wifiHotspotConfigOpKey("0", "radio-A");
		expect(getOperationPhase(original)).toBe("pending");

		if (path === "withheld") {
			await push(withheld({ transition: "deactivating" }));
			expect(screen.getByTestId("hotspot-status")).toBeTruthy();
		}
		await push(liveRow("radio-B"));
		await closedWithNotice();

		wire.message("wifi", {
			hotspot: { config: { device: 0, incarnation: "radio-A", ...terminal } },
		});
		await tick();
		expect(getOperationPhase(original)).toBe(phase);
		expect(getOperationPhase(wifiHotspotConfigOpKey("0", "radio-B"))).toBe(
			"idle",
		);
		expect(configure).toHaveBeenCalledTimes(1);
	},
);

it.each([
	["deactivating", { transition: "deactivating" }],
	["leaving", { leaving: "hotspot" }],
] as const)(
	"keeps an editor that first mounts while the token is withheld (%s)",
	async (_case, marker) => {
		await push(liveRow("radio-A"));
		view = render(WifiSection, { props: props(liveRow("radio-A")) });
		const button = await screen.findByTestId("open-hotspot-setup");
		// The click captures radio-A; the restart withholds the token before the
		// lazy editor renders its first frame.
		button.click();
		wire.message("status", { wifi: { "0": withheld(marker) } });
		const pending = view.rerender(props(withheld(marker)));
		await pending;
		await screen.findByTestId("hotspot-status");
		await push(withheld(marker));
		expect(screen.getByTestId("hotspot-status")).toBeTruthy();
		await push(liveRow("radio-A"));
		expect(screen.getByTestId("hotspot-status")).toBeTruthy();
		expect(toast.warning).not.toHaveBeenCalled();
	},
);

it("closes an editor that first mounts after its radio was replaced", async () => {
	await push(liveRow("radio-A"));
	view = render(WifiSection, { props: props(liveRow("radio-A")) });
	const button = await screen.findByTestId("open-hotspot-setup");
	button.click();
	wire.message("status", {
		wifi: { "0": withheld({ transition: "activating" }) },
	});
	await view.rerender(props(withheld({ transition: "activating" })));
	await screen.findByTestId("hotspot-status");
	await push(liveRow("radio-B"));
	await closedWithNotice();
});

it("settles a detached Save after Setup is reopened on the replacement radio", async () => {
	await push(liveRow("radio-A"));
	await openEditor();
	await fireEvent.click(screen.getByTestId("hotspot-save"));
	await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
	const original = wifiHotspotConfigOpKey("0", "radio-A");
	await push(liveRow("radio-B"));
	await closedWithNotice();

	await fireEvent.click(screen.getByTestId("open-hotspot-setup"));
	await screen.findByTestId("hotspot-status");
	expect(getOperationPhase(original)).toBe("pending");

	wire.message("wifi", {
		hotspot: { config: { device: 0, incarnation: "radio-A", success: true } },
	});
	await tick();
	expect(getOperationPhase(original)).toBe("confirmed");
	expect(getOperationPhase(wifiHotspotConfigOpKey("0", "radio-B"))).toBe(
		"idle",
	);
	expect(screen.getByTestId("hotspot-status")).toBeTruthy();
	expect(configure).toHaveBeenCalledTimes(1);
});
