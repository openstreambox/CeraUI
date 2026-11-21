/*
 * startStream with and without `srtla_send_unit`: the child path stays the
 * default and untouched; unit mode hands the same argument vector, with the
 * private paths, to the unit host and follows its restarts.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import { getConfig } from "../modules/config.ts";
import { setup } from "../modules/setup.ts";
import * as health from "../modules/streaming/health.ts";
import type { Pipeline } from "../modules/streaming/pipelines.ts";
import { setPreviewEncodeReplayTransport } from "../modules/streaming/preview-encode-replay.ts";
import type { StreamingProcess } from "../modules/streaming/streamloop/process-runner.ts";
import { registerSupervisedSender } from "../modules/streaming/streamloop/process-runner.ts";
import {
	resetSenderHostModeForTest,
	resolveSenderHostMode,
	SENDER_UNIT_EXEC,
	SenderUnitError,
	type SenderUnitHooks,
	type SenderUnitProcess,
} from "../modules/streaming/streamloop/sender-unit.ts";
import {
	SENDER_UNIT_START_FAILED,
	setStartStreamDepsForTest,
	startStream,
} from "../modules/streaming/streamloop/start-stream.ts";
import { FakeSenderUnit } from "./helpers/fake-sender-unit.ts";

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

const sender = {
	proc: { pid: 4242, exited: new Promise<number>(() => {}) },
	spawnfile: "srtla_send",
	exitListeners: [],
} as unknown as StreamingProcess;

let root = "";
let dir = "";
let saved: { ips: string | undefined; bindMap: string | undefined };
let savedConfig: RuntimeConfig;
let spawned: string[][];
let unitStarts: Array<{ args: readonly string[]; hooks: SenderUnitHooks }>;
let telemetry: Array<{ stats: string; control: string | undefined }>;
let unitStart: (
	args: readonly string[],
	hooks: SenderUnitHooks,
) => Promise<StreamingProcess>;
let engineStarts = 0;

beforeEach(() => {
	resetSenderHostModeForTest();
	root = mkdtempSync(join(tmpdir(), "start-sender-unit-"));
	dir = join(root, "srtla-send");
	mkdirSync(dir, { mode: 0o700 });
	chmodSync(dir, 0o700);
	saved = { ips: setup.ips_file, bindMap: setup.bind_map_file };
	setup.ips_file = join(root, "shared-ips");
	writeFileSync(setup.ips_file, "192.0.2.20\n");
	savedConfig = { ...getConfig() };
	getConfig().asrc = "No audio";
	setPreviewEncodeReplayTransport(async () => {});
	spawned = [];
	unitStarts = [];
	telemetry = [];
	engineStarts = 0;
	unitStart = async (args, hooks) => {
		unitStarts.push({ args, hooks });
		return sender;
	};
	setStartStreamDepsForTest({
		getStreamingBackend: () => ({
			setBitrate: () => undefined,
			start: async () => {
				engineStarts++;
			},
		}),
		spawnStreamingLoop: (_command, args) => {
			spawned.push(args);
			return sender;
		},
		startSenderUnit: (args, hooks) => unitStart(args, hooks),
		startLinkTelemetry: (stats, _ips, opts) => {
			telemetry.push({ stats, control: opts?.controlSocket });
		},
		stopLinkTelemetry: () => {},
		stopProcessAndWait: async () => {},
	});
});

afterEach(() => {
	resetSenderHostModeForTest();
	setup.ips_file = saved.ips;
	setup.bind_map_file = saved.bindMap;
	setup.srtla_send_unit = undefined;
	const config = getConfig();
	for (const key of Object.keys(config))
		delete (config as Record<string, unknown>)[key];
	Object.assign(config, savedConfig);
	setPreviewEncodeReplayTransport(null);
	setStartStreamDepsForTest(null);
	rmSync(root, { recursive: true, force: true });
});

const start = () => startStream(pipeline, "192.0.2.10", 5000, "sid", {}, "att");

async function enterUnitMode(): Promise<void> {
	const fake = new FakeSenderUnit(dir);
	setup.srtla_send_unit = true;
	expect(
		await resolveSenderHostMode(
			setup as Parameters<typeof resolveSenderHostMode>[0],
			SENDER_UNIT_EXEC,
			fake.io(),
		),
	).toBe("unit");
	writeFileSync(join(dir, "ips"), "192.0.2.21\n192.0.2.22\n");
}

test("flag off: the sender is spawned as a child with the shared paths", async () => {
	expect(await start()).toEqual({ success: true });
	expect(unitStarts).toEqual([]);
	expect(spawned).toHaveLength(1);
	const args = spawned[0] as string[];
	expect(args[3]).toBe(join(root, "shared-ips"));
	expect(args[args.indexOf("--control-socket") + 1]).toStartWith("/tmp/");
	expect(engineStarts).toBe(1);
});

test("unit mode: the unit host gets the arguments, every path private", async () => {
	await enterUnitMode();
	expect(await start()).toEqual({ success: true });
	expect(spawned).toEqual([]);
	expect(unitStarts).toHaveLength(1);
	const args = unitStarts[0]?.args as string[];
	expect(args[3]).toBe(join(dir, "ips"));
	expect(args[args.indexOf("--stats-file") + 1]).toBe(join(dir, "stats.json"));
	expect(args[args.indexOf("--control-socket") + 1]).toBe(
		join(dir, "control.sock"),
	);
	expect(telemetry).toEqual([
		{ stats: join(dir, "stats.json"), control: join(dir, "control.sock") },
	]);
	expect(engineStarts).toBe(1);
});

test("unit mode: a refused unit start is a spawn-sender failure and the engine is never asked", async () => {
	await enterUnitMode();
	unitStart = async () => {
		throw new SenderUnitError(
			"update_in_progress",
			"an update holds the update lock",
		);
	};
	expect(await start()).toEqual({
		success: false,
		error: SENDER_UNIT_START_FAILED,
		reason: "update_in_progress",
		phase: "spawn-sender",
		failureClass: "start_invalid",
	});
	expect(engineStarts).toBe(0);
});

test("unit mode: systemd's restart is reported, then telemetry follows the new sender", async () => {
	await enterUnitMode();
	const reported = spyOn(health, "reportStreamProcessExit");
	const cleared = spyOn(health, "clearStreamProcessExit");
	try {
		await start();
		const hooks = unitStarts[0]?.hooks as SenderUnitHooks;
		hooks.onRestarting?.({} as never);
		expect(reported).toHaveBeenCalledTimes(1);
		const clearsBefore = cleared.mock.calls.length;
		const restarted = {
			pid: 5151,
			invocation: "inv-9",
			isReady: true,
			exitCode: null,
			signalCode: null,
			exited: new Promise<number>(() => {}),
			kill: () => {},
		} as unknown as SenderUnitProcess;
		registerSupervisedSender(restarted, "srtla_send");
		hooks.onRestarted?.(restarted);
		for (let i = 0; i < 20 && telemetry.length < 2; i++) await Bun.sleep(1);
		expect(telemetry).toHaveLength(2);
		expect(telemetry[1]?.control).toBe(join(dir, "control.sock"));
		expect(cleared.mock.calls.length).toBe(clearsBefore + 1);
	} finally {
		reported.mockRestore();
		cleared.mockRestore();
	}
});

test("flag on with an unresolved unit: no sender of either kind starts", async () => {
	const fake = new FakeSenderUnit(dir);
	fake.showFails = true;
	setup.srtla_send_unit = true;
	await resolveSenderHostMode(
		setup as Parameters<typeof resolveSenderHostMode>[0],
		SENDER_UNIT_EXEC,
		fake.io(),
	);
	const result = await start();
	expect(result).toMatchObject({ success: false, reason: "unit_unresolved" });
	expect(spawned).toEqual([]);
	expect(unitStarts).toEqual([]);
	expect(engineStarts).toBe(0);
});

test("unit mode: a restart seen after the stream ended never reopens telemetry", async () => {
	await enterUnitMode();
	const stops: number[] = [];
	setStartStreamDepsForTest({
		getStreamingBackend: () => ({
			setBitrate: () => undefined,
			start: async () => {},
		}),
		startSenderUnit: (args, hooks) => unitStart(args, hooks),
		startLinkTelemetry: (stats, _ips, opts) => {
			telemetry.push({ stats, control: opts?.controlSocket });
		},
		stopLinkTelemetry: () => {
			stops.push(1);
		},
		stopProcessAndWait: async () => {},
	});
	await start();
	const hooks = unitStarts[0]?.hooks as SenderUnitHooks;
	hooks.onRestarting?.({} as never);
	expect(stops).toHaveLength(1);
	const gone = {
		pid: 1,
		invocation: "inv-1",
		isReady: false,
	} as unknown as SenderUnitProcess;
	hooks.onRestarted?.(gone);
	await Bun.sleep(5);
	expect(telemetry).toHaveLength(1);
	// Ready, but not this stream's registered sender: ignored as well.
	const stranger = {
		pid: 2,
		invocation: "inv-2",
		isReady: true,
	} as unknown as SenderUnitProcess;
	hooks.onRestarted?.(stranger);
	await Bun.sleep(5);
	expect(telemetry).toHaveLength(1);
});
