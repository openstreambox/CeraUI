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
	const bridge: StartFeatureNoticeBridge = {
		notify: (name, _type, msg) => {
			shown.set(name, msg);
		},
		notificationExists: (name) => shown.has(name),
		removeNotification: (name) => {
			shown.delete(name);
		},
	};
	return { bridge, shown };
}

beforeEach(() => resetStartFeatureNoticeForTest());
afterEach(() => resetStartFeatureNoticeForTest());

test("a live composition change removes the layout part and keeps the mix part", () => {
	const { bridge, shown } = recordingBridge();
	postStartFeatureNotice(bridge, ["audio-mix", "custom-layout"], false);

	noteLiveCompositionApplied();

	const msg = shown.get(START_FEATURES_NOTIFICATION);
	expect(msg).toContain("audio mix");
	expect(msg).not.toContain("layout");
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
