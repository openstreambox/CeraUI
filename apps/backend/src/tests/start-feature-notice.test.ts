import { afterEach, beforeEach, expect, test } from "bun:test";

import {
	noteLiveCompositionApplied,
	postStartFeatureNotice,
	resetStartFeatureNoticeForTest,
	START_FEATURES_NOTIFICATION,
	type StartFeatureNoticeBridge,
} from "../modules/streaming/start-feature-notice.ts";

// A notice saying the stream runs without its layout must not outlive a live
// change that put a layout on air. A dropped mix cannot be fixed on air (live
// mixer edits need a running mixer input), so that part stays.

function recordingBridge() {
	const shown = new Map<string, string>();
	const localized = new Map<
		string,
		{ key?: string; params?: Record<string, unknown> }
	>();
	const bridge: StartFeatureNoticeBridge = {
		notify: (name, _type, msg, _d, _p, _dis, _authed, key, params) => {
			shown.set(name, msg);
			localized.set(name, { key, params });
		},
		notificationExists: (name) => shown.has(name),
		removeNotification: (name) => {
			shown.delete(name);
		},
	};
	return { bridge, shown, localized };
}

beforeEach(() => resetStartFeatureNoticeForTest());
afterEach(() => resetStartFeatureNoticeForTest());

test("a live composition change removes the layout part and keeps the mix part", () => {
	const { bridge, shown, localized } = recordingBridge();
	postStartFeatureNotice(bridge, ["audio-mix", "custom-layout"], false);

	noteLiveCompositionApplied();

	const msg = shown.get(START_FEATURES_NOTIFICATION);
	expect(msg).toContain("audio mix");
	expect(msg).not.toContain("layout");
	expect(localized.get(START_FEATURES_NOTIFICATION)?.params).toEqual({
		features: ["audio-mix"],
	});
});

// The notice is localized in the UI: it carries a catalog key for the reason
// and the dropped features as tokens, with the English sentence as fallback.
test("the notice sends a catalog key and the dropped features, not only English", () => {
	const { bridge, shown, localized } = recordingBridge();

	postStartFeatureNotice(bridge, ["audio-mix", "custom-layout"], false);
	expect(localized.get(START_FEATURES_NOTIFICATION)).toEqual({
		key: "notifications.startFeatures.unconfirmed",
		params: { features: ["audio-mix", "custom-layout"] },
	});

	postStartFeatureNotice(bridge, ["composition"], true);
	expect(localized.get(START_FEATURES_NOTIFICATION)).toEqual({
		key: "notifications.startFeatures.unsupported",
		params: { features: ["composition"] },
	});
	expect(shown.get(START_FEATURES_NOTIFICATION)).toBe(
		"Streaming without the picture-in-picture composition: the streaming engine does not support this. Your saved settings are kept.",
	);
});

test("a live composition change clears a notice that was only about the layout", () => {
	const { bridge, shown } = recordingBridge();
	postStartFeatureNotice(bridge, ["custom-layout"], false);

	noteLiveCompositionApplied();

	expect(shown.has(START_FEATURES_NOTIFICATION)).toBe(false);
});

test("a live composition change leaves a mix-only notice alone", () => {
	const { bridge, shown } = recordingBridge();
	postStartFeatureNotice(bridge, ["audio-mix"], true);
	const before = shown.get(START_FEATURES_NOTIFICATION);

	noteLiveCompositionApplied();

	expect(shown.get(START_FEATURES_NOTIFICATION)).toBe(before);
});

test("a live composition change does not bring back a notice the streamer dismissed", () => {
	const { bridge, shown } = recordingBridge();
	postStartFeatureNotice(bridge, ["audio-mix", "custom-layout"], false);
	shown.delete(START_FEATURES_NOTIFICATION);

	noteLiveCompositionApplied();

	expect(shown.has(START_FEATURES_NOTIFICATION)).toBe(false);
});

// The audio a start falls back to depends on the saved source (it can be no
// audio at all, or the engine's own pick), so the notice names the mix only.
test("a dropped mix does not promise which audio the stream carries", () => {
	const { bridge, shown } = recordingBridge();
	postStartFeatureNotice(bridge, ["audio-mix"], true);

	expect(shown.get(START_FEATURES_NOTIFICATION)).toBe(
		"Streaming without the audio mix: the streaming engine does not support this. Your saved settings are kept.",
	);
});
