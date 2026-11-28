// @vitest-environment jsdom
/**
 * LiveCockpit while a supervised connection restart is between its Stop and
 * its Start (`restarting`). The session goes on: the cockpit says the
 * connection is restarting and what viewers see, keeps Stop, and the session
 * rollup is not closed into a "Session ended" summary until the stream really
 * ends.
 */
import { m } from "@ceraui/i18n/svelte";
import type { SourcesMessage } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { beforeAll, describe, expect, it } from "vitest";

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
		summaryMode: over.summaryMode ?? false,
	};
}

describe("LiveCockpit during a supervised connection restart", () => {
	it("says the connection is restarting and that viewers see the BRB screen, keeps Stop, and ends no session", async () => {
		const { container, getByTestId, queryByTestId, getByRole, rerender } =
			render(LiveCockpit, { props: props({ isStreaming: true }) });
		expect(queryByTestId("live-restarting-banner")).toBeNull();
		expect(getByTestId("live-summary-label").textContent?.trim()).toBe(
			"Now streaming",
		);

		// The restart's Stop lands.
		await rerender(props({ isStreaming: false, restarting: true }));
		const band = getByTestId("live-restarting-banner");
		expect(band.getAttribute("role")).toBe("status");
		expect(band.textContent).toContain("Restarting connection");
		expect(band.textContent).toContain(
			"Viewers see your BRB screen for a few seconds.",
		);
		expect(band.textContent).toContain(m["live.restartingConnectionBody"]());
		expect(getByTestId("live-summary-label").textContent?.trim()).toBe(
			"Stream setup",
		);
		// Stop stays, so an operator Stop can still cancel the restart.
		expect(getByRole("button", { name: m["live.stopStream"]() })).toBeTruthy();
		expect(container.textContent).not.toContain(m["live.startStream"]());
		// The session rollup stays open: no "Session ended" summary, no Done.
		expect(queryByTestId("ingest-summary")).toBeNull();
		expect(queryByTestId("summary-done")).toBeNull();

		// The new session runs: the band goes, the stream is live.
		await rerender(props({ isStreaming: true, restarting: false }));
		expect(queryByTestId("live-restarting-banner")).toBeNull();
		expect(queryByTestId("ingest-summary")).toBeNull();
	});

	it("closes the session into its summary once a restart ends without the stream", async () => {
		// The session samples telemetry frames only, so the stream reports one.
		const { queryByTestId, rerender } = render(LiveCockpit, {
			props: props({ isStreaming: true, telemetry: { links: [] } }),
		});
		await rerender(props({ isStreaming: false, restarting: true }));
		expect(queryByTestId("ingest-summary")).toBeNull();

		// LiveView opens the summary window when the restart ends without Start.
		await rerender(props({ isStreaming: false, summaryMode: true }));
		expect(queryByTestId("live-restarting-banner")).toBeNull();
		expect(queryByTestId("ingest-summary")).not.toBeNull();
		expect(queryByTestId("summary-done")).not.toBeNull();
	});
});
