import { describe, expect, it, vi } from "vitest";

vi.mock("@ceraui/i18n/svelte", () => ({
	m: {
		"live.startFailure.class.audio_source_unavailable": () =>
			"The selected audio input is not available.",
		// The refusal copy now words the audio class with the notification key.
		"notifications.streamStartAudioSourceUnavailableFailed": () =>
			"The selected audio input is not available.",
		"live.startFailure.notRetriable": () => "Open logs.",
	},
}));

import { startFailureMessage } from "../lib/streaming/start-failure-copy";

describe("audio admission operator copy", () => {
	it("uses the localized audio class copy without raw engine diagnostics", () => {
		// An audio refusal has no next step, so it keeps the logs pointer.
		expect(
			startFailureMessage(
				{
					class: "audio_source_unavailable",
					phase: "params",
					retriable: false,
				},
				false,
				true,
			).message,
		).toBe("The selected audio input is not available. Open logs.");
	});
});
