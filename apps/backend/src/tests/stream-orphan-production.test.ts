/**
 * An earlier backend process's engine session after a backend restart,
 * through the production session deps, the real engine backend and a fake
 * engine. The shipped default never stops it: the operator's Stop clears it.
 * The automatic stop (behind CERALIVE_SETTLE_ORPHANED_SESSIONS) and the
 * binding's compare-and-stop are pinned here, including the review probes.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CerastreamClient } from "@ceralive/cerastream";
import type { ArmedStreamMarkerDeps } from "../modules/streaming/armed-stream-marker.ts";
import { CerastreamBackend } from "../modules/streaming/cerastream-backend.ts";
import {
	bindStreamLiveness,
	streamLiveness,
} from "../modules/streaming/stream-liveness.ts";
import {
	readStreamProvenance,
	type StreamProvenance,
	setProvenanceProbesForTest,
	writeStreamProvenance,
} from "../modules/streaming/stream-provenance.ts";
import {
	awaitRestorationAdmission,
	runStreamRestoration,
} from "../modules/streaming/stream-restoration.ts";
import {
	recordCommittedStreamSession,
	streamSessionProductionDeps,
} from "../modules/streaming/stream-session-production.ts";
import * as registry from "../modules/streaming/streaming-engine.ts";
import {
	spawnStreamingLoop,
	stopProcessAndWait,
} from "../modules/streaming/streamloop/process-runner.ts";
import { flushEvidence } from "./helpers/stream-engine-evidence.ts";
import { idleProductionHarness } from "./helpers/stream-idle-production.ts";

const RECORD: StreamProvenance = {
	version: 2,
	bootId: "boot-1",
	sessionId: "cs-3",
	engine: { pid: 700, startTime: "1000" },
	sender: { pid: 4242, startTime: "3960195" },
	port: 9000,
};
const UDP_HEADER =
	"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops\n";
const PORT_ROW =
	"  231: 00000000000000000000000000000000:2328 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 2868780 2 00000000253f623a 0\n";

let directory = "";
let marker = "";
let previousMarker: string | undefined;
let previousFlag: string | undefined;
let h: ReturnType<typeof idleProductionHarness> | undefined;
const proc = () => process.env.CERALIVE_SENDER_CENSUS_PROC_ROOT ?? "";

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "orphan-production-"));
	marker = join(directory, "streaming");
	previousMarker = process.env.CERALIVE_STREAMING_MARKER;
	process.env.CERALIVE_STREAMING_MARKER = marker;
	previousFlag = process.env.CERALIVE_SETTLE_ORPHANED_SESSIONS;
	delete process.env.CERALIVE_SETTLE_ORPHANED_SESSIONS;
	setProvenanceProbesForTest({
		bootId: () => "boot-1",
		engineProcess: async () => RECORD.engine,
	});
	// The census reads the test's private process table: empty port tables
	// here and in the engine's namespace.
	for (const root of [proc(), join(proc(), "700")]) {
		mkdirSync(join(root, "net"), { recursive: true });
		writeFileSync(join(root, "net", "udp"), UDP_HEADER);
		writeFileSync(join(root, "net", "udp6"), UDP_HEADER);
	}
	// The recorded engine process still runs (start time 1000).
	writeFileSync(
		join(proc(), "700", "stat"),
		`700 (cerastream) S 1 ${Array(17).fill("0").join(" ")} 1000 0\n`,
	);
});
afterEach(async () => {
	await h?.dispose();
	h = undefined;
	bindStreamLiveness(() => "unknown");
	setProvenanceProbesForTest(null);
	rmSync(join(proc(), "net"), { recursive: true, force: true });
	rmSync(join(proc(), "700"), { recursive: true, force: true });
	if (previousMarker === undefined)
		delete process.env.CERALIVE_STREAMING_MARKER;
	else process.env.CERALIVE_STREAMING_MARKER = previousMarker;
	if (previousFlag === undefined)
		delete process.env.CERALIVE_SETTLE_ORPHANED_SESSIONS;
	else process.env.CERALIVE_SETTLE_ORPHANED_SESSIONS = previousFlag;
	await rm(directory, { recursive: true, force: true });
});

/** The previous backend died mid-stream: its marker and record stay. */
function bootAfterKilledStream(
	engineSession = "cs-3",
	ports: Parameters<typeof idleProductionHarness>[1] = {},
) {
	writeFileSync(marker, "");
	writeStreamProvenance(RECORD);
	const harness = idleProductionHarness(directory, ports);
	h = harness;
	bindStreamLiveness(harness.session.streamLiveness);
	harness.engine.setEngine("streaming");
	harness.engine.answerSnapshots(engineSession);
	return harness;
}
async function reconcileStreaming(harness: NonNullable<typeof h>) {
	const probe = harness.session.reconcile();
	await flushEvidence();
	harness.engine.status(0, true);
	return await probe;
}
const stops = (harness: NonNullable<typeof h>) =>
	harness.calls().filter((call) => call === "stop").length;

