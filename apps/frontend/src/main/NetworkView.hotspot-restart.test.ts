// @vitest-environment jsdom
/**
 * The hotspot editor opened from the Network view stays bound to its radio
 * lifetime while a peer restarts the AP and the device withholds the token for
 * a moment. Another token, or a token gone outside a transition, still closes
 * it, and a Save already sent still settles its own key from its terminal.
 * Frames go through the real subscription handler and the real dialog.
 */
import type { WifiInterface } from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { toast } from "svelte-sonner";
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
	getOperationPhase,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";
import { noteLinkState } from "$lib/rpc/session-epoch.svelte";
import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";
import { wifiHotspotConfigOpKey } from "./network/wifi-station-lock";

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
vi.mock("$lib/stores/hud.svelte", () => ({
	getHudState: () => ({
		links: [],
		isFullyStale: false,
		staleInterfaces: new Set<string>(),
		unbondedLinkCount: 0,
	}),
}));
for (const section of [
	"./network/BluetoothSection.svelte",
	"./network/BondedLinksSection.svelte",
	"./network/CellularSection.svelte",
	"./network/CollisionBands.svelte",
	"./network/EthernetSection.svelte",
	"./network/SharingSection.svelte",
	"./network/UnclaimedAdaptersBand.svelte",
	"./network/WifiSection.svelte",
]) {
	vi.doMock(section, async () => ({
		default: (await import("../tests/fixtures/Noop.svelte")).default,
	}));
}

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

async function push(row: WifiInterface | undefined) {
	wire.message("status", { wifi: row ? { "0": row } : {} });
	await tick();
	await tick();
}

async function openEditor() {
	const { default: NetworkView } = await import("./NetworkView.svelte");
	render(NetworkView);
	await tick();
	await fireEvent.click(await screen.findByTestId("open-hotspot-dialog"));
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
	vi.mocked(rpc.wifi.getAdapterModes).mockResolvedValue({});
	configure.mockResolvedValue({ success: true, accepted: true });
});
afterEach(() => {
	cleanup();
	destroyAsyncOperations();
	resetState();
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
		const { default: NetworkView } = await import("./NetworkView.svelte");
		render(NetworkView);
		await tick();
		const button = await screen.findByTestId("open-hotspot-dialog");
		// The click captures radio-A; the restart withholds the token before the
		// lazy editor renders its first frame.
		button.click();
		wire.message("status", { wifi: { "0": withheld(marker) } });
		await screen.findByTestId("hotspot-status");
		await push(withheld(marker));
		expect(screen.getByTestId("hotspot-status")).toBeTruthy();
		await push(liveRow("radio-A"));
		expect(screen.getByTestId("hotspot-status")).toBeTruthy();
		expect(toast.warning).not.toHaveBeenCalled();
	},
);

it("closes an editor whose radio is replaced before its first render", async () => {
	await push(liveRow("radio-A"));
	const { default: NetworkView } = await import("./NetworkView.svelte");
	render(NetworkView);
	await tick();
	const button = await screen.findByTestId("open-hotspot-dialog");
	// The click captures radio-A; radio-B replaces it before the lazy editor
	// renders its first frame, and no later frame follows.
	button.click();
	wire.message("status", { wifi: { "0": liveRow("radio-B") } });
	await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(RADIO_LOST));
	expect(screen.queryByTestId("hotspot-status")).toBeNull();
	await tick();
	expect(screen.queryByTestId("hotspot-status")).toBeNull();
	expect(toast.warning).toHaveBeenCalledTimes(1);
});

