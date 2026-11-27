// @vitest-environment jsdom
/**
 * LiveView during a supervised connection restart.
 *
 * Between the restart's Stop and its Start the device is not streaming, but
 * nobody stopped the stream. The Live view must say what the HUD says for the
 * whole gap: the connection is restarting. It must not open the post-stream
 * "Session ended" summary or fall back to the idle cockpit with Start, and it
 * says "Session ended" only when the stream really ended.
 *
 * The real LiveHeader is rendered, so the `restarting` wiring from the device
 * status to the header chip is part of what this pins.
 */
import { m } from "@ceraui/i18n/svelte";
import { render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hudRestart } from "../tests/fixtures/reactive-hud-restart.svelte";

const SUMMARY_WINDOW_MS = 30_000;

vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const { hudRestart: state } = await import(
		"../tests/fixtures/reactive-hud-restart.svelte"
	);
	return {
		getConfig: () => ({ relay_server: "fra", max_br: 6000, pipeline: "hdmi" }),
		getIsStreaming: () => state.streaming,
		getSensors: () => ({}),
		getLinkTelemetry: () => null,
		getAudioLevel: () => undefined,
		getDevices: () => [],
		getActiveInput: () => undefined,
		getConnectionState: () => "connected",
		getIsConnected: () => true,
		getCapabilities: () => undefined,
		getConfigChange: () => undefined,
		getNetif: () => ({}),
		getRelays: () => undefined,
		getManagedIngestAccounts: () => [],
		getStatus: () => ({
			connection_restarting: state.restarting,
			stream_reconnect: state.reconnect,
		}),
		getPipelines: () => ({ pipelines: {} }),
		getSources: () => undefined,
	};
});

const reconcile = vi.hoisted(() => vi.fn());
vi.mock("$lib/rpc/streaming-optimism.svelte", () => ({
	getStreamingOptimismState: () => "idle",
	getStreamingStopReason: () => undefined,
	getStreamingStartFailure: () => undefined,
	getStreamingAttemptGeneration: () => 1,
	revertStreamingOptimismFailure: vi.fn(),
	getStopStuckBannerVisible: () => false,
	startStreamingOptimism: vi.fn(),
	stopStreamingOptimism: vi.fn(),
	reconcileStreamingOptimism: reconcile,
	revertStreamingOptimism: vi.fn(),
	retryStopStreaming: vi.fn(),
}));

