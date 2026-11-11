import { describe, expect, test } from "bun:test";
import { parseHdmiNoSignal } from "../modules/streaming/hdmi-audio-signal.ts";

describe("HDMI DV timing evidence", () => {
	test("only explicit timing no-link diagnoses missing video", () => {
		for (const error of [
			"VIDIOC_QUERY_DV_TIMINGS: failed: Link has been severed",
			"VIDIOC_QUERY_DV_TIMINGS: No link",
			"VIDIOC_QUERY_DV_TIMINGS: failed: No locks available",
		])
			expect(parseHdmiNoSignal(error)).toBe(false);
		for (const error of [
			"Permission denied",
			"No such file or directory",
			"timed out",
			"audio_present: 0",
			"Link has been severed",
		])
			expect(parseHdmiNoSignal(error)).toBeUndefined();
	});
});
