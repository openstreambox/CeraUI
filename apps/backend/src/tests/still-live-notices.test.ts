import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { CerastreamClient, EventHandler } from "@ceralive/cerastream";
import {
	type ActiveEncode,
	type AudioLevelMessage,
	type SourcesMessage,
	streamSourceSchema,
} from "@ceraui/rpc/schemas";
import * as configModule from "../modules/config.ts";
import * as activeModule from "../modules/streaming/active-encode-status.ts";
import {
	initAudioMeterBridge,
	settleAudioMeterBridge,
	stopAudioMeterBridge,
} from "../modules/streaming/audio-meter-bridge.ts";
import {
	broadcastHealthIfChanged,
	resetHealthBroadcastState,
	setLivenessSourcesForTest,
} from "../modules/streaming/health.ts";
import * as sourcesModule from "../modules/streaming/sources.ts";
import {
	noteLiveAudioLevel,
	noteLiveFrameHealth,
	resetStillLiveNotices,
} from "../modules/streaming/still-live-notices.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { getPersistentNotifications } from "../modules/ui/notifications.ts";

let now = 0;
let active: ActiveEncode;
let config: ReturnType<typeof configModule.getConfig>;
let sources: SourcesMessage;
const restores: Array<() => void> = [];
function save(mock: { mockRestore(): void }) {
	restores.push(() => mock.mockRestore());
}
const level: AudioLevelMessage = {
	source: { owner: "streaming", identity: "mic" },
	channels: 1,
	peak_db: [-100],
	rms_db: [-100],
};
const notices = () =>
	getPersistentNotifications(true).show.filter((n) =>
		n.name.startsWith("still-live-"),
	);
function audio(ms = 12000) {
	for (let t = 0; t <= ms; t += 200) {
		noteLiveAudioLevel(level);
		now += 200;
	}
}
function frame(stopped = true, alive: boolean | null = true) {
	noteLiveFrameHealth(true, alive, stopped);
}
function stall() {
	frame();
	now += 5500;
	frame();
}

beforeEach(() => {
	now = 0;
	config = { ...configModule.getConfig(), source: "camera", asrc: "mic" };
	active = {
		codec: "h264",
		resolution: "1920x1080",
		framerate: 30,
		active_input: "camera",
	};
	sources = {
		hardware: "generic",
		sources: [
			{
				id: "camera",
				origin: "capture",
				kind: "hdmi",
				displayName: "Camera",
				available: true,
				devicePath: "/dev/video-test",
				pipelineId: "hdmi",
				modes: [],
				supportsAudio: false,
				supportsResolutionOverride: true,
				supportsFramerateOverride: true,
				audioKind: "none",
			},
		],
	};
	save(spyOn(performance, "now").mockImplementation(() => now));
	save(spyOn(configModule, "getConfig").mockImplementation(() => config));
	save(
		spyOn(activeModule, "getActiveEncodeStatus").mockImplementation(
			() => active,
		),
	);
	save(
		spyOn(sourcesModule, "getSourcesMessage").mockImplementation(() => sources),
	);
	updateStatus(true);
	resetStillLiveNotices();
});
afterEach(() => {
	stopAudioMeterBridge();
	updateStatus(false);
	resetStillLiveNotices();
	setLivenessSourcesForTest(null);
	resetHealthBroadcastState();
	for (const restore of restores.splice(0).reverse()) restore();
});

test("real context honors No audio without hiding camera loss", () => {
	config.asrc = "No audio";
	stall();
	audio();
	expect(notices().map((n) => n.key)).toEqual(["notifications.stillLiveHdmi"]);
});
for (const kind of ["virtual", "standby", "standby-input"])
	test(`${kind} context suppresses both notices`, () => {
		if (kind === "virtual")
			sources.sources = [
				streamSourceSchema.parse({
					...sources.sources[0],
					origin: "virtual",
					labelKey: "sources.test",
				}),
			];
		else if (kind === "standby-input") active.active_input = "standby";
		else
			active.capture = {
				state: "standby",
				live_inputs: [],
				degraded_inputs: [],
				failover_rate_policy: "retime",
			};
		stall();
		audio();
		expect(notices()).toEqual([]);
	});
for (const alive of [false, null])
	test(`an unproven process (${alive}) cannot claim still live`, () => {
		frame(true, alive);
		now += 5500;
		frame(true, alive);
		audio();
		expect(notices()).toEqual([]);
	});
for (const [origin, kind, expected] of [
	["capture", "usb", "Camera"],
	["capture", "hdmi", "Hdmi"],
	["network", undefined, "Network"],
] as const)
	test(`${origin}/${kind} selects its own connection guidance`, () => {
		if (origin === "network")
			sources.sources = [
				streamSourceSchema.parse({
					...sources.sources[0],
					origin,
					labelKey: "sources.rtmp",
					requiresGateway: "rtmp",
					url: null,
				}),
			];
		else
			sources.sources = [
				streamSourceSchema.parse({ ...sources.sources[0], origin, kind }),
			];
		stall();
		expect(notices().map((n) => n.key)).toEqual([
			`notifications.stillLive${expected}`,
		]);
	});

test("capture aliases retain HDMI guidance after re-identification", () => {
	sources.sources = [
		streamSourceSchema.parse({
			...sources.sources[0],
			id: "successor",
			previousIds: ["camera"],
		}),
	];
	stall();
	expect(notices()[0]?.key).toBe("notifications.stillLiveHdmi");
});

test("stream stop retracts both notices immediately, without another heartbeat", () => {
	stall();
	audio();
	expect(notices()).toHaveLength(2);
	updateStatus(false);
	expect(notices()).toEqual([]);
});

test("health hook treats unknown frames as unknown and samples unchanged verdicts", () => {
	let advancing: boolean | null = null;
	setLivenessSourcesForTest(() => ({
		isStreaming: true,
		processAlive: true,
		framesAdvancing: advancing,
		frameCount: null,
		reconnecting: null,
		reconnectCount: 0,
		linkCount: 1,
		activeLinks: 1,
	}));
	broadcastHealthIfChanged();
	now += 5500;
	broadcastHealthIfChanged();
	expect(notices()).toEqual([]);
	advancing = false;
	now += 5000;
	broadcastHealthIfChanged();
	expect(notices()).toEqual([]);
	now += 5500;
	broadcastHealthIfChanged();
	expect(notices().map((n) => n.key)).toEqual(["notifications.stillLiveHdmi"]);
});

test("the default always-on bridge feeds silence detection with no preview or WS client", async () => {
	let handler: EventHandler | undefined;
	const client = {
		hello: { schema_version: "0.9.0" },
		subscribeEvents: async (_params: unknown, h: EventHandler) => {
			handler = h;
			return { result: { topics: ["audio-level"] }, close() {} };
		},
		close: async () => {},
		rawRequest: async () => ({}),
	} as unknown as CerastreamClient;
	// Preserve the production broadcast callback: overriding it would miss the hook.
	initAudioMeterBridge({
		connect: async () => client,
		meterPreference: () => null,
		meterSilenced: () => false,
		meterEmbedded: () => false,
		meterPreferencePresent: () => true,
		launchInFlight: () => false,
		cardAliases: () => new Map(),
	});
	await settleAudioMeterBridge();
	frame(false);
	expect(handler).toBeDefined();
	for (let i = 0; i <= 60; i++) {
		handler?.({ type: "audio-level", seq: i, ...level });
		now += 200;
	}
	expect(notices().map((n) => n.key)).toEqual([
		"notifications.stillLiveSilence",
	]);
});
