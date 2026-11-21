import { afterEach, beforeEach, expect, test } from "bun:test";
import type {
	CerastreamClient,
	GetCapabilitiesResult,
} from "@ceralive/cerastream";
import {
	COMPOSITION_FEATURE,
	COMPOSITION_GEOMETRY_FEATURE,
} from "@ceraui/rpc/schemas";

import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import { setMockAudioDevicesProvider } from "../modules/streaming/audio.ts";
import {
	clearCapabilitiesCache,
	getCapabilities,
	invalidateCapabilities,
} from "../modules/streaming/capabilities.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
} from "../modules/streaming/cerastream-backend.ts";

// The start request carries feature-gated fields (an audio mix, a custom
// composition rectangle) that only some engines accept. They must be checked
// against the engine that receives the request, not against a snapshot read
// from an earlier engine connection.

const MIX = {
	max_inputs: 4,
	max_tracks: 4,
	gain_db_min: -60,
	gain_db_max: 12,
	delay_ms_max: 2000,
};

function engineCaps(opts: {
	mix: boolean;
	features: string[];
}): GetCapabilitiesResult {
	return {
		platform: {
			supports_h265: true,
			hardware_accelerated: true,
			max_resolution: "1080p",
		},
		encoder: {
			codecs: ["h264"],
			bitrate_range: { min: 500, max: 20000, unit: "kbps" },
		},
		sources: [
			{
				id: "test",
				supports_audio: true,
				supports_resolution_override: true,
				supports_framerate_override: true,
				default_resolution: "1080p",
				default_framerate: 30,
			},
		],
		features: opts.features,
		...(opts.mix ? { audio_mix: MIX } : {}),
	};
}

const GEOMETRY_ENGINE = engineCaps({
	mix: true,
	features: [COMPOSITION_FEATURE, COMPOSITION_GEOMETRY_FEATURE],
});
const OLDER_ENGINE = engineCaps({
	mix: false,
	features: [COMPOSITION_FEATURE],
});

interface Recorded {
	starts: Array<Record<string, unknown>>;
	capabilityReads: number;
}

function fakeClient(caps: GetCapabilitiesResult, recorded: Recorded) {
	const started = (params: unknown) => {
		recorded.starts.push(structuredClone(params) as Record<string, unknown>);
		return { session_id: "s1", state: "streaming" as const };
	};
	return {
		hello: {
			protocol: "cerastream-ipc/1",
			schema_version: "0.21.0",
			engine_version: "test",
		},
		start: async (params: unknown) => started(params),
		rawRequest: async (method: string, params: unknown) =>
			method === "start" ? started(params) : {},
		getCapabilities: async () => {
			recorded.capabilityReads++;
			return structuredClone(caps);
		},
		stop: async () => ({ state: "idle" as const }),
		listDevices: async () => ({ devices: [] }),
		subscribeEvents: async () => ({
			result: { subscribed: [] as never[] },
			close: () => {},
		}),
		close: async () => {},
	} as unknown as CerastreamClient;
}

const warnings: string[] = [];
const logger: CerastreamBackendDeps["logger"] = {
	debug() {},
	info() {},
	warn(message) {
		warnings.push(message);
	},
	error() {},
};

function backendFor(config: RuntimeConfig, caps: GetCapabilitiesResult) {
	const recorded: Recorded = { starts: [], capabilityReads: 0 };
	const backend = new CerastreamBackend({
		connect: async () => fakeClient(caps, recorded),
		connectOptions: {},
		getConfig: () => config,
		saveConfig: () => {},
		bridge: {
			notify: () => {},
			notificationExists: () => false,
			removeNotification: () => {},
			broadcastStatus: () => {},
			broadcastBuffering: () => {},
		},
		execPath: "cerastream",
		configPath: "/tmp/start-feature-authorization.json",
		logger,
		getActiveInput: () => undefined,
		isEmbeddedAudioActive: () => false,
	});
	return { backend, recorded };
}

