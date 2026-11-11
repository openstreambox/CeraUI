import { describe, expect, test } from "bun:test";
import {
	isHdmiCaptureAudio,
	parseHdmiAudioSignal,
} from "../modules/streaming/hdmi-audio-signal.ts";

describe("HDMI audio admission evidence", () => {
	test("video lock or a stale sample rate is not audio", () => {
		expect(
			parseHdmiAudioSignal("audio_present: 0\naudio_sampling_rate: 48000\n"),
		).toBe(false);
		expect(
			parseHdmiAudioSignal("audio_present: 1\naudio_sampling_rate: 0\n"),
		).toBe(false);
		expect(
			parseHdmiAudioSignal("audio_present: 1\naudio_sampling_rate: 48000\n"),
		).toBe(true);
	});
	test("unavailable evidence stays unknown", () => {
		for (const value of [
			"",
			"audio_present: 1",
			"audio_sampling_rate: 48000",
			"audio_present: yes\naudio_sampling_rate: 48000",
		]) {
			expect(parseHdmiAudioSignal(value)).toBeUndefined();
		}
	});
	test("scope is capture identities, never transmitter or USB", () => {
		for (const card of ["HDMIIN", "rockchiphdmiin", "hdmirx"]) {
			expect(isHdmiCaptureAudio(`hw:CARD=${card}`)).toBe(true);
			expect(isHdmiCaptureAudio(card)).toBe(true);
		}
		for (const card of ["hdmi0", "USB", "HDMIIN-other"])
			expect(isHdmiCaptureAudio(`hw:CARD=${card}`)).toBe(false);
	});
});