test("by default a leftover session is never stopped; one operator Stop clears it and Start works", async () => {
	const harness = bootAfterKilledStream();
	expect(await reconcileStreaming(harness)).toBe("reconciling");
	expect(stops(harness)).toBe(0);
	expect(harness.engine.view().engine).toBe("streaming");
	expect(streamLiveness()).toBe("unknown");
	expect(await harness.start()).toMatchObject({ result: "busy" });
	expect(existsSync(marker)).toBe(true);

	expect(await harness.session.stop("operator")).toEqual({ result: "stopped" });
	expect(stops(harness)).toBe(1);
	expect(harness.engine.view().engine).toBe("idle");
	expect(streamLiveness()).toBe("idle");
	expect(existsSync(marker)).toBe(false);
	expect(await harness.start()).toMatchObject({ result: "started" });
});

test("after the engine restarted, a recorded marker waits for the operator by default and settles only when enabled", async () => {
	for (const enabled of [false, true]) {
		if (enabled) process.env.CERALIVE_SETTLE_ORPHANED_SESSIONS = "1";
		writeFileSync(marker, "");
		writeStreamProvenance(RECORD);
		const harness = idleProductionHarness(directory);
		h = harness;
		bindStreamLiveness(harness.session.streamLiveness);
		harness.engine.answerSnapshots();
		const probe = harness.session.reconcile();
		await harness.expireProbe();
		expect(await probe).toBe(enabled ? "idle" : "reconciling");
		expect(stops(harness)).toBe(0);
		expect(existsSync(marker)).toBe(!enabled);
		if (!enabled) {
			// The shipped default: the operator's Stop, acknowledged, clears it.
			const stopping = harness.session.stop("operator");
			await harness.expireProbe();
			expect(await stopping).toEqual({ result: "stopped" });
			expect(stops(harness)).toBe(1);
			expect(existsSync(marker)).toBe(false);
		}
		expect(await harness.start()).toMatchObject({ result: "started" });
		await harness.dispose();
		h = undefined;
		rmSync(marker, { force: true });
	}
});

test("with the stop enabled, the recorded session is stopped through the snapshot compare", async () => {
	process.env.CERALIVE_SETTLE_ORPHANED_SESSIONS = "1";
	const harness = bootAfterKilledStream();
	expect(await reconcileStreaming(harness)).toBe("idle");
	expect(harness.calls()).toContain("list-switch-targets");
	expect(stops(harness)).toBe(1);
	expect(existsSync(marker)).toBe(false);
	expect(await harness.start()).toMatchObject({ result: "started" });
});

test("with the stop enabled, another session id, a held port or no record still stop nothing", async () => {
	process.env.CERALIVE_SETTLE_ORPHANED_SESSIONS = "1";
	const other = bootAfterKilledStream("cs-4");
	expect(await reconcileStreaming(other)).toBe("reconciling");
	expect(stops(other)).toBe(0);
	await other.dispose();

	writeFileSync(join(proc(), "700", "net", "udp6"), UDP_HEADER + PORT_ROW);
	const held = bootAfterKilledStream();
	expect(await reconcileStreaming(held)).toBe("reconciling");
	expect(stops(held)).toBe(0);
	await held.dispose();
	writeFileSync(join(proc(), "700", "net", "udp6"), UDP_HEADER);

	rmSync(process.env.CERALIVE_STREAM_PROVENANCE ?? "", { force: true });
	writeFileSync(marker, "");
	const direct = idleProductionHarness(directory);
	h = direct;
	direct.engine.setEngine("streaming");
	direct.engine.answerSnapshots("cs-3");
	expect(await reconcileStreaming(direct)).toBe("reconciling");
	expect(stops(direct)).toBe(0);
});