async function snapshotFrom(caps: GetCapabilitiesResult) {
	await getCapabilities({
		fetchEngineCapabilities: async () => ({
			caps,
			schemaVersion: "0.24.0",
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
		logger: { debug() {}, info() {}, warn() {}, error() {} },
	});
}

const START = { pipeline: "test", host: "127.0.0.1", port: 9000 };

const mixConfig = (): RuntimeConfig => ({
	pipeline: "test",
	asrc: "Primary",
	max_br: 6000,
	srt_latency: 2000,
	audio_inputs: [
		{ id: "Primary", tracks: [1], gain_db: 0, mute: false, delay_ms: 0 },
		{ id: "Second", tracks: [2], gain_db: 0, mute: false, delay_ms: 0 },
	],
});

const customLayoutConfig = (): RuntimeConfig => ({
	pipeline: "test",
	max_br: 6000,
	srt_latency: 2000,
	composition: {
		secondary_input_id: "cam2",
		layout: "custom",
		rect: { x: 0.6, y: 0.6, width: 0.3, height: 0.3 },
	},
});

beforeEach(() => {
	clearCapabilitiesCache();
	warnings.length = 0;
	setMockAudioDevicesProvider(() => ({
		Primary: "hw:CARD=primary",
		Second: "hw:CARD=second",
	}));
});

afterEach(() => {
	setMockAudioDevicesProvider(undefined);
	clearCapabilitiesCache();
});

test("a mix saved on a mix-capable engine is not sent to a replacement engine without one", async () => {
	await snapshotFrom(GEOMETRY_ENGINE);
	invalidateCapabilities();
	const { backend, recorded } = backendFor(mixConfig(), OLDER_ENGINE);

	await backend.start(mixConfig(), START);

	const audio = recorded.starts[0]?.audio as { inputs?: unknown } | undefined;
	expect(audio?.inputs).toBeUndefined();
	expect(backend.getAudioMixInputs()).toBeUndefined();
	expect(warnings.some((w) => w.includes("audio mix"))).toBe(true);
});

test("a mix goes out when the receiving engine advertises it", async () => {
	await snapshotFrom(GEOMETRY_ENGINE);
	invalidateCapabilities();
	const { backend, recorded } = backendFor(mixConfig(), GEOMETRY_ENGINE);

	await backend.start(mixConfig(), START);

	const audio = recorded.starts[0]?.audio as { inputs?: unknown[] } | undefined;
	expect(audio?.inputs).toHaveLength(2);
});

test("a custom layout is not sent to an engine that only advertises preset composition", async () => {
	await snapshotFrom(GEOMETRY_ENGINE);
	const { backend, recorded } = backendFor(customLayoutConfig(), OLDER_ENGINE);

	await backend.start(customLayoutConfig(), START);

	expect(recorded.starts[0]).not.toHaveProperty("composition");
	expect(warnings.some((w) => w.includes("custom composition"))).toBe(true);
});

test("a preset layout still goes to an engine that only advertises preset composition", async () => {
	await snapshotFrom(GEOMETRY_ENGINE);
	const config: RuntimeConfig = {
		...customLayoutConfig(),
		composition: { secondary_input_id: "cam2", layout: "pip-bottom-right" },
	};
	const { backend, recorded } = backendFor(config, OLDER_ENGINE);

	await backend.start(config, START);

	expect(recorded.starts[0]).toHaveProperty("composition", {
		secondary_input_id: "cam2",
		layout: "pip-bottom-right",
	});
});

test("a start without gated fields does not read capabilities first", async () => {
	await snapshotFrom(GEOMETRY_ENGINE);
	const config: RuntimeConfig = {
		pipeline: "test",
		max_br: 6000,
		srt_latency: 2000,
	};
	const { backend, recorded } = backendFor(config, OLDER_ENGINE);

	await backend.start(config, START);

	expect(recorded.starts).toHaveLength(1);
	expect(recorded.capabilityReads).toBe(0);
});
