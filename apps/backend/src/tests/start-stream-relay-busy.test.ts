/*
  A busy relay session after a quick restart (reason 1000) gets the bounded
  busy retry only when the very same destination and stream ID succeeded
  recently, and only after the rollback left the device idle. Driven through
  the real `startStream` with the field's own engine message.
*/

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import { getConfig } from "../modules/config.ts";
import { setup } from "../modules/setup.ts";
import type { Pipeline } from "../modules/streaming/pipelines.ts";
import { setPreviewEncodeReplayTransport } from "../modules/streaming/preview-encode-replay.ts";
import { StreamStartFailure } from "../modules/streaming/start-failure-taxonomy.ts";
import type { StreamingProcess } from "../modules/streaming/streamloop/process-runner.ts";
import {
	setStartStreamDepsForTest,
	startStream,
} from "../modules/streaming/streamloop/start-stream.ts";

const FIELD_MESSAGE =
	"internal engine error: transport connect: SRT connect failed (reason 1000)";

const fakeSender = {
	proc: { exited: new Promise<number>(() => {}) },
	spawnfile: "srtla_send",
	exitListeners: [],
} as unknown as StreamingProcess;

const pipeline = {
	source: "hdmi",
	name: "Test HDMI",
	hardware: "rk3588",
	description: "test pipeline",
	supportsAudio: false,
	supportsResolutionOverride: false,
	supportsFramerateOverride: false,
	audio_kind: "none",
} as Pipeline;

let engine: () => Promise<void> = async () => {};
let tempDir = "";
let savedIps: string | undefined;
let savedConfig: RuntimeConfig;

beforeAll(() => {
	tempDir = mkdtempSync(join(tmpdir(), "relay-busy-"));
	const ips = join(tempDir, "ips");
	writeFileSync(ips, "192.0.2.20\n");
	savedIps = setup.ips_file;
	setup.ips_file = ips;
});

afterAll(() => {
	setup.ips_file = savedIps;
	rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
	savedConfig = { ...getConfig() };
	getConfig().asrc = "No audio";
	setPreviewEncodeReplayTransport(async () => {});
	setStartStreamDepsForTest({
		getStreamingBackend: () => ({
			setBitrate: () => undefined,
			start: () => engine(),
		}),
		spawnStreamingLoop: () => fakeSender,
		startLinkTelemetry: () => {},
		stopLinkTelemetry: () => {},
		stopProcessAndWait: async () => {},
	});
});

afterEach(() => {
	const config = getConfig();
	for (const key of Object.keys(config))
		delete (config as Record<string, unknown>)[key];
	Object.assign(config, savedConfig);
	setPreviewEncodeReplayTransport(null);
	setStartStreamDepsForTest(null);
	engine = async () => {};
});

const rejectWith = (liveness: "idle" | "unknown") => async () => {
	throw new StreamStartFailure(
		{
			attemptId: "att",
			phase: "start-rpc",
			class: "engine_internal",
			code: -32603,
			message: FIELD_MESSAGE,
			retriable: false,
		},
		liveness,
	);
};

async function failure(streamid: string, port = 5000) {
	try {
		await startStream(pipeline, "192.0.2.10", port, streamid, {}, "att");
	} catch (error) {
		if (error instanceof StreamStartFailure) return error;
		throw error;
	}
	throw new Error("start unexpectedly succeeded");
}

async function succeed(streamid: string) {
	engine = async () => {};
	expect(
		await startStream(pipeline, "192.0.2.10", 5000, streamid, {}, "att"),
	).toEqual({ success: true });
}

test("a quick restart to the same session that just worked is a busy relay", async () => {
	await succeed("busy-same");
	engine = rejectWith("idle");
	const error = await failure("busy-same");
	expect(error.failure.code).toBe("relay_session_busy");
	expect(error.failure.retriable).toBe(true);
	expect(error.liveness).toBe("idle");
	expect(error.failure.message).toBe(FIELD_MESSAGE);
});

test("a first start is never reclassified: a success must mark the session valid", async () => {
	engine = rejectWith("idle");
	const error = await failure("busy-never-started");
	expect(error.failure.code).toBe(-32603);
	expect(error.failure.retriable).toBe(false);
});

test("unknown liveness after rollback is never reclassified", async () => {
	await succeed("busy-unknown");
	engine = rejectWith("unknown");
	const error = await failure("busy-unknown");
	expect(error.failure.code).toBe(-32603);
	expect(error.liveness).toBe("unknown");
});

test("another stream ID or port is a different session", async () => {
	await succeed("busy-key");
	engine = rejectWith("idle");
	expect((await failure("busy-key-other")).failure.code).toBe(-32603);
	expect((await failure("busy-key", 5001)).failure.code).toBe(-32603);
});