test("with the stop enabled, restoration relaunches once the recorded session is stopped", async () => {
	process.env.CERALIVE_SETTLE_ORPHANED_SESSIONS = "1";
	const harness = bootAfterKilledStream();
	const armed = join(directory, "armed.json");
	const bootId = "11111111-1111-4111-8111-111111111111";
	writeFileSync(
		armed,
		JSON.stringify({ armedAt: 1, bootId, config: { pipeline: "hdmi" } }),
	);
	const markerDeps: ArmedStreamMarkerDeps = {
		markerPath: armed,
		readBootId: () => bootId,
		readMarker: (path) => readFileSync(path, "utf8"),
		writeMarker: (path, text) => writeFileSync(path, text),
		removeMarker: (path) => rmSync(path, { force: true }),
	};
	let now = 0;
	const outcome = await runStreamRestoration({
		marker: markerDeps,
		awaitRecovery: async () => true,
		runtimeState: async () => {
			const state = await reconcileStreaming(harness);
			return state === "idle" || state === "streaming" ? state : "unknown";
		},
		lifecycleState: () => harness.session.snapshot().state,
		launch: async () =>
			(await harness.start()).result === "started"
				? { ok: true }
				: { ok: false, reason: "start_failed" },
		publish: () => undefined,
		now: () => now,
		wait: async () => {
			now += 100;
		},
		unknownDeadlineMs: 100,
	});
	expect(outcome).toMatchObject({ result: "recovered" });
	expect(stops(harness)).toBe(1);
});

test("restoration waits for update adjudication and does not run when it is refused", async () => {
	const order: string[] = [];
	const updates = Promise.withResolvers<boolean>();
	const waiting = awaitRestorationAdmission(
		async () => {
			order.push("modems");
		},
		async () => {
			order.push("updates asked");
			return await updates.promise;
		},
	);
	await flushEvidence();
	expect(order).toEqual(["modems", "updates asked"]);
	updates.resolve(false);
	expect(await waiting).toBe(false);

	let launches = 0;
	const outcome = await runStreamRestoration({
		marker: {
			markerPath: "unused",
			readBootId: () => "b",
			readMarker: () => JSON.stringify({ armedAt: 1, bootId: "b", config: {} }),
			writeMarker: () => undefined,
			removeMarker: () => undefined,
		},
		awaitRecovery: async () => false,
		runtimeState: async () => "idle",
		lifecycleState: () => "idle",
		launch: async () => {
			launches++;
			return { ok: true };
		},
		publish: () => undefined,
	});
	expect(outcome).toEqual({
		result: "blocked",
		reason: "update_adjudication_refused",
	});
	expect(launches).toBe(0);
});

test("the committed session is recorded by the production hook and cleared on confirmed idle", async () => {
	// A stand-in sender whose name ends like the real one.
	const sender = join(directory, "srtla_send");
	symlinkSync("/usr/bin/sleep", sender);
	const child = spawnStreamingLoop(
		{ command: sender, role: "srtla_send" },
		["30"],
		() => undefined,
	);
	const backend = spyOn(registry, "getStreamingBackend").mockReturnValue({
		launchedSessionId: () => "cs-7",
	} as unknown as ReturnType<typeof registry.getStreamingBackend>);
	setProvenanceProbesForTest({
		bootId: () => "boot-1",
		engineProcess: async () => RECORD.engine,
		processStartTime: (pid) => (pid === child.proc.pid ? "4100000" : undefined),
	});
	try {
		expect(await recordCommittedStreamSession(() => true)).toBe(true);
		expect(readStreamProvenance()).toEqual({
			...RECORD,
			sessionId: "cs-7",
			sender: { pid: child.proc.pid, startTime: "4100000" },
		});
		rmSync(process.env.CERALIVE_STREAM_PROVENANCE ?? "", { force: true });

		// The commit hook itself writes it.
		streamSessionProductionDeps.onStreamCommitted?.(() => true);
		for (
			let turn = 0;
			turn < 50 && readStreamProvenance() === undefined;
			turn++
		)
			await Bun.sleep(5);
		expect(readStreamProvenance()?.sessionId).toBe("cs-7");

		// Confirmed idle removes it; other lifecycle states keep it.
		streamSessionProductionDeps.setLifecycleState?.("streaming");
		expect(readStreamProvenance()?.sessionId).toBe("cs-7");
		streamSessionProductionDeps.setLifecycleState?.("idle");
		expect(readStreamProvenance()).toBeUndefined();
	} finally {
		backend.mockRestore();
		await stopProcessAndWait(child);
	}
});

