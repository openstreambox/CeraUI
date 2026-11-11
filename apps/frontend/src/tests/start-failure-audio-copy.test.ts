import { describe, expect, it, vi } from "vitest";

vi.mock("@ceraui/i18n/svelte", () => ({
	m: {
		"live.startFailed.audio_source_probe_failed": () =>
			"Reconnect audio or select another source, then retry.",
		"live.startFailure.notRetriable": () => "Open logs.",
	},
}));

import { startFailureMessage } from "../lib/streaming/start-failure-copy";

describe("audio admission operator copy", () => {
	it("uses the existing localized reconnect remedy without raw engine diagnostics", () => {
		expect(
			startFailureMessage({
				class: "audio_source_unavailable",
				retriable: false,
			}),
		).toBe("Reconnect audio or select another source, then retry. Open logs.");
	});
});