vi.mock("$main/live/IdleCockpit.svelte", async () => ({
	default: (await import("../tests/fixtures/IdleCockpitStub.svelte")).default,
}));
vi.mock("$main/live/LiveCockpit.svelte", async () => ({
	default: (await import("../tests/fixtures/LiveCockpitStub.svelte")).default,
}));
vi.mock("$main/live/CapabilityTierBanner.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/ServerDialog.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/AudioDialog.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/EncoderDialog.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$lib/components/custom/ComingSoon.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));

import LiveView from "./LiveView.svelte";

function cockpit(container: HTMLElement) {
	const live = container.querySelector<HTMLElement>(
		'[data-testid="live-cockpit"]',
	);
	return {
		live: live !== null,
		idle: container.querySelector('[data-testid="idle-cockpit"]') !== null,
		summary: live?.getAttribute("data-summary-mode") === "true",
		restarting: live?.getAttribute("data-restarting") === "true",
		...(live?.getAttribute("data-reconnect") &&
		live.getAttribute("data-reconnect") !== "none"
			? { reconnect: live.getAttribute("data-reconnect") }
			: {}),
	};
}

function headerChip(): string {
	const restarting = screen.queryByTestId("live-header-restarting");
	if (restarting) return restarting.textContent?.trim() ?? "";
	return screen.queryByText(m["live.notStreaming"]()) ? "Not streaming" : "";
}

/** Live, then the restart marked before its Stop, as the device publishes it. */
function liveThenRestartStop(container: HTMLElement) {
	hudRestart.streaming = true;
	flushSync();
	expect(cockpit(container)).toMatchObject({ live: true, summary: false });
	hudRestart.restarting = true;
	flushSync();
	hudRestart.streaming = false;
	flushSync();
}

beforeEach(() => {
	vi.useFakeTimers();
	hudRestart.reset();
	reconcile.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	hudRestart.reset();
});

describe("LiveView during a supervised connection restart", () => {
	it("says the connection is restarting for the whole gap, never 'Session ended'", () => {
		const { container } = render(LiveView);
		liveThenRestartStop(container);

		expect(headerChip()).toBe("Restarting connection");
		expect(cockpit(container)).toEqual({
			live: true,
			idle: false,
			summary: false,
			restarting: true,
		});
		// A restart that waits (the modem replay barrier) still says so, and no
		// summary window has quietly been running behind it.
		vi.advanceTimersByTime(SUMMARY_WINDOW_MS * 2);
		flushSync();
		expect(cockpit(container)).toEqual({
			live: true,
			idle: false,
			summary: false,
			restarting: true,
		});

		// The new session runs, then the flag drops: live, and still no summary.
		hudRestart.streaming = true;
		flushSync();
		hudRestart.restarting = false;
		flushSync();
		expect(cockpit(container)).toEqual({
			live: true,
			idle: false,
			summary: false,
			restarting: false,
		});
		expect(screen.queryByTestId("live-header-restarting")).toBeNull();
		expect(screen.getByText(m["live.streamingActive"]())).toBeTruthy();
	});

	it("shows 'Session ended' only once a restart ends without the stream", () => {
		const { container } = render(LiveView);
		liveThenRestartStop(container);
		expect(cockpit(container).summary).toBe(false);

		// The Start did not run: the stream really ended.
		hudRestart.restarting = false;
		flushSync();
		expect(cockpit(container)).toEqual({
			live: true,
			idle: false,
			summary: true,
			restarting: false,
		});
		expect(headerChip()).toBe("Not streaming");

		vi.advanceTimersByTime(SUMMARY_WINDOW_MS);
		flushSync();
		expect(cockpit(container)).toMatchObject({ live: false, idle: true });
	});

	it("a client opening Live mid-restart sees the restart, not the idle cockpit", () => {
		hudRestart.restarting = true;
		const { container } = render(LiveView);
		expect(headerChip()).toBe("Restarting connection");
		expect(cockpit(container)).toEqual({
			live: true,
			idle: false,
			summary: false,
			restarting: true,
		});
	});

	it("keeps an operator Stop pending until the restart has ended", () => {
		const { container } = render(LiveView);
		liveThenRestartStop(container);
		// The restart's own Stop is not a settled stop.
		expect(reconcile).toHaveBeenLastCalledWith(true);
		hudRestart.restarting = false;
		flushSync();
		expect(reconcile).toHaveBeenLastCalledWith(false);
	});
});

describe("LiveView after every link was lost", () => {
	it("says the stream is reconnecting through the window, then holds the session with the window's end until Stop", () => {
		const { container } = render(LiveView);
		liveThenRestartStop(container);
		// The restart's Start failed; the device's window takes over without a gap.
		hudRestart.reconnect = {
			state: "reconnecting",
			remaining_ms: 120_000,
			token: "w1",
		};
		flushSync();
		expect(headerChip()).toBe("Reconnecting");
		expect(cockpit(container)).toEqual({
			live: true,
			idle: false,
			summary: false,
			restarting: true,
			reconnect: "reconnecting",
		});
		expect(screen.queryByText(m["live.notStreaming"]())).toBeNull();

		// Frames apart: the restarting flag drops while the last reconnect status
		// still says reconnecting. The session stays held, no summary flashes.
		hudRestart.restarting = false;
		flushSync();
		expect(cockpit(container)).toMatchObject({
			live: true,
			summary: false,
			restarting: true,
		});

		// The window ran out: nothing retries, but the streamer has not stopped,
		// so the cockpit holds with Keep trying and Stop, and no summary opens.
		hudRestart.reconnect = { state: "expired", reason: "no_link", token: "w1" };
		flushSync();
		expect(headerChip()).toBe("Couldn't reconnect");
		expect(cockpit(container)).toEqual({
			live: true,
			idle: false,
			summary: false,
			restarting: true,
			reconnect: "expired",
		});
		expect(reconcile).toHaveBeenLastCalledWith(true);
		vi.advanceTimersByTime(SUMMARY_WINDOW_MS * 2);
		flushSync();
		expect(cockpit(container).summary).toBe(false);

		// Stop: the device drops the window, and only now the session ends.
		hudRestart.reconnect = null;
		flushSync();
		expect(cockpit(container)).toEqual({
			live: true,
			idle: false,
			summary: true,
			restarting: false,
		});
		expect(reconcile).toHaveBeenLastCalledWith(false);
	});
});