/** The binding's compare-and-stop against a hand-held fake client. */
function binding(
	snapshot: () => Promise<unknown> = async () => ({
		session_id: "cs-1",
		active_input: "a",
		switch_targets: [],
	}),
) {
	const calls: string[] = [];
	const timers: Array<() => void> = [];
	const gate = Promise.withResolvers<void>();
	let gated = false;
	let stopReply: { state: string } = { state: "idle" };
	const client = {
		hello: {
			protocol: "cerastream-ipc/1",
			schema_version: "0.1.0",
			engine_version: "fake",
		},
		listSwitchTargets: async () => {
			calls.push("snapshot");
			return await snapshot();
		},
		stop: async () => {
			calls.push("stop");
			return stopReply;
		},
		close: async () => {
			calls.push("close");
		},
	} as unknown as CerastreamClient;
	const backend = new CerastreamBackend({
		connect: async () => {
			calls.push("connect");
			if (gated) await gate.promise;
			return client;
		},
		connectOptions: {},
		getConfig: () => ({}),
		saveConfig: () => undefined,
		logger: {
			debug: () => undefined,
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
		},
		bridge: {
			notify: () => undefined,
			notificationExists: () => false,
			removeNotification: () => undefined,
			broadcastStatus: () => undefined,
			broadcastBuffering: () => undefined,
		},
		onEngineStatus: () => undefined,
		scheduleTimeout: (callback: () => void) => {
			timers.push(callback);
			return timers.length as unknown as ReturnType<typeof setTimeout>;
		},
		cancelTimeout: () => undefined,
	} as unknown as ConstructorParameters<typeof CerastreamBackend>[0]);
	return {
		backend,
		calls,
		timers,
		gate,
		holdConnect: () => {
			gated = true;
		},
		replyToStop: (reply: { state: string }) => {
			stopReply = reply;
		},
	};
}

test("binding: a refused final check sends no stop and closes the connection", async () => {
	const b = binding();
	expect(await b.backend.stopRecordedSession("cs-1", () => false)).toBe(false);
	expect(b.calls).toEqual(["connect", "snapshot", "close"]);
	const engineMoved = binding();
	expect(
		await engineMoved.backend.stopRecordedSession(
			"cs-1",
			() => true,
			async () => false,
		),
	).toBe(false);
	expect(engineMoved.calls).not.toContain("stop");
});

test("binding: another session in the snapshot sends no stop", async () => {
	const b = binding(async () => ({ session_id: "cs-2", switch_targets: [] }));
	expect(await b.backend.stopRecordedSession("cs-1", () => true)).toBe(false);
	expect(b.calls).not.toContain("stop");
});

/** Review probe: a carrier that arrives while the connection opens. */
test("binding: a carrier arriving during connection setup refuses the stop", async () => {
	const b = binding();
	b.holdConnect();
	let carrier = false;
	const stopping = b.backend.stopRecordedSession("cs-1", () => !carrier);
	await flushEvidence();
	carrier = true;
	b.gate.resolve();
	expect(await stopping).toBe(false);
	expect(b.calls).not.toContain("stop");
});

/** Review probe: a connection that opens after the deadline. */
test("binding: a connection that opens after the deadline sends nothing and is closed", async () => {
	const b = binding();
	b.holdConnect();
	const stopping = b.backend.stopRecordedSession("cs-1", () => true);
	await flushEvidence();
	for (const fire of b.timers) fire();
	await expect(stopping).rejects.toThrow("stop_timeout");
	b.gate.resolve();
	await flushEvidence();
	await Bun.sleep(5);
	expect(b.calls).not.toContain("stop");
	expect(b.calls).toContain("close");
});

test("binding: a stop the engine does not answer with idle is not a stop", async () => {
	const b = binding();
	b.replyToStop({ state: "streaming" });
	await expect(
		b.backend.stopRecordedSession("cs-1", () => true),
	).rejects.toThrow("stop_not_idle");
});

/** Review probe: an invalid snapshot is not an empty one. */
test("binding: only a valid snapshot naming no session reports no session", async () => {
	expect(
		await binding(async () => ({
			switch_targets: [],
		})).backend.engineReportsNoSession(),
	).toBe(true);
	for (const answer of [
		async () => ({ session_id: "cs-1", switch_targets: [] }),
		async () => ({ active_input: "a", switch_targets: [] }),
		async () => ({ switch_targets: [{ input_id: "a", kind: "synthetic" }] }),
		async () => {
			throw Object.assign(new Error("invalid snapshot"), { name: "ZodError" });
		},
		async () => {
			throw new Error("connection lost");
		},
	]) {
		expect(await binding(answer).backend.engineReportsNoSession()).toBe(false);
	}
});
