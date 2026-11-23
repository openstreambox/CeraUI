// @vitest-environment jsdom
/**
 * LiveView: while the device reports that it cannot confirm whether an earlier
 * stream ended (`stream_lifecycle` reconciling or stop_failed, not streaming),
 * the unconfirmed-state band offers the Stop and the Start bar is paused with
 * "Stop the stream above first". The pause follows the live status: once the
 * device settles, Start returns without a reload. The operator always has one
 * working action, the band's Stop or Start.
 *
 * Mounts the real IdleCockpit, StreamSetupChain and UnconfirmedStreamBand,
 * with the same peripheral stubs as LiveView.idle-order.test.ts.
 */
import { cleanup, render, within } from "@testing-library/svelte";
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
	getCapabilities: () => undefined,
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

vi.mock("$lib/rpc/streaming-optimism.svelte", () => ({
	getStreamingOptimismState: () => "idle",
	getStreamingStopReason: () => undefined,
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

import { setLiveStatus } from "../tests/fixtures/live-status.svelte.ts";
import LiveView from "./LiveView.svelte";

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
	setLiveStatus({});
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

describe("LiveView: Start pauses only while the device reports the unconfirmed state", () => {
	for (const lifecycle of ["reconciling", "stop_failed"] as const) {
		it(`${lifecycle}: band with Stop, Start paused, and both follow the status live`, () => {
			setLiveStatus({ stream_lifecycle: lifecycle, is_streaming: false });
			const { container } = render(LiveView);
			expect(container.textContent).toContain("Stream state not confirmed");
			expect(
				within(container).getByRole("button", { name: /stop stream/i }),
			).toBeTruthy();
			expect(container.textContent).toContain("Stop the stream above first");
			expect(container.textContent).not.toContain("Ready to go live");
			expect(startButton(container).disabled).toBe(true);

			// The device settles (the operator's Stop was acknowledged).
			setLiveStatus({ stream_lifecycle: "idle", is_streaming: false });
			flushSync();
			expect(container.textContent).not.toContain("Stream state not confirmed");
			expect(container.textContent).not.toContain(
				"Stop the stream above first",
			);
			expect(container.textContent).toContain("Ready to go live");
			expect(startButton(container).disabled).toBe(false);
		});
	}

	it("idle, or no lifecycle reported yet: no band and Start is not paused", () => {
		for (const status of [
			{},
			{ stream_lifecycle: "idle", is_streaming: false },
		]) {
			setLiveStatus(status);
			const { container, unmount } = render(LiveView);
			expect(container.textContent).not.toContain("Stream state not confirmed");
			expect(container.textContent).not.toContain(
				"Stop the stream above first",
			);
			expect(startButton(container).disabled).toBe(false);
			unmount();
		}
	});
});
