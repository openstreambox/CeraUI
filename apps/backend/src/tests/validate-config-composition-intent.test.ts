import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";

import { clearCapabilitiesCache } from "../modules/streaming/capabilities.ts";
import { initPipelines } from "../modules/streaming/pipelines.ts";
import { validateConfig } from "../modules/streaming/streaming.ts";

// Boot autostart validates the live config object itself. A saved composition
// the cached engine does not advertise must survive validation there, so the
// start can still see it was configured and tell the operator it went without.

const CAPS: GetCapabilitiesResult = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "2160p",
	},
	encoder: {
		codecs: ["h264"],
		bitrate_range: { min: 500, max: 50000, unit: "kbps" },
	},
	sources: [
		{
			id: "hdmi",
			supports_audio: true,
			supports_resolution_override: true,
			supports_framerate_override: true,
			default_resolution: "1080p",
			default_framerate: 30,
		},
	],
	features: [],
};

beforeAll(async () => {
	clearCapabilitiesCache();
	await initPipelines({
		fetchEngineCapabilities: async () => ({
			caps: CAPS,
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	});
});

afterAll(() => clearCapabilitiesCache());

test("validation leaves the caller's saved composition alone on an engine without composition", async () => {
	const composition = {
		secondary_input_id: "cam2",
		layout: "pip-bottom-right" as const,
	};
	const params: Record<string, unknown> = {
		delay: 0,
		pipeline: "hdmi",
		max_br: 6000,
		srt_latency: 2000,
		composition,
	};

	await validateConfig(params).catch(() => {});

	expect(params.composition).toEqual(composition);
});
