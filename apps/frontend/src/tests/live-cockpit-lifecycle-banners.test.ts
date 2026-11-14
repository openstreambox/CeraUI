// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { en } from "./helpers/catalog";

vi.mock("$lib/components/custom/IngestStats.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/BitrateAdjuster.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/LiveSourceSwitch.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/LiveSummaryStrip.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/StreamControlButton.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/StreamTelemetryStrip.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));

import LiveCockpit from "../main/live/LiveCockpit.svelte";

// biome-ignore lint/suspicious/noExplicitAny: minimal props shim for a presentational cockpit render
function baseProps(overrides: Record<string, any>): any {
	return {
		liveSummary: { source: "HDMI", parts: [] },
		bitrate: "6.0",
		bitrateDraft: 6000,
		bitrateLabel: "6.0 Mbps",
		bitrateMin: 500,
		bitrateMax: 12000,
		sliderMin: 500,
		sliderMax: 12000,
		step: 100,
		onStep: () => {},
		onSliderChange: () => {},
		onSliderCommit: () => {},
		telemetry: null,
		isStreaming: true,
		optimismState: "streaming",
		onStop: () => {},
		...overrides,
	};
}

const capture = (id: string, lost = false) => ({
	id,
	origin: "capture" as const,
	kind: "hdmi" as const,
	displayName: id,
	lost,
	available: true,
	modes: [],
	audioKind: "none" as const,
});

const link = (stale: boolean) => ({
	conn_id: stale ? "1" : "2",
	iface: stale ? "eth0" : "wlan0",
	rtt_ms: 0,
	nak_count: 0,
	weight_percent: 100,
	stale,
});

afterEach(() => cleanup());

describe("LiveCockpit — active video source loss banner", () => {
	it("shows when the running source vanished from the list", async () => {
		const { getByTestId } = render(
			LiveCockpit,
			baseProps({
				config: { source: "cam0" },
				sources: { hardware: [], sources: [capture("cam1")] },
			}),
		);
		await tick();
		expect(getByTestId("active-source-lost-banner").textContent).toContain(
			en.live.source.lostStreamingTitle,
		);
	});

	it("shows when the running source is present but flagged lost", async () => {
		const { getByTestId } = render(
			LiveCockpit,
			baseProps({
				config: { source: "cam0" },
				sources: { hardware: [], sources: [capture("cam0", true)] },
			}),
		);
		await tick();
		expect(getByTestId("active-source-lost-banner")).toBeTruthy();
	});

	it("does NOT show when the running source is present and healthy", async () => {
		const { queryByTestId } = render(
			LiveCockpit,
			baseProps({
				config: { source: "cam0" },
				sources: { hardware: [], sources: [capture("cam0")] },
			}),
		);
		await tick();
		expect(queryByTestId("active-source-lost-banner")).toBeNull();
	});

	it("does NOT show before the first sources snapshot arrives", async () => {
		const { queryByTestId } = render(
			LiveCockpit,
			baseProps({
				config: { source: "cam0" },
				sources: { hardware: [], sources: [] },
			}),
		);
		await tick();
		expect(queryByTestId("active-source-lost-banner")).toBeNull();
	});

	it("does NOT show while idle (not streaming)", async () => {
		const { queryByTestId } = render(
			LiveCockpit,
			baseProps({
				isStreaming: false,
				config: { source: "cam0" },
				sources: { hardware: [], sources: [capture("cam1")] },
			}),
		);
		await tick();
		expect(queryByTestId("active-source-lost-banner")).toBeNull();
	});

	it("prefers engine active_input over config.source for the running id", async () => {
		const { getByTestId } = render(
			LiveCockpit,
			baseProps({
				config: { source: "cam0" },
				activeEncode: { active_input: "cam9" },
				sources: { hardware: [], sources: [capture("cam0")] },
			}),
		);
		await tick();
		expect(getByTestId("active-source-lost-banner")).toBeTruthy();
	});
});

describe("LiveCockpit — active audio device loss banner", () => {
	it("shows the silence-failover banner when audioSourceLost is true", async () => {
		const { getByTestId } = render(
			LiveCockpit,
			baseProps({ audioSourceLost: true }),
		);
		await tick();
		expect(getByTestId("active-audio-lost-banner").textContent).toContain(
			en.live.source.audioLostStreamingTitle,
		);
	});

	it("does NOT show when audioSourceLost is false", async () => {
		const { queryByTestId } = render(
			LiveCockpit,
			baseProps({ audioSourceLost: false }),
		);
		await tick();
		expect(queryByTestId("active-audio-lost-banner")).toBeNull();
	});

	it("does NOT show while idle even if audioSourceLost is true", async () => {
		const { queryByTestId } = render(
			LiveCockpit,
			baseProps({ isStreaming: false, audioSourceLost: true }),
		);
		await tick();
		expect(queryByTestId("active-audio-lost-banner")).toBeNull();
	});
});

describe("LiveCockpit — all-links-down banner", () => {
	it("shows when every link is stale while streaming", async () => {
		const { getByTestId } = render(
			LiveCockpit,
			baseProps({ telemetry: { links: [link(true), link(true)] } }),
		);
		await tick();
		expect(getByTestId("all-links-down-banner").textContent).toContain(
			en.live.source.linksDownStreamingTitle,
		);
	});

	it("does NOT show when at least one link is active (partial drop)", async () => {
		const { queryByTestId } = render(
			LiveCockpit,
			baseProps({ telemetry: { links: [link(true), link(false)] } }),
		);
		await tick();
		expect(queryByTestId("all-links-down-banner")).toBeNull();
	});

	it("does NOT show with no links reported", async () => {
		const { queryByTestId } = render(
			LiveCockpit,
			baseProps({ telemetry: { links: [] } }),
		);
		await tick();
		expect(queryByTestId("all-links-down-banner")).toBeNull();
	});

	it("does NOT show while idle", async () => {
		const { queryByTestId } = render(
			LiveCockpit,
			baseProps({
				isStreaming: false,
				telemetry: { links: [link(true)] },
			}),
		);
		await tick();
		expect(queryByTestId("all-links-down-banner")).toBeNull();
	});
});

describe("LiveCockpit — backend owns frame-loss notices", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());
	for (const origin of ["capture", "network", "unknown"]) {
		it(`does not duplicate the persistent ${origin} camera notice`, async () => {
			const source =
				origin === "capture"
					? capture("cam0")
					: origin === "network"
						? {
								id: "cam0",
								origin: "network",
								displayName: "Network",
								available: true,
								audioKind: "none",
								protocol: "rtmp",
							}
						: undefined;
			const props = baseProps({
				config: { source: "cam0" },
				sources: { hardware: [], sources: source ? [source] : [] },
				videoSignalLost: true,
			});
			const view = render(LiveCockpit, props);
			await tick();
			// A late 5.5 s tick and a prolonged outage must never start a second timer.
			await vi.advanceTimersByTimeAsync(5500);
			await tick();
			expect(view.queryByTestId("video-signal-lost-banner")).toBeNull();
			await vi.advanceTimersByTimeAsync(600000);
			await tick();
			expect(view.queryByTestId("video-signal-lost-banner")).toBeNull();
			await view.rerender({ ...props, videoSignalLost: false });
			await tick();
			expect(view.queryByTestId("video-signal-lost-banner")).toBeNull();
		});
	}
	for (const [name, isStreaming, videoSignalLost] of [
		["frames are flowing", true, false],
		["the stream is idle", false, true],
	] as const) {
		it(`does not show a frame-loss banner when ${name}`, async () => {
			const view = render(
				LiveCockpit,
				baseProps({
					isStreaming,
					videoSignalLost,
					config: { source: "cam0" },
					sources: { hardware: [], sources: [capture("cam0")] },
				}),
			);
			await tick();
			await vi.advanceTimersByTimeAsync(5500);
			await tick();
			expect(view.queryByTestId("video-signal-lost-banner")).toBeNull();
		});
	}
	it("retains the source-reconnect action when the device itself vanishes", async () => {
		const view = render(
			LiveCockpit,
			baseProps({
				config: { source: "cam0" },
				sources: { hardware: [], sources: [capture("cam1")] },
				videoSignalLost: true,
			}),
		);
		await tick();
		await vi.advanceTimersByTimeAsync(5500);
		await tick();
		expect(view.queryByTestId("active-source-lost-banner")).toBeTruthy();
		expect(view.queryByTestId("video-signal-lost-banner")).toBeNull();
	});
});

describe("LiveCockpit — summary mode suppresses every lifecycle banner", () => {
	it("hides all four banners in summaryMode", async () => {
		const { queryByTestId } = render(
			LiveCockpit,
			baseProps({
				summaryMode: true,
				audioSourceLost: true,
				videoSignalLost: true,
				config: { source: "cam0" },
				sources: { hardware: [], sources: [capture("cam1")] },
				telemetry: { links: [link(true)] },
			}),
		);
		await tick();
		expect(queryByTestId("active-source-lost-banner")).toBeNull();
		expect(queryByTestId("active-audio-lost-banner")).toBeNull();
		expect(queryByTestId("all-links-down-banner")).toBeNull();
		expect(queryByTestId("video-signal-lost-banner")).toBeNull();
	});
});
