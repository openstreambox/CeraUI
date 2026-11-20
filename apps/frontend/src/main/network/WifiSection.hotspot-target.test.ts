// @vitest-environment jsdom
/*
  The per-radio hotspot dialog opened from WifiSection belongs to the exact
  radio lifetime it was opened for. A radio that disappears and comes back
  under the same id with a new incarnation must not reopen it: a fresh pick
  is needed. A Start already sent still reports its own outcome.
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
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";
import { noteLinkState } from "$lib/rpc/session-epoch.svelte";
import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";
import { setWifiAdapterModesForTest } from "$lib/rpc/wifi-adapter-modes.svelte";
import WifiSection from "./WifiSection.svelte";

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
		},
		onConnectionChange: () => () => {},
		connect: () => {},
		getConnectionState: () => "connected",
		getSocket: () => undefined,
		sendLegacy: () => {},
	},
}));
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "") } }));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const prepare = vi.mocked(rpc.wifi.hotspotPrepare);
const start = vi.mocked(rpc.wifi.hotspotStart);
const stop = vi.mocked(rpc.wifi.hotspotStop);
const configure = vi.mocked(rpc.wifi.hotspotConfigure);
const entry = {
	ifname: "wlan0",
	mode: "hotspot" as const,
	desired: "hotspot" as const,
	options: [
		{ mode: "station" as const, available: true },
		{ mode: "hotspot" as const, available: true },
	],
};

function row(incarnation: string): WifiInterface {
	return {
		ifname: "wlan0",
		hw: "same-model",
		conn: "",
		saved: {},
		supports_hotspot: true,
		incarnation,
	};
}

function renderSection(radios: [string, WifiInterface][]) {
	return render(WifiSection, {
		props: {
			wifiRadios: radios,
			netif: {} as NetifMessage,
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConnect: vi.fn(),
			onOpenCountry: vi.fn(),
		},
	});
}

function rerender(
	view: ReturnType<typeof renderSection>,
	radios: [string, WifiInterface][],
) {
	return view.rerender({
		wifiRadios: radios,
		netif: {} as NetifMessage,
		isFullyStale: false,
		staleInterfaces: new Set<string>(),
		onConnect: vi.fn(),
		onOpenCountry: vi.fn(),
	});
}

async function openFromSection() {
	await fireEvent.click(await screen.findByTestId("open-hotspot-setup"));
	await screen.findByTestId("hotspot-status");
}

async function closedWithNotice() {
	await waitFor(() =>
		expect(screen.queryByTestId("hotspot-status")).toBeNull(),
	);
	expect(toast.warning).toHaveBeenCalledWith(
		"The radio you chose changed or was disconnected. Choose the hotspot radio again.",
	);
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
	prepare.mockImplementation(async (request) => ({
		success: true,
		name: request.name ?? "stored-name",
		password: request.password ?? "stored-password",
	}));
	start.mockResolvedValue({ success: true, accepted: true });
	stop.mockResolvedValue({ success: true });
	configure.mockResolvedValue({ success: true });
});
afterEach(() => {
	cleanup();
	destroyAsyncOperations();
	resetState();
	setWifiAdapterModesForTest(undefined);
});

it("does not reopen on the same id under a new incarnation after the radio was lost", async () => {
	const view = renderSection([["0", row("radio-A")]]);
	await openFromSection();
	await rerender(view, []);
	await closedWithNotice();
	await rerender(view, [["0", row("radio-B")]]);
	await tick();
	await tick();
	expect(screen.queryByTestId("hotspot-status")).toBeNull();
	expect(prepare).not.toHaveBeenCalled();
	expect(start).not.toHaveBeenCalled();
	expect(stop).not.toHaveBeenCalled();
	expect(configure).not.toHaveBeenCalled();
	// A fresh pick opens it on the replacement.
	await openFromSection();
});

it("reports a late failed Start after its radio was lost", async () => {
	const view = renderSection([["0", row("radio-A")]]);
	await openFromSection();
	await fireEvent.click(screen.getByRole("button", { name: "Enable Hotspot" }));
	await waitFor(() =>
		expect(screen.getByTestId("hotspot-activation-confirm").dataset.phase).toBe(
			"ready",
		),
	);
	await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
	await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
	await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
	const attempt = start.mock.calls[0]?.[0].attempt;
	await rerender(view, []);
	await closedWithNotice();
	await rerender(view, [["0", row("radio-B")]]);
	wire.message("wifi", {
		hotspot: {
			start: {
				device: 0,
				attempt,
				error: "radio-changed",
				reason: "deactivation-failed",
			},
		},
	});
	await waitFor(() =>
		expect(toast.error).toHaveBeenCalledWith(
			expect.stringContaining("mode is unknown"),
		),
	);
	expect(screen.queryByTestId("hotspot-status")).toBeNull();
	expect(start).toHaveBeenCalledTimes(1);
});
