// @vitest-environment jsdom
/**
 * LiveCockpit after every link was lost: the reconnect window counts down the
 * time left from the status it got, offers "Keep trying" beside Stop, and after
 * the window ran out says what was missing, still with "Keep trying" and Stop.
 * It never says the stream is "not live" or "offline".
 */
import { m } from "@ceraui/i18n/svelte";
import type {
	SourcesMessage,
	StreamReconnectStatus,
} from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const keepCalls: unknown[] = [];
vi.mock("$lib/rpc", () => ({
	rpc: {
		notifications: { dismiss: () => Promise.resolve({}) },
		streaming: {
			keepReconnecting: (input: unknown) => {
				keepCalls.push(input);
				return Promise.resolve({ success: true, result: "reconnecting" });
			},
		},
	},
}));

import type { StreamingOptimismState } from "$lib/rpc/streaming-optimism.svelte";
import type { ActiveSummary } from "$lib/streaming/sourceSummary";
import LiveCockpit from "$main/live/LiveCockpit.svelte";

beforeAll(() => {
	if (!("ResizeObserver" in window)) {
		(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		};
	}
});

const SUMMARY: ActiveSummary = {
	live: true,
	source: "HDMI Capture",
	resolution: "1080p",
	framerate: 60,
	codec: "H.265",
	inputCodec: undefined,
	passthrough: undefined,
	transport: "SRTLA",
};

function props(
	over: Partial<{
		isStreaming: boolean;
		restarting: boolean;
		reconnect: StreamReconnectStatus | null;
		summaryMode: boolean;
		telemetry: { links: [] } | null;
	}> = {},
) {
	return {
		liveSummary: SUMMARY,
		sources: undefined as SourcesMessage | undefined,
		bitrate: "6 Mbps",
		bitrateDraft: 6000,
		bitrateLabel: "6 Mbps",
		bitrateMin: 500,
		bitrateMax: 12000,
		sliderMin: 1000,
		sliderMax: 9000,
		step: 250,
		onStep: () => {},
		onSliderChange: () => {},
		onSliderCommit: () => {},
		telemetry: over.telemetry ?? null,
		bitrateKbps: 6000,
		isStreaming: over.isStreaming ?? false,
		optimismState: "idle" as StreamingOptimismState,
		onStop: () => {},
		restarting: over.restarting ?? false,
		reconnect: over.reconnect ?? null,
		summaryMode: over.summaryMode ?? false,
	};
}

const reconnecting = (
	remaining_ms: number,
	token = "window-1",
): StreamReconnectStatus => ({
	state: "reconnecting",
	remaining_ms,
	token,
});

beforeEach(() => {
	keepCalls.length = 0;
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("LiveCockpit while the stream reconnects after every link was lost", () => {
	it("counts the time left down from its own receipt, offers Keep trying, and keeps Stop", async () => {
		const { getByTestId, getByRole, queryByTestId, container } = render(
			LiveCockpit,
			{
				props: props({ restarting: true, reconnect: reconnecting(84_000) }),
			},
		);
		const band = getByTestId("live-reconnect-banner");
		expect(band.getAttribute("role")).toBe("status");
		expect(band.textContent).toContain("Reconnecting the stream");
		expect(getByTestId("live-reconnect-left").textContent).toBe("1:24 left");
		expect(band.textContent).toContain(m["live.reconnectingBody"]());
		// Not the plain restart band, and never "not live" or "offline".
		expect(queryByTestId("live-restarting-banner")).toBeNull();
		expect(container.textContent?.toLowerCase()).not.toContain("not live");
		expect(container.textContent?.toLowerCase()).not.toContain("offline");
		expect(container.textContent).not.toContain(m["live.notStreaming"]());

		await vi.advanceTimersByTimeAsync(4_000);
		expect(getByTestId("live-reconnect-left").textContent).toBe("1:20 left");

		expect(getByRole("button", { name: m["live.stopStream"]() })).toBeTruthy();
		await fireEvent.click(getByTestId("live-reconnect-keep-trying"));
		expect(keepCalls).toEqual([{ token: "window-1" }]);
	});

	it("restarts the countdown when Keep trying gave a full window", async () => {
		const { getByTestId, rerender } = render(LiveCockpit, {
			props: props({ restarting: true, reconnect: reconnecting(10_000) }),
		});
		expect(getByTestId("live-reconnect-left").textContent).toBe("0:10 left");
		await rerender(
			props({ restarting: true, reconnect: reconnecting(120_000) }),
		);
		expect(getByTestId("live-reconnect-left").textContent).toBe("2:00 left");
	});

	it.each([
		["no_link", "Couldn't reconnect: no network link came back."],
		[
			"start_failed",
			"Couldn't reconnect: the stream didn't start again on the links that are up.",
		],
	] as const)(
		"after the window ran out (%s) says so, offers Keep trying again, and keeps Stop",
		async (reason, text) => {
			const { getByTestId, getByRole, queryByTestId } = render(LiveCockpit, {
				props: props({
					restarting: true,
					reconnect: { state: "expired", reason, token: "window-2" },
				}),
			});
			const band = getByTestId("live-reconnect-banner");
			expect(band.getAttribute("data-state")).toBe("expired");
			expect(band.textContent).toContain(text);
			expect(band.textContent).toContain(m["live.reconnectExpiredBody"]());
			expect(queryByTestId("live-reconnect-left")).toBeNull();
			expect(
				getByRole("button", { name: m["live.stopStream"]() }),
			).toBeTruthy();
			await fireEvent.click(getByTestId("live-reconnect-keep-trying"));
			expect(keepCalls).toEqual([{ token: "window-2" }]);
		},
	);
});
