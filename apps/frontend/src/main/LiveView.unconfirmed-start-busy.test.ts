// @vitest-environment jsdom
/**
 * LiveView, real Start path: the operator presses Start while the device is
 * idle, the device reports the unconfirmed state before it answers busy
 * (START_IN_PROGRESS), and the real optimism store reverts the attempt. The
 * toast then says what to press: the band's Stop, with Start disabled until the
 * device settles. Only the RPC transport, the toast sink and the
 * peripherals are stubbed; handleStart, SystemHelper and the optimism store
 * run for real.
 */
import {
	cleanup,
	fireEvent,
	render,
	waitFor,
	within,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));

// Config carries NO `source` → the source gate is blocked (encoder row blocked +
// openSource fix), but relay_server + a live netif keep destination/network green.
vi.mock("$lib/rpc/subscriptions.svelte", async () => ({
	ingestPulledStatus: () => undefined,
	getConfig: () => ({
		relay_server: "fra",
		max_br: 6000,
		pipeline: "cam-1-pipe",
		source: "cam-1",
	}),
	getIsStreaming: () => false,
	getSensors: () => ({}),
	getLinkTelemetry: () => null,
	getAudioLevel: () => undefined,
	getDevices: () => [],
	getActiveInput: () => undefined,
	getConnectionState: () => "connected",
	getIsConnected: () => true,
	// Current capabilities: the engine gate needs them before Start reads ready.
	getCapabilities: () => ({ encoder: {} }),
	getConfigChange: () => undefined,
	getNetif: () => ({ eth0: { enabled: true, ip: "10.0.0.2" } }),
	getRelays: () => undefined,
	getManagedIngestAccounts: () => [],
	// A Start carries the config generation it read, for its refusal's retry.
	getStartConfigGeneration: () => 0,
	getStatus: (await import("../tests/fixtures/live-status.svelte.ts"))
		.liveStatus,
	getPipelines: () => ({ pipelines: {} }),
	getSources: () => ({
		hardware: "rk3588",
		sources: [
			{
				id: "cam-1",
				pipelineId: "cam-1-pipe",
				modes: [],
				supportsAudio: false,
				supportsResolutionOverride: false,
				supportsFramerateOverride: false,
				audioKind: "none",
				available: true,
				origin: "capture",
				kind: "hdmi",
				displayName: "HDMI Capture",
				devicePath: "/dev/cam-1",
			},
		],
	}),
}));

const BUSY = { success: false, error: "START_IN_PROGRESS" } as const;
// The reply waits for `release` when a test holds it.
let held: Promise<void> | undefined;
const busyStart = vi.fn(async () => {
	await held;
	return BUSY;
});
vi.mock("$lib/rpc/client", () => ({
	rpc: {
		streaming: {
			start: () => busyStart(),
			stop: () => new Promise(() => undefined),
		},
	},
}));

const toastError = vi.fn();
vi.mock("svelte-sonner", () => ({
	toast: {
		error: (...args: unknown[]) => toastError(...args),
		dismiss: () => undefined,
	},
}));

// SourceSection's QR effect: stubbed so it never touches the QR lib at mount.
vi.mock("$lib/helpers/NetworkHelper", () => ({
	generateDeviceAccessQr: vi.fn(async () => ""),
}));

// Stub the heavy peripherals so ONLY the idle cockpit subtree mounts for real.
vi.mock("$main/live/LiveHeader.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/CapabilityTierBanner.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/LiveCockpit.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$lib/components/preview/PreviewCanvas.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$lib/components/custom/ComingSoon.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/ServerDialog.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/AudioDialog.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/EncoderDialog.svelte", async () => ({
	default: (await import("../tests/fixtures/EncoderDialogOpenStub.svelte"))
		.default,
}));

import { clearOperation } from "$lib/rpc/async-operation.svelte";
import {
	destroyStreamingOptimism,
	getStreamingOptimismState,
} from "$lib/rpc/streaming-optimism.svelte";
import { UNCONFIRMED_STOP_OPERATION } from "$lib/streaming/unconfirmed-stream";
import { setLiveStatus } from "../tests/fixtures/live-status.svelte.ts";
import LiveView from "./LiveView.svelte";

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
	destroyStreamingOptimism();
	clearOperation(UNCONFIRMED_STOP_OPERATION);
	toastError.mockReset();
	busyStart.mockClear();
	held = undefined;
});

afterEach(() => {
	cleanup();
	destroyStreamingOptimism();
});

function pressStart(container: HTMLElement) {
	return fireEvent.click(
		within(container).getByRole("button", { name: /start stream/i }),
	);
}

describe("LiveView: a real Start answered busy", () => {
	it("when the band rises before the busy reply: the toast points to the band's Stop and Start waits", async () => {
		setLiveStatus({ stream_lifecycle: "idle", is_streaming: false });
		let release = () => {};
		held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { container } = render(LiveView);

		await pressStart(container);
		await waitFor(() => expect(busyStart).toHaveBeenCalledTimes(1));
		setLiveStatus({ stream_lifecycle: "reconciling", is_streaming: false });
		release();

		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(toastError.mock.calls[0]?.[0]).toBe("Stop the stream above first");
		expect(getStreamingOptimismState()).toBe("idle");
		expect(container.textContent).toContain("Stream state not confirmed");
		// The bar points to the same Stop the toast names.
		expect(container.textContent).toContain("Stop the stream above first");
		expect(
			within(container).getByRole("button", { name: /stop stream/i }),
		).toHaveProperty("disabled", false);
		expect(
			(
				within(container).getByRole("button", {
					name: /start stream/i,
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});

	it("while the band is up, Start sends nothing", async () => {
		setLiveStatus({ stream_lifecycle: "reconciling", is_streaming: false });
		const { container } = render(LiveView);

		await pressStart(container);

		expect(busyStart).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
		expect(container.textContent).toContain("Stream state not confirmed");
	});

	it("with no band: the generic copy", async () => {
		setLiveStatus({ stream_lifecycle: "idle", is_streaming: false });
		const { container } = render(LiveView);

		await pressStart(container);

		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(toastError.mock.calls[0]?.[0]).toBe("Failed to start stream");
		expect(getStreamingOptimismState()).toBe("idle");
	});
});
