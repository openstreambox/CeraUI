import { describe, expect, test } from "bun:test";
import {
	isOnboardHdmiInput,
	parseHdmiVideoSignal,
} from "../modules/streaming/hdmi-audio-signal.ts";

describe("HDMI DV timing evidence", () => {
	test("only explicit timing no-link diagnoses missing video", () => {
		for (const error of [
			"VIDIOC_QUERY_DV_TIMINGS: failed: Link has been severed",
			"VIDIOC_QUERY_DV_TIMINGS: No link",
			"VIDIOC_QUERY_DV_TIMINGS: failed: No locks available",
		])
			expect(parseHdmiVideoSignal(error)).toBe(false);
		for (const error of [
			"VIDIOC_QUERY_DV_TIMINGS ok\nNo link budget",
			"VIDIOC_QUERY_DV_TIMINGS ok\r\nNo locks available",
			"Permission denied",
			"No such file or directory",
			"timed out",
			"audio_present: 0",
			"Link has been severed",
		])
			expect(parseHdmiVideoSignal(error)).toBeUndefined();
	});
});

const resolveFixturePath = async (path: string): Promise<string> => {
	if (path === "/dev/hdmirx" || path === "/dev/video0") return "/dev/video0";
	if (path === "/dev/video9") return "/dev/video9";
	throw new Error("missing device");
};
test("onboard receiver selection follows its device symlink", async () => {
	expect(await isOnboardHdmiInput("/dev/video0", resolveFixturePath)).toBe(
		true,
	);
	expect(await isOnboardHdmiInput("/dev/video9", resolveFixturePath)).toBe(
		false,
	);
});
test("unresolvable selections preserve engine admission", async () => {
	expect(await isOnboardHdmiInput("capture:missing", resolveFixturePath)).toBe(
		false,
	);
});
test("the default input and receiver alias need no identity lookup", async () => {
	const unexpectedLookup = async (): Promise<string> => {
		throw new Error("must not resolve");
	};
	expect(await isOnboardHdmiInput(undefined, unexpectedLookup)).toBe(true);
	expect(await isOnboardHdmiInput("/dev/hdmirx", unexpectedLookup)).toBe(true);
});
