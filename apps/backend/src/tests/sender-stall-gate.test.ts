/*
  The fast stall gate is a per-box setting, off by default. Off must start the
  sender with exactly the argv CeraUI always used; on appends the two sender
  flags. Driven through the real `startStream`, with only the spawn captured.
*/

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import { runtimeConfigSchema } from "../helpers/config-schemas.ts";
import { getConfig } from "../modules/config.ts";
import { setup } from "../modules/setup.ts";
import type { Pipeline } from "../modules/streaming/pipelines.ts";
import { setPreviewEncodeReplayTransport } from "../modules/streaming/preview-encode-replay.ts";
import {
	isFastStallGateEnabled,
	setFastStallGate,
} from "../modules/streaming/sender-stall-gate.ts";
import { acceptStartAudio } from "../modules/streaming/start-audio.ts";
import type { StreamingProcess } from "../modules/streaming/streamloop/process-runner.ts";
import {
	setStartStreamDepsForTest,
	startStream,
} from "../modules/streaming/streamloop/start-stream.ts";

const STALL_FLAGS = [
	"--stall-min-in-flight",
	"4",
	"--stall-ack-stale-ms",
	"250",
];

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

describe("startStream sender argv", () => {
	let tempDir = "";
	let savedIps: string | undefined;
	let savedConfig: RuntimeConfig;
	let spawnedArgs: string[] | undefined;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "stall-gate-"));
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
		spawnedArgs = undefined;
		setPreviewEncodeReplayTransport(async () => {});
		setStartStreamDepsForTest({
			getStreamingBackend: () => ({
				setBitrate: () => undefined,
				start: async () => {},
			}),
			spawnStreamingLoop: (_command, args) => {
				spawnedArgs = [...args];
				return fakeSender;
			},
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
	});

	async function launchArgs(): Promise<string[]> {
		expect(
			await startStream(
				pipeline,
				"192.0.2.10",
				5000,
				"stall-gate",
				{},
				"att",
				undefined,
				acceptStartAudio(),
			),
		).toEqual({ success: true });
		if (!spawnedArgs) throw new Error("sender was not spawned");
		return spawnedArgs;
	}

	test("absent and false start the sender with the same argv and no stall flag", async () => {
		delete getConfig().srtla_fast_stall_gate;
		const absent = await launchArgs();
		getConfig().srtla_fast_stall_gate = false;
		const off = await launchArgs();
		expect(off).toEqual(absent);
		expect(absent.some((arg) => arg.startsWith("--stall-"))).toBe(false);
	});

	test("on appends exactly the two sender flags to the same argv", async () => {
		delete getConfig().srtla_fast_stall_gate;
		const off = await launchArgs();
		getConfig().srtla_fast_stall_gate = true;
		const on = await launchArgs();
		const at = on.indexOf("--stall-min-in-flight");
		expect(at).toBeGreaterThan(3);
		expect(on.slice(at, at + 4)).toEqual(STALL_FLAGS);
		expect([...on.slice(0, at), ...on.slice(at + 4)]).toEqual(off);
	});
});

describe("setFastStallGate", () => {
	function fakeDeps(initial: Partial<RuntimeConfig> = {}) {
		const config = { ...initial } as RuntimeConfig;
		const saved: RuntimeConfig[] = [];
		const broadcasts: RuntimeConfig[] = [];
		return {
			config,
			saved,
			broadcasts,
			deps: {
				getConfig: () => config,
				saveConfig: () => {
					saved.push({ ...config });
				},
				broadcast: (c: RuntimeConfig) => {
					broadcasts.push({ ...c });
				},
			},
		};
	}

	test("on persists true and announces the config", () => {
		const f = fakeDeps();
		expect(setFastStallGate(true, f.deps)).toBe(true);
		expect(f.config.srtla_fast_stall_gate).toBe(true);
		expect(f.saved).toEqual([{ srtla_fast_stall_gate: true } as RuntimeConfig]);
		expect(f.broadcasts).toHaveLength(1);
		expect(isFastStallGateEnabled(f.config)).toBe(true);
	});

	test("off removes the key, so the saved config matches a box that never set it", () => {
		const f = fakeDeps({ srtla_fast_stall_gate: true });
		expect(setFastStallGate(false, f.deps)).toBe(false);
		expect("srtla_fast_stall_gate" in f.config).toBe(false);
		expect(f.saved).toEqual([{} as RuntimeConfig]);
		expect(isFastStallGateEnabled(f.config)).toBe(false);
	});

	test("a failed save restores the previous value and announces nothing", () => {
		const f = fakeDeps();
		const deps = {
			...f.deps,
			saveConfig: () => {
				throw new Error("disk full");
			},
		};
		expect(() => setFastStallGate(true, deps)).toThrow("disk full");
		expect("srtla_fast_stall_gate" in f.config).toBe(false);
		expect(f.broadcasts).toHaveLength(0);
	});

	test("the config schema keeps the key optional and boolean", () => {
		expect(runtimeConfigSchema.safeParse({}).success).toBe(true);
		expect(
			runtimeConfigSchema.safeParse({ srtla_fast_stall_gate: true }).success,
		).toBe(true);
		expect(
			runtimeConfigSchema.safeParse({ srtla_fast_stall_gate: "yes" }).success,
		).toBe(false);
	});
});
