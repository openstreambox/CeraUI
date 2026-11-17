import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import { getConfig } from "../modules/config.ts";
import { AudioProbeTimeoutError } from "../modules/streaming/audio.ts";
import type { Pipeline } from "../modules/streaming/pipelines.ts";
import {
	getIsStreaming,
	updateStatus,
} from "../modules/streaming/streaming.ts";
import { getStreamingProcesses } from "../modules/streaming/streamloop/process-runner.ts";
import {
	AUDIO_SOURCE_PROBE_FAILED,
	maybeProbeAudioSource,
	startStream,
} from "../modules/streaming/streamloop/start-stream.ts";

const audioPipeline = {
	source: "hdmi",
	name: "Test HDMI",
	hardware: "rk3588",
	description: "test pipeline",
	supportsAudio: true,
	supportsResolutionOverride: false,
	supportsFramerateOverride: false,
	audio_kind: "selectable",
} as Pipeline;

const failingProbe = (): Promise<string> =>
	Promise.reject(new AudioProbeTimeoutError("HDMI"));

describe("startStream — audio-source probe failure surfaces a structured reason (C7)", () => {
	let savedAsrc: string | undefined;
	let savedMaxBr: number | undefined;

	beforeEach(() => {
		const config = getConfig();
		savedAsrc = config.asrc;
		savedMaxBr = config.max_br;
		config.asrc = "HDMI";
		config.max_br = undefined;
	});

	afterEach(() => {
		const config = getConfig();
		config.asrc = savedAsrc;
		config.max_br = savedMaxBr;
		updateStatus(false);
	});

	test("a failing probe returns BOTH error and reason as audio_source_probe_failed", async () => {
		updateStatus(true);
		expect(getIsStreaming()).toBe(true);

		const result = await startStream(audioPipeline, "192.0.2.10", 5000, "sid", {
			hdmiVideoSignal: async () => undefined,
			probe: failingProbe,
		});

		expect(result).toEqual({
			success: false,
			error: AUDIO_SOURCE_PROBE_FAILED,
			reason: AUDIO_SOURCE_PROBE_FAILED,
			phase: "params",
			failureClass: "audio_source_unavailable",
		});
		expect(AUDIO_SOURCE_PROBE_FAILED).toBe("audio_source_probe_failed");
	});

	test("the probe-fail path leaves is_streaming false and spawns no srtla process", async () => {
		updateStatus(false);

		const result = await startStream(audioPipeline, "192.0.2.10", 5000, "sid", {
			hdmiVideoSignal: async () => undefined,
			probe: failingProbe,
		});

		expect(result.success).toBe(false);
		expect(getIsStreaming()).toBe(false);
		expect(getStreamingProcesses().length).toBe(0);
	});
});

describe("maybeProbeAudioSource — pseudo-sentinels never probe (C7)", () => {
	test("'No audio' / 'Pipeline default' return true WITHOUT invoking the probe", async () => {
		let probeCalls = 0;
		const spyProbe = (asrc: string): Promise<string> => {
			probeCalls += 1;
			return Promise.reject(new Error(`probe must not run for '${asrc}'`));
		};

		for (const asrc of ["No audio", "Pipeline default"]) {
			const ok = await maybeProbeAudioSource(
				audioPipeline,
				{ ...getConfig(), asrc } as RuntimeConfig,
				{ probe: spyProbe },
			);
			expect(ok).toBe(true);
		}
		expect(probeCalls).toBe(0);
	});

	test("a real device with a resolved audio source is accepted", async () => {
		expect(
			await maybeProbeAudioSource(
				audioPipeline,
				{ ...getConfig(), asrc: "HDMI" },
				{ probe: async () => "HDMIIN" },
			),
		).toBe(true);
	});

	test("a real device that fails the probe blocks the start (returns false)", async () => {
		const ok = await maybeProbeAudioSource(
			audioPipeline,
			{ ...getConfig(), asrc: "HDMI" } as RuntimeConfig,
			{ probe: failingProbe },
		);
		expect(ok).toBe(false);
	});
});

describe("HDMI signal admission", () => {
	test("no DV signal refuses with an actionable typed capture cause", async () => {
		await expect(
			startStream(audioPipeline, "192.0.2.10", 5000, "sid", {
				hdmiVideoSignal: async () => false,
				probe: async () => {
					throw new Error("audio probe must not run");
				},
			}),
		).rejects.toMatchObject({
			failure: {
				class: "capture_source_unavailable",
				captureCause: "no_signal",
				retriable: false,
			},
		});
	});
	for (const [name, pipeline, selected, verdict, expectedCalls] of [
		[
			"unknown signal admits audio probing",
			audioPipeline,
			undefined,
			undefined,
			1,
		],
		["valid video admits audio probing", audioPipeline, undefined, true, 1],
		[
			"non-HDMI never probes receiver",
			{ ...audioPipeline, source: "usb" },
			undefined,
			false,
			0,
		],
		[
			"other HDMI input never probes onboard receiver",
			audioPipeline,
			"capture:secondary-hdmi",
			false,
			0,
		],
	] as const) {
		test(name, async () => {
			let signalCalls = 0;
			let audioCalls = 0;
			const saved = getConfig().asrc;
			getConfig().asrc = "HDMI";
			try {
				const result = await startStream(
					pipeline as Pipeline,
					"192.0.2.10",
					5000,
					"sid",
					{
						hdmiVideoSignal: async () => {
							signalCalls++;
							return verdict;
						},
						probe: async () => {
							audioCalls++;
							throw new AudioProbeTimeoutError("HDMI");
						},
					},
					"test",
					{ selected_video_input: selected },
				);
				expect(result.reason).toBe(AUDIO_SOURCE_PROBE_FAILED);
				expect(signalCalls).toBe(expectedCalls);
				expect(audioCalls).toBe(1);
			} finally {
				getConfig().asrc = saved;
			}
		});
	}
});
