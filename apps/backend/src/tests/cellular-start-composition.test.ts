import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../modules/config.ts";
import { setup } from "../modules/setup.ts";
import { setPreviewEncodeReplayTransport } from "../modules/streaming/preview-encode-replay.ts";
import {
	genSrtlaBondEntries,
	publishSrtlaBond,
	resetPublishedBond,
} from "../modules/streaming/srtla.ts";
import { acceptStartAudio } from "../modules/streaming/start-audio.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import {
	setStartStreamDepsForTest,
	startStream,
} from "../modules/streaming/streamloop/start-stream.ts";
import {
	ETHERNET,
	journalEntry,
	MODEMS,
	realisticBox,
	USB_ETHERNET,
	USB_WIFI,
} from "./fixtures/realistic-box.ts";
import { evidenceHarness } from "./helpers/stream-engine-evidence.ts";

test("Start reaches the engine with healthy USB uplinks beside a failed modem, while an in-flight change still refuses", async () => {
	const box = await realisticBox();
	const directory = await mkdtemp(join(tmpdir(), "cellular-start-"));
	const saved = {
		ips: setup.ips_file,
		map: setup.bind_map_file,
		preview: getConfig().previewEncode,
		marker: process.env.CERALIVE_STREAMING_MARKER,
	};
	const engine = evidenceHarness();
	const children: ReturnType<typeof Bun.spawn>[] = [];
	setup.ips_file = join(directory, "ips");
	setup.bind_map_file = undefined;
	process.env.CERALIVE_STREAMING_MARKER = join(directory, "streaming");
	getConfig().previewEncode = undefined;
	setPreviewEncodeReplayTransport(async () => undefined);
	setStartStreamDepsForTest({
		getStreamingBackend: () => engine.backend,
		recordSenderIntent: async () => null,
		spawnStreamingLoop: (_command, _args) => {
			const proc = Bun.spawn(["/usr/bin/true"], {
				stdout: "ignore",
				stderr: "pipe",
			});
			children.push(proc);
			return { proc, spawnfile: "srtla_send", exitListeners: [] };
		},
		startLinkTelemetry: () => undefined,
		stopLinkTelemetry: () => undefined,
		stopProcessAndWait: async (sender) => {
			await sender.proc.exited;
		},
	});
	const session = createStreamSessionOrchestrator({
		...streamSessionProductionDeps,
		createAttemptId: () => "cellular-start",
		setStreamingStatus: () => undefined,
		getStreamingStatus: () => false,
		setLifecycleState: () => undefined,
		queryRuntime: async () => "idle",
		stopRuntime: () => engine.backend.confirmStop(),
		awaitRecovery: async () => undefined,
		recoveryPending: () => false,
		admitUpdate: async () => ({ allowed: true }),
		onStreamCommitted: () => undefined,
		onStreamArmed: () => undefined,
		onStreamStopped: () => undefined,
	});
	const launch = () =>
		session.start({
			origin: "ui",
			launch: async () => {
				await publishSrtlaBond(genSrtlaBondEntries());
				const result = await startStream(
					{
						source: "hdmi",
						name: "Synthetic",
						hardware: "generic",
						description: "Synthetic",
						supportsAudio: false,
						supportsResolutionOverride: false,
						supportsFramerateOverride: false,
						audio_kind: "none",
					},
					"192.0.2.2",
					5000,
					"test",
					{},
					"cellular-start",
					{
						pipeline: "hdmi",
						max_br: 8000,
						balancer: "adaptive",
						srt_latency: 2000,
					},
					acceptStartAudio(),
				);
				if (!result.success) throw new Error(result.error);
			},
		});
	try {
		await box.scan([ETHERNET, ...MODEMS, USB_ETHERNET, USB_WIFI]);
		await box.journal([journalEntry(MODEMS[0], "executing")]);
		expect(await launch()).toMatchObject({
			result: "failed",
			failure: { class: "mutation_blocked" },
		});
		expect(children).toHaveLength(0);
		await box.journal([journalEntry(MODEMS[0], "failed")]);
		expect(await launch()).toMatchObject({ result: "started" });
		expect(children).toHaveLength(1);
		expect(engine.clients.flatMap((client) => client.calls)).toContain("start");
		expect(
			(await Bun.file(setup.ips_file).text()).trim().split("\n").sort(),
		).toEqual(
			[
				ETHERNET.ip,
				MODEMS[1].ip,
				MODEMS[2].ip,
				USB_ETHERNET.ip,
				USB_WIFI.ip,
			].sort(),
		);
	} finally {
		await session.stop("operator");
		await Promise.all(children.map((child) => child.exited));
		engine.dispose();
		box.close();
		resetPublishedBond();
		setup.ips_file = saved.ips;
		setup.bind_map_file = saved.map;
		getConfig().previewEncode = saved.preview;
		if (saved.marker === undefined)
			delete process.env.CERALIVE_STREAMING_MARKER;
		else process.env.CERALIVE_STREAMING_MARKER = saved.marker;
		setPreviewEncodeReplayTransport(null);
		setStartStreamDepsForTest(null);
		await rm(directory, { recursive: true, force: true });
	}
});
