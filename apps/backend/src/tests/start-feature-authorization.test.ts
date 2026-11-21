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
	getCurrentCapabilities,
	getLastCapabilities,
	invalidateCapabilities,
} from "../modules/streaming/capabilities.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
} from "../modules/streaming/cerastream-backend.ts";
import { resetStartFeatureNoticeForTest } from "../modules/streaming/start-feature-notice.ts";
import { START_CAPABILITY_PREFLIGHT_DEADLINE_MS } from "../modules/streaming/start-lifecycle-timing.ts";

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

/** What the receiving engine answers to `get-capabilities`. */
type CapsAnswer = GetCapabilitiesResult | "fail" | "hang";

function fakeClient(caps: CapsAnswer, recorded: Recorded) {
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
			if (caps === "fail") throw new Error("get-capabilities failed");
			if (caps === "hang") return new Promise<never>(() => {});
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

interface Notice {
	name: string;
	type: string;
	msg: string;
}

function backendFor(
	config: RuntimeConfig,
	caps: CapsAnswer,
	scheduleTimeout?: CerastreamBackendDeps["scheduleTimeout"],
) {
	const recorded: Recorded = { starts: [], capabilityReads: 0 };
	const notices: Notice[] = [];
	const backend = new CerastreamBackend({
		connect: async () => fakeClient(caps, recorded),
		connectOptions: {},
		getConfig: () => config,
		saveConfig: () => {},
		...(scheduleTimeout === undefined ? {} : { scheduleTimeout }),
		bridge: {
			notify: (name, type, msg) => {
				notices.push({ name, type, msg });
			},
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
	return { backend, recorded, notices };
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
	resetStartFeatureNoticeForTest();
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

// The mix fallback must leave the stream on the operator's selected input, not
// on the engine's default device: assembly replaces `audio.device` and forces
// `mode: "default"` when it adds mixer inputs.
test("dropping the mix keeps the selected audio input", async () => {
	await snapshotFrom(GEOMETRY_ENGINE);
	invalidateCapabilities();
	const { backend, recorded } = backendFor(mixConfig(), OLDER_ENGINE);

	await backend.start(mixConfig(), START);

	expect(recorded.starts[0]?.audio).toEqual({
		mode: "device",
		device: "hw:CARD=Primary",
	});
});

test("a dropped mix or custom layout is surfaced to the operator, not only logged", async () => {
	await snapshotFrom(GEOMETRY_ENGINE);
	const config: RuntimeConfig = {
		...mixConfig(),
		composition: customLayoutConfig().composition,
	};
	const { backend, notices } = backendFor(config, OLDER_ENGINE);

	await backend.start(config, START);

	expect(notices).toHaveLength(1);
	expect(notices[0]?.type).toBe("warning");
	expect(notices[0]?.msg).toContain("audio mix");
	expect(notices[0]?.msg).toContain("custom layout");
});

test("a fully supported start raises no operator notice", async () => {
	await snapshotFrom(GEOMETRY_ENGINE);
	const config: RuntimeConfig = {
		...mixConfig(),
		composition: customLayoutConfig().composition,
	};
	const { backend, recorded, notices } = backendFor(config, GEOMETRY_ENGINE);

	await backend.start(config, START);

	expect(recorded.starts[0]).toHaveProperty("composition");
	expect(notices).toEqual([]);
});

test("a failed capability read keeps primary audio and tells the operator", async () => {
	await snapshotFrom(GEOMETRY_ENGINE);
	const { backend, recorded, notices } = backendFor(mixConfig(), "fail");

	await backend.start(mixConfig(), START);

	expect(recorded.starts).toHaveLength(1);
	expect(recorded.starts[0]?.audio).toEqual({
		mode: "device",
		device: "hw:CARD=Primary",
	});
	expect(notices.map((n) => n.msg).join(" ")).toContain("audio mix");
});

test("an unanswered capability read is bounded below the bindings' request timeout", async () => {
	await snapshotFrom(GEOMETRY_ENGINE);
	const delays: number[] = [];
	const { backend, recorded, notices } = backendFor(
		mixConfig(),
		"hang",
		(callback, delayMs) => {
			delays.push(delayMs);
			if (delayMs === START_CAPABILITY_PREFLIGHT_DEADLINE_MS)
				queueMicrotask(callback);
			return setTimeout(() => {}, 0);
		},
	);

	await backend.start(mixConfig(), START);

	expect(START_CAPABILITY_PREFLIGHT_DEADLINE_MS).toBeLessThan(10_000);
	expect(delays).toContain(START_CAPABILITY_PREFLIGHT_DEADLINE_MS);
	expect(recorded.starts).toHaveLength(1);
	expect(recorded.starts[0]?.audio).toEqual({
		mode: "device",
		device: "hw:CARD=Primary",
	});
	expect(notices).toHaveLength(1);
});

test("the start preflight does not publish into the shared capability snapshot", async () => {
	await snapshotFrom(GEOMETRY_ENGINE);
	invalidateCapabilities();
	const { backend } = backendFor(mixConfig(), OLDER_ENGINE);

	await backend.start(mixConfig(), START);

	expect(getCurrentCapabilities()).toBeUndefined();
	expect(getLastCapabilities()?.audio_mix).toEqual(MIX);
});

// After boot or a downgrade the shared snapshot already lacks `audio_mix`, so
// assembly leaves the saved mix out before the start's own check runs. That is
// still a configured mix the stream goes without, and the operator must hear it.
test("a saved mix left out at assembly, on an engine known to lack a mixer, is surfaced too", async () => {
	await snapshotFrom(OLDER_ENGINE);
	const { backend, recorded, notices } = backendFor(mixConfig(), OLDER_ENGINE);

	await backend.start(mixConfig(), START);

	expect(recorded.starts[0]?.audio).toEqual({
		mode: "device",
		device: "hw:CARD=Primary",
	});
	expect(notices).toHaveLength(1);
	expect(notices[0]?.msg).toContain("audio mix");
	// Assembly read the shared snapshot, not the receiving engine.
	expect(notices[0]?.msg).toContain("not confirmed");
});

// A cold cache (no snapshot yet) also leaves the mix out at assembly. The
// receiving engine was never asked, so the notice must not claim it said no.
test("a mix left out on a cold capability cache is not blamed on the engine", async () => {
	const { backend, recorded, notices } = backendFor(
		mixConfig(),
		GEOMETRY_ENGINE,
	);

	await backend.start(mixConfig(), START);

	expect(recorded.capabilityReads).toBe(0);
	expect(notices).toHaveLength(1);
	expect(notices[0]?.msg).toContain("audio mix");
	expect(notices[0]?.msg).not.toContain("does not support");
	expect(notices[0]?.msg).toContain("not confirmed");
});

test("only the receiving engine's own answer is worded as unsupported", async () => {
	await snapshotFrom(GEOMETRY_ENGINE);
	invalidateCapabilities();
	const { backend, notices } = backendFor(mixConfig(), OLDER_ENGINE);

	await backend.start(mixConfig(), START);

	expect(notices[0]?.msg).toContain("does not support");
});

test("a saved composition on an engine known to lack composition is surfaced", async () => {
	const noComposition = engineCaps({ mix: false, features: [] });
	await snapshotFrom(noComposition);
	const config: RuntimeConfig = {
		...customLayoutConfig(),
		composition: { secondary_input_id: "cam2", layout: "pip-bottom-right" },
	};
	const { backend, recorded, notices } = backendFor(config, noComposition);

	await backend.start(config, START);

	expect(recorded.starts[0]).not.toHaveProperty("composition");
	expect(notices.map((n) => n.msg).join(" ")).toContain("composition");
});
