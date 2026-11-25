// @vitest-environment jsdom
/**
 * LiveView: while the device reports that it cannot confirm whether an earlier
 * stream ended (`stream_lifecycle` reconciling or stop_failed, not streaming),
 * the unconfirmed-state band offers the Stop, and the Start bar says "Stream
 * state not confirmed" instead of "Ready to go live", with Start disabled: the
 * band's Stop is the next step. Both follow the live status: once the device
 * settles, the bar reads ready again without a reload.
 *
 * Mounts the real IdleCockpit, StreamSetupChain and UnconfirmedStreamBand,
 * with the same peripheral stubs as LiveView.idle-order.test.ts.
 */
import { cleanup, fireEvent, render, within } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));

// Config carries NO `source` → the source gate is blocked (encoder row blocked +
// openSource fix), but relay_server + a live netif keep destination/network green.
vi.mock("$lib/rpc/subscriptions.svelte", async () => ({
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

vi.mock("$lib/rpc/streaming-optimism.svelte", async () => ({
	getStreamingOptimismState: () => "idle",
	getStreamingStopReason: (
		await import("../tests/fixtures/live-status.svelte.ts")
	).liveStopReason,
	supersedeStartingOptimism: vi.fn(),
	getStreamingStartFailure: () => undefined,
	getStreamingAttemptGeneration: () => 1,
	revertStreamingOptimismFailure: vi.fn(),
	getStopStuckBannerVisible: () => false,
	startStreamingOptimism: vi.fn(),
	stopStreamingOptimism: vi.fn(),
	reconcileStreamingOptimism: vi.fn(),
	revertStreamingOptimism: vi.fn(),
	retryStopStreaming: vi.fn(),
}));

// The band's Stop: held unanswered, so the operation stays pending while the
// device reports `stopping`.
const heldStop = vi.fn(() => new Promise(() => undefined));
vi.mock("$lib/rpc/client", () => ({
	rpc: { streaming: { stop: () => heldStop() } },
}));

const toastError = vi.fn();
vi.mock("svelte-sonner", () => ({
	toast: { error: (...args: unknown[]) => toastError(...args) },
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
import { UNCONFIRMED_STOP_OPERATION } from "$lib/streaming/unconfirmed-stream";
import { resetUnresolvedStreamActions } from "$lib/streaming/unresolved-stream-actions.svelte";
import {
	setLiveStatus,
	setLiveStopReason,
} from "../tests/fixtures/live-status.svelte.ts";
import LiveView from "./LiveView.svelte";

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
	setLiveStatus({});
	setLiveStopReason(undefined);
	resetUnresolvedStreamActions();
	clearOperation(UNCONFIRMED_STOP_OPERATION);
	toastError.mockReset();
	heldStop.mockClear();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function startButton(container: HTMLElement) {
	return within(container).getByRole("button", {
		name: /start stream/i,
	}) as HTMLButtonElement;
}

describe("LiveView: the bar defers to the band's Stop only while the device reports the unconfirmed state", () => {
	for (const lifecycle of ["reconciling", "stop_failed"] as const) {
		it(`${lifecycle}: band with Stop, the bar defers to it with Start disabled, and both follow the status live`, () => {
			setLiveStatus({ stream_lifecycle: lifecycle, is_streaming: false });
			const { container } = render(LiveView);
			expect(container.textContent).toContain("Stream state not confirmed");
			expect(
				within(container).getByRole("button", { name: /stop stream/i }),
			).toBeTruthy();
			expect(container.textContent).not.toContain("Ready to go live");
			// The band's Stop is the next step; Start waits for the device.
			expect(
				within(container).getByRole("button", { name: /stop stream/i }),
			).toHaveProperty("disabled", false);
			expect(startButton(container).disabled).toBe(true);

			// The device settles (the operator's Stop was acknowledged).
			setLiveStatus({ stream_lifecycle: "idle", is_streaming: false });
			flushSync();
			expect(container.textContent).not.toContain("Stream state not confirmed");
			expect(container.textContent).toContain("Ready to go live");
			expect(startButton(container).disabled).toBe(false);
		});
	}

	it("idle: no band and the bar reads ready", () => {
		setLiveStatus({ stream_lifecycle: "idle", is_streaming: false });
		const { container } = render(LiveView);
		expect(container.textContent).not.toContain("Stream state not confirmed");
		expect(container.textContent).toContain("Ready to go live");
		expect(startButton(container).disabled).toBe(false);
	});

	it("no lifecycle reported yet: no band, and the bar checks instead of claiming ready", () => {
		setLiveStatus({});
		const { container } = render(LiveView);
		expect(container.textContent).not.toContain("Stream state not confirmed");
		expect(container.textContent).not.toContain("Ready to go live");
		expect(container.textContent).toContain("Checking readiness…");
		expect(startButton(container).disabled).toBe(true);
	});

	it("through the stopping that follows the band's Stop, the bar never reads ready", async () => {
		setLiveStatus({ stream_lifecycle: "stop_failed", is_streaming: false });
		const { container } = render(LiveView);
		await fireEvent.click(
			within(container).getByRole("button", { name: /stop stream/i }),
		);
		expect(heldStop).toHaveBeenCalledTimes(1);
		setLiveStatus({ stream_lifecycle: "stopping", is_streaming: false });
		flushSync();
		expect(container.textContent).toContain("Stream state not confirmed");
		expect(container.textContent).not.toContain("Ready to go live");
		expect(startButton(container).disabled).toBe(true);
	});

	it("a Start refused while the band is up says what to press", () => {
		setLiveStatus({ stream_lifecycle: "reconciling", is_streaming: false });
		render(LiveView);
		setLiveStopReason("START_IN_PROGRESS");
		flushSync();
		expect(toastError).toHaveBeenCalledTimes(1);
		expect(toastError.mock.calls[0]?.[0]).toBe("Stop the stream above first");

		// The band changing afterwards does not repeat the toast.
		setLiveStatus({ stream_lifecycle: "idle", is_streaming: false });
		flushSync();
		expect(toastError).toHaveBeenCalledTimes(1);
	});

	it("a Start refused as already starting, with no band, keeps the generic copy", () => {
		setLiveStatus({ stream_lifecycle: "idle", is_streaming: false });
		render(LiveView);
		setLiveStopReason("START_IN_PROGRESS");
		flushSync();
		expect(toastError).toHaveBeenCalledTimes(1);
		expect(toastError.mock.calls[0]?.[0]).toBe("Failed to start stream");
	});
});