it("settles a detached Save after Setup is reopened on the replacement radio", async () => {
	await push(liveRow("radio-A"));
	await openEditor();
	await fireEvent.click(screen.getByTestId("hotspot-save"));
	await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
	const original = wifiHotspotConfigOpKey("0", "radio-A");
	await push(liveRow("radio-B"));
	await closedWithNotice();

	const select = document.querySelector<HTMLSelectElement>("#hotspot-radio");
	if (!select) throw new Error("missing radio picker");
	await fireEvent.change(select, { target: { value: "0" } });
	await fireEvent.click(screen.getByTestId("open-hotspot-dialog"));
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

/** Setup again on the radio now on screen: a fresh pick, then the editor. */
async function reopen() {
	const select = document.querySelector<HTMLSelectElement>("#hotspot-radio");
	if (!select) throw new Error("missing radio picker");
	await fireEvent.change(select, { target: { value: "0" } });
	await fireEvent.click(screen.getByTestId("open-hotspot-dialog"));
	await screen.findByTestId("hotspot-status");
}
it.each([
	["oldest first", ["radio-A", "radio-B"]],
	["newest first", ["radio-B", "radio-A"]],
] as const)(
	"settles two detached Saves on successive radios (%s)",
	async (_case, order) => {
		await push(liveRow("radio-A"));
		await openEditor();
		for (const [token, replacement] of [
			["radio-A", "radio-B"],
			["radio-B", "radio-C"],
		] as const) {
			await fireEvent.click(screen.getByTestId("hotspot-save"));
			await waitFor(() =>
				expect(getOperationPhase(wifiHotspotConfigOpKey("0", token))).toBe(
					"pending",
				),
			);
			await push(liveRow(replacement));
			await waitFor(() =>
				expect(screen.queryByTestId("hotspot-status")).toBeNull(),
			);
			await reopen();
		}
		expect(configure).toHaveBeenCalledTimes(2);
		expect(toast.warning).toHaveBeenCalledTimes(2);

		for (const token of order) {
			wire.message("wifi", {
				hotspot: { config: { device: 0, incarnation: token, success: true } },
			});
			await tick();
			expect(getOperationPhase(wifiHotspotConfigOpKey("0", token))).toBe(
				"confirmed",
			);
		}
		expect(getOperationPhase(wifiHotspotConfigOpKey("0", "radio-A"))).toBe(
			"confirmed",
		);
		expect(getOperationPhase(wifiHotspotConfigOpKey("0", "radio-B"))).toBe(
			"confirmed",
		);
		expect(getOperationPhase(wifiHotspotConfigOpKey("0", "radio-C"))).toBe(
			"idle",
		);
		expect(screen.getByTestId("hotspot-status")).toBeTruthy();
	},
);

describe("the hotspot card's radio pick", () => {
	const other: WifiInterface = { ...liveRow("radio-Z"), ifname: "wlan1" };

	async function frame(row: WifiInterface) {
		wire.message("status", { wifi: { "0": row, "1": other } });
		await tick();
		await tick();
	}

	async function pick() {
		await frame(liveRow("radio-A"));
		const { default: NetworkView } = await import("./NetworkView.svelte");
		render(NetworkView);
		await tick();
		await fireEvent.change(picker(), { target: { value: "0" } });
		expect(setup().disabled).toBe(false);
	}

	function picker(): HTMLSelectElement {
		const select = document.querySelector<HTMLSelectElement>("#hotspot-radio");
		if (!select) throw new Error("missing radio picker");
		return select;
	}

	function setup(): HTMLButtonElement {
		return screen.getByTestId("open-hotspot-dialog") as HTMLButtonElement;
	}

	it.each([
		["deactivating", { transition: "deactivating" }],
		["activating", { transition: "activating" }],
		["leaving", { leaving: "hotspot" }],
	] as const)(
		"keeps its pick through a restart that withholds the token (%s)",
		async (_case, marker) => {
			await pick();
			await frame(withheld(marker));
			expect(screen.queryByTestId("hotspot-radio-lost")).toBeNull();
			await frame(liveRow("radio-A"));
			expect(picker().value).toBe("0");
			expect(setup().disabled).toBe(false);
			expect(screen.queryByTestId("hotspot-radio-lost")).toBeNull();
		},
	);

	it("expires its pick when another token follows the withheld one", async () => {
		await pick();
		await frame(withheld({ transition: "activating" }));
		await frame(liveRow("radio-B"));
		expect(picker().value).toBe("");
		expect(setup().disabled).toBe(true);
		expect(screen.getByTestId("hotspot-radio-lost")).toBeTruthy();
	});

	it("expires its pick when the token is gone outside a transition", async () => {
		await pick();
		await frame(liveRow());
		await frame(liveRow("radio-A"));
		expect(picker().value).toBe("");
		expect(screen.getByTestId("hotspot-radio-lost")).toBeTruthy();
	});
});
