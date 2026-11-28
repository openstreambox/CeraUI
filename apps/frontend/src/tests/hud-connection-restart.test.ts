// @vitest-environment jsdom
/**
 * During a supervised connection restart (the stale-link tap, or the device's
 * own restart when nothing else carried the stream) the device is briefly not
 * streaming, but nobody stopped the stream. The HUD and the Live header say
 * the connection is restarting. They never say "Idle", "Not streaming" or
 * "Streaming stopped".
 */
import { m } from "@ceraui/i18n/svelte";
import { render, screen, waitFor } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HudState } from "$lib/types/hud";

import { hudRestart } from "./fixtures/reactive-hud-restart.svelte";

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const { hudRestart: state } = await import(
		"./fixtures/reactive-hud-restart.svelte"
	);
	return {
		getStatus: () => ({
			connection_restarting: state.restarting,
			stream_reconnect: state.reconnect,
		}),
	};
});

vi.mock("$lib/stores/hud.svelte", async () => {
	const { hudRestart: state } = await import(
		"./fixtures/reactive-hud-restart.svelte"
	);
	const hud = (): HudState => ({
		isStreaming: state.streaming,
		isStreamingStale: false,
		bitrateKbps: null,
		measuredBitrateKbps: null,
		isBitrateStale: false,
		links: [],
		staleInterfaces: new Set<string>(),
		temperature: null,
		voltage: null,
		current: null,
		inputVoltage: null,
		isSensorsStale: false,
		isConnected: true,
		isFullyStale: false,
		isUpdating: false,
		lastUpdatedAt: { streaming: Date.now(), sensors: null, modems: null },
	});
	return {
		getHudState: hud,
		getSocTelemetry: () => ({
			temp: null,
			voltage: null,
			current: null,
			isStale: false,
		}),
	};
});

vi.mock("$lib/stores/stream-health.svelte", () => ({
	getStreamHealthState: () => "idle",
	getStreamHealthRollup: () => null,
}));
vi.mock("$lib/stores/buffering.svelte", () => ({
	getBufferingState: () => null,
}));
vi.mock("$lib/stores/display-profile.svelte", () => ({
	getDisplayProfile: () => ({ theme: "lcd" }),
	getDisplayRefreshNonce: () => 0,
	prefersEinkTheme: () => false,
}));

const noop = vi.hoisted(() => async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$lib/components/custom/BondConstellation.svelte", noop);
vi.mock("$lib/components/custom/BufferingIndicator.svelte", noop);
vi.mock("$lib/components/custom/LinkIndicator.svelte", noop);
vi.mock("$lib/components/custom/Badge.svelte", noop);

import HudBar from "$main/HudBar.svelte";
import LiveHeader from "$main/live/LiveHeader.svelte";

const NEVER = ["Idle", "Not streaming", "Streaming stopped", "Not live"];

function leadBadge(): string {
	return (
		document.querySelector('[id$="-lifecycle"]')?.textContent?.trim() ?? ""
	);
}

beforeEach(() => {
	hudRestart.reset();
});

afterEach(() => {
	hudRestart.reset();
});

describe("the HUD during a supervised connection restart", () => {
	it("says the connection is restarting, not idle, and hides the idle health", () => {
		hudRestart.restarting = true;
		render(HudBar);
		expect(leadBadge()).toBe(m["hud.restartingConnection"]());
		expect(leadBadge()).toBe("Restarting connection");
		for (const phrase of NEVER) expect(leadBadge()).not.toContain(phrase);
		expect(screen.queryByTestId("stream-health")).toBeNull();
	});

	it("says the stream is reconnecting, not idle, during the reconnect window", () => {
		hudRestart.restarting = true;
		hudRestart.reconnect = {
			state: "reconnecting",
			remaining_ms: 60_000,
			token: "w1",
		};
		render(HudBar);
		expect(leadBadge()).toBe("Reconnecting");
		for (const phrase of NEVER) expect(leadBadge()).not.toContain(phrase);
		expect(screen.queryByTestId("stream-health")).toBeNull();
	});

	it("announces the restart instead of 'Streaming stopped' when its Stop lands", async () => {
		hudRestart.streaming = true;
		render(HudBar);
		flushSync();
		// The restart is marked before its Stop, as the device publishes it.
		hudRestart.restarting = true;
		flushSync();
		hudRestart.streaming = false;
		flushSync();
		const region = screen.getByTestId("hud-transition-status");
		await waitFor(
			() =>
				expect(region.textContent).toBe(
					"Restarting the connection. Viewers see your BRB screen for a few seconds.",
				),
			{ timeout: 3000 },
		);
		// The restart finishing must not retract what was announced.
		hudRestart.restarting = false;
		flushSync();
		expect(region.textContent).not.toContain("Streaming stopped");
	});

	it("keeps the restart announcement when the flag drops before it is spoken", async () => {
		hudRestart.streaming = true;
		render(HudBar);
		flushSync();
		hudRestart.restarting = true;
		flushSync();
		hudRestart.streaming = false;
		flushSync();
		// The restart ends inside the announcement's debounce. The stop edge was
		// the restart's, so what it announced must still be spoken, not dropped.
		hudRestart.restarting = false;
		flushSync();
		const region = screen.getByTestId("hud-transition-status");
		await waitFor(
			() =>
				expect(region.textContent).toBe(
					m["hud.announceConnectionRestarting"](),
				),
			{ timeout: 3000 },
		);
	});

	it("still says 'Streaming stopped' for a real stop", async () => {
		hudRestart.streaming = true;
		render(HudBar);
		flushSync();
		hudRestart.streaming = false;
		flushSync();
		const region = screen.getByTestId("hud-transition-status");
		await waitFor(
			() => expect(region.textContent).toBe(m["hud.announceStreamStopped"]()),
			{ timeout: 3000 },
		);
		expect(leadBadge()).toBe(m["hud.idle"]());
	});

	it("shows live again once the new session runs", () => {
		hudRestart.restarting = true;
		render(HudBar);
		hudRestart.streaming = true;
		flushSync();
		expect(leadBadge()).toBe(m["hud.live"]());
	});
});

describe("the Live header during a supervised connection restart", () => {
	it("says the connection is restarting instead of 'Not streaming'", () => {
		render(LiveHeader, { props: { isStreaming: false, restarting: true } });
		const chip = screen.getByTestId("live-header-restarting");
		expect(chip.textContent?.trim()).toBe("Restarting connection");
		expect(screen.queryByText(m["live.notStreaming"]())).toBeNull();
	});

	it("is live, not restarting, once the stream runs", () => {
		render(LiveHeader, { props: { isStreaming: true, restarting: true } });
		expect(screen.queryByTestId("live-header-restarting")).toBeNull();
		expect(screen.getByText(m["live.streamingActive"]())).toBeTruthy();
	});
});
