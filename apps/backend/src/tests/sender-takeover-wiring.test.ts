import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CerastreamClient,
	EventParams,
	ListSwitchTargetsResult,
} from "@ceralive/cerastream";
import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import type { ProcessPin } from "../helpers/process-pin.ts";
import {
	adoptedSender,
	clearAdoptedSender,
	noteAdoptedSender,
} from "../modules/streaming/adopted-sender.ts";
import type { BondEntry } from "../modules/streaming/bind-map.ts";
import { resolveBindMapArgs } from "../modules/streaming/bind-map-spawn.ts";
import {
	continueBindMapGenerationAbove,
	defaultBindMapWriterDeps,
	defaultSidecarPath,
	publishBondMapping,
	resetBindMapWriter,
} from "../modules/streaming/bind-map-writer.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
} from "../modules/streaming/cerastream-backend.ts";
import {
	ownsSessionSender,
	unownedSenderCensus,
} from "../modules/streaming/sender-ownership.ts";
// The orchestrator loads before its production deps, as at runtime.
import { getStreamSessionSnapshot } from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import * as streamingEngine from "../modules/streaming/streaming-engine.ts";
import { srtlaSendExec } from "../modules/streaming/streamloop/exec-paths.ts";
import {
	getStreamingProcesses,
	gracefulShutdown,
	registerHostedSender,
	type StreamingProcess,
	signalSenders,
	stopProcessAndWait,
} from "../modules/streaming/streamloop/process-runner.ts";
import {
	type HostedSender,
	hostedSenderHandle,
	type UnitStopOutcome,
} from "../modules/streaming/streamloop/sender-host.ts";

// How a hosted sender plugs into supervision: the runner, the census, the
// reconciliation rule, the engine's session reference, the bind-map counter
// and the launch arguments. Each is the narrow piece a takeover changes.

const UNIT = "ceralive-srtla-send-0123456789abcdef.service";

function fakePin() {
	const state = {
		alive: true as boolean | null,
		closed: false,
		signals: [] as (NodeJS.Signals | number)[],
	};
	const pin: ProcessPin = {
		pidfd: true,
		alive: () => (state.closed ? null : state.alive),
		signal: (signal) => {
			if (state.closed) return null;
			state.signals.push(signal);
			return state.alive;
		},
		close: () => {
			state.closed = true;
		},
	};
	return { pin, state };
}

const fixtures: ReturnType<typeof hosted>[] = [];
function hosted(
	pid: number,
	start = "555",
	stopUnit: () => Promise<UnitStopOutcome> = async () => "stopped",
) {
	const p = fakePin();
	const timers: (() => void)[] = [];
	const sender = hostedSenderHandle(pid, start, UNIT, p.pin, {
		stopUnit,
		schedule: (callback) => {
			timers.push(callback);
			return timers.length;
		},
		cancel: () => undefined,
	});
	const fixture = { sender, pinState: p.state, poll: () => timers.shift()?.() };
	fixtures.push(fixture);
	return fixture;
}

const registered: StreamingProcess[] = [];
function register(sender: HostedSender): StreamingProcess {
	const handle = registerHostedSender(sender, srtlaSendExec, () => {}, null);
	registered.push(handle);
	return handle;
}

afterEach(async () => {
	clearAdoptedSender();
	// Every fake sender exits, so its handle leaves the supervised list.
	for (const fixture of fixtures.splice(0)) {
		fixture.pinState.alive = false;
		fixture.poll();
	}
	await Bun.sleep(0);
	for (const handle of registered.splice(0))
		expect(getStreamingProcesses()).not.toContain(handle);
});

describe("runner", () => {
	test("a hosted sender is supervised like a spawned one and leaves on exit", async () => {
		const h = hosted(100_001);
		const handle = register(h.sender);
		expect(getStreamingProcesses()).toContain(handle);
		h.pinState.alive = false;
		h.poll();
		await h.sender.exited;
		await Bun.sleep(0);
		expect(getStreamingProcesses()).not.toContain(handle);
	});

	test("a reload counts a hosted sender only when its pidfd confirms delivery", () => {
		const h = hosted(100_002);
		const handle = register(h.sender);
		expect(signalSenders("SIGHUP", [handle])).toBe(1);
		h.pinState.alive = null;
		expect(signalSenders("SIGHUP", [handle])).toBe(0);
		h.pinState.alive = false;
		expect(signalSenders("SIGHUP", [handle])).toBe(0);
		expect(h.sender.exitCode).toBe(-1);
		expect(h.pinState.signals).toEqual(["SIGHUP", "SIGHUP", "SIGHUP"]);
	});

	test("graceful shutdown leaves a hosted sender running and sends it nothing", async () => {
		const h = hosted(100_003);
		const handle = register(h.sender);
		await gracefulShutdown(1, getStreamingProcesses());
		expect(h.pinState.signals).toEqual([]);
		expect(getStreamingProcesses()).not.toContain(handle);
		expect(h.sender.exitCode).toBeNull();
		// Watching ended: the pidfd is released, the process is not ours to stop.
		expect(h.pinState.closed).toBe(true);
	});

	test("Stop signals a hosted sender through its pidfd", async () => {
		const h = hosted(100_004);
		const handle = register(h.sender);
		const stopping = stopProcessAndWait(handle);
		expect(h.pinState.signals).toEqual(["SIGTERM"]);
		h.pinState.alive = false;
		h.poll();
		await stopping;
		expect(getStreamingProcesses()).not.toContain(handle);
	});
});

describe("bounded stop of a hosted sender", () => {
	test("a pidfd that never confirms the exit ends in a unit stop, then a failed Stop, never a hang", async () => {
		let unitStops = 0;
		const h = hosted(100_005, "555", async () => {
			unitStops++;
			return "timed_out";
		});
		const handle = register(h.sender);
		h.pinState.alive = null;
		const error = await stopProcessAndWait(handle, 5)
			.then(() => null)
			.catch((e: unknown) => e);
		expect((error as Error | null)?.message).toBe(
			"hosted_sender_stop_unconfirmed",
		);
		expect(unitStops).toBe(1);
		// TERM and KILL through the pidfd; unknown never became "exited".
		expect(h.pinState.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(h.sender.exitCode).toBeNull();
	});

	test("a unit stop that systemd confirms and the pidfd then shows ends the Stop", async () => {
		let pin: { alive: boolean | null } | undefined;
		const h = hosted(100_006, "555", async () => {
			if (pin) pin.alive = false;
			return "stopped";
		});
		pin = h.pinState;
		const handle = register(h.sender);
		h.pinState.alive = null;
		await stopProcessAndWait(handle, 5);
		expect(h.sender.exitCode).toBe(-1);
		await Bun.sleep(0);
		expect(getStreamingProcesses()).not.toContain(handle);
	});
});

describe("census", () => {
	let procRoot = "";
	let previous: string | undefined;
	beforeEach(() => {
		previous = process.env.CERALIVE_SENDER_CENSUS_PROC_ROOT;
		procRoot = mkdtempSync(join(tmpdir(), "hosted-census-"));
		process.env.CERALIVE_SENDER_CENSUS_PROC_ROOT = procRoot;
	});
	afterEach(() => {
		process.env.CERALIVE_SENDER_CENSUS_PROC_ROOT = previous;
		rmSync(procRoot, { recursive: true, force: true });
	});

	function row(pid: number, start: string, parent = 1) {
		const rest = ["S", String(parent), String(pid), String(pid)];
		while (rest.length < 19) rest.push("0");
		rest.push(start, "0");
		mkdirSync(join(procRoot, String(pid)));
		writeFileSync(join(procRoot, `${pid}/comm`), "srtla_send\n");
		writeFileSync(
			join(procRoot, `${pid}/stat`),
			`${pid} (srtla_send) ${rest.join(" ")}\n`,
		);
	}

	test("a hosted sender counts as ours by start time and a live pidfd, not by parent", () => {
		const h = hosted(100_010, "555");
		const handle = register(h.sender);
		row(100_010, "555", 1);
		expect(unownedSenderCensus([handle], procRoot)).toBe("absent");
	});

	test("the same PID with another start time is someone else's sender", () => {
		const h = hosted(100_011, "555");
		const handle = register(h.sender);
		row(100_011, "556", 1);
		expect(unownedSenderCensus([handle], procRoot)).toBe("present");
	});

	test("a pidfd that cannot confirm the process keeps the census conservative", () => {
		const h = hosted(100_012, "555");
		const handle = register(h.sender);
		row(100_012, "555", 1);
		h.pinState.alive = null;
		expect(unownedSenderCensus([handle], procRoot)).toBe("present");
	});
});

describe("reconciliation rule", () => {
	test("the production orchestrator starts with no generation", () => {
		expect(getStreamSessionSnapshot().generation).toBe(0);
	});

	test("an adopted sender replaces the launch attempt, and nothing else", () => {
		let owns = true;
		const spy = spyOn(
			streamingEngine,
			"getStreamingBackend",
		).mockImplementation(
			() =>
				({
					ownsLaunchedSession: () => owns,
				}) as unknown as ReturnType<typeof streamingEngine.getStreamingBackend>,
		);
		try {
			const can = streamSessionProductionDeps.canReconcileStreaming;
			if (!can) throw new Error("production rule missing");
			// No attempt, no adoption: refused, as before.
			expect(can(undefined)).toBe(false);
			const h = hosted(100_020);
			const handle = register(h.sender);
			noteAdoptedSender(handle);
			expect(adoptedSender()).toBe(handle);
			expect(can(undefined)).toBe(true);
			// The engine session must still be held on the adopted connection.
			owns = false;
			expect(can(undefined)).toBe(false);
			owns = true;
			// A pidfd that cannot confirm the process right now: not ours, at
			// once, and the same answer the census gives.
			h.pinState.alive = null;
			expect(adoptedSender()).toBeUndefined();
			expect(ownsSessionSender([handle])).toBe(false);
			expect(can(undefined)).toBe(false);
			h.pinState.alive = true;
			expect(can(undefined)).toBe(true);
			// The adopted sender exits: the exception goes with it, even
			// before the exit poll runs.
			h.pinState.alive = false;
			expect(can(undefined)).toBe(false);
			h.pinState.alive = false;
			h.poll();
			expect(adoptedSender()).toBeUndefined();
			expect(can(undefined)).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("engine session adoption", () => {
	const silentLogger: CerastreamBackendDeps["logger"] = {
		debug() {},
		info() {},
		warn() {},
		error() {},
	};
	const config: RuntimeConfig = {
		max_br: 8000,
		srt_latency: 2000,
		balancer: "adaptive",
		pipeline: "h264_hdmi_1080p",
	};

	function harness() {
		const listeners: ((event: EventParams) => void)[] = [];
		const backend = new CerastreamBackend({
			connect: async () =>
				({
					hello: {
						protocol: "cerastream-ipc/1",
						schema_version: "0.9.0",
						engine_version: "test",
					},
					listSwitchTargets: async (): Promise<ListSwitchTargetsResult> => ({
						session_id: "s9",
						switch_targets: [],
					}),
					subscribeEvents: async (
						_params: unknown,
						listener: (event: EventParams) => void,
					) => {
						listeners.push(listener);
						return {
							result: { subscribed: ["status"] },
							close: () => undefined,
						};
					},
					close: async () => undefined,
					rawRequest: async () => ({}),
				}) as unknown as CerastreamClient,
			connectOptions: {},
			getConfig: () => config,
			saveConfig: () => undefined,
			bridge: {
				notify: () => undefined,
				notificationExists: () => false,
				removeNotification: () => {},
				broadcastStatus: () => undefined,
				broadcastBuffering: () => undefined,
			},
			execPath: "cerastream",
			configPath: "/tmp/cerastream-takeover-wiring.json",
			logger: silentLogger,
		});
		const emit = (state: "streaming" | "idle") =>
			listeners.at(-1)?.({
				type: "status",
				seq: 1,
				state,
				streaming: state === "streaming",
			} as EventParams);
		return { backend, emit, listeners };
	}

	async function reconciledStreaming() {
		const h = harness();
		const probe = h.backend.reconcileRuntimeState();
		for (let i = 0; i < 50 && h.listeners.length === 0; i++) await Bun.sleep(1);
		h.emit("streaming");
		expect(await probe).toBe("streaming");
		return h;
	}

	test("a reconciled session is not ours until it is adopted on the connection that answered", async () => {
		const h = await reconciledStreaming();
		expect(h.backend.ownsLaunchedSession()).toBe(false);
		const evidence = await h.backend.sessionEvidence();
		expect(evidence).toMatchObject({ state: "streaming", sessionId: "s9" });
		const connection = evidence.connection as number;
		expect(typeof connection).toBe("number");
		// Another connection's token, or no id: refused.
		expect(h.backend.adoptLaunchedSession("s9", connection + 1)).toBe(false);
		expect(h.backend.adoptLaunchedSession("", connection)).toBe(false);
		expect(h.backend.ownsLaunchedSession()).toBe(false);
		expect(h.backend.adoptLaunchedSession("s9", connection)).toBe(true);
		expect(h.backend.ownsLaunchedSession()).toBe(true);
		expect(h.backend.launchedSession()).toBe("s9");
		// Only once.
		expect(h.backend.adoptLaunchedSession("s9", connection)).toBe(false);
	});

	test("a rolled-back adoption releases the engine session; an own launch is never released", async () => {
		const h = await reconciledStreaming();
		const { connection } = await h.backend.sessionEvidence();
		expect(h.backend.adoptLaunchedSession("s9", connection as number)).toBe(
			true,
		);
		h.backend.releaseAdoptedSession("other");
		expect(h.backend.ownsLaunchedSession()).toBe(true);
		h.backend.releaseAdoptedSession("s9");
		expect(h.backend.ownsLaunchedSession()).toBe(false);
		expect(h.backend.launchedSession()).toBeNull();
	});

	test("an idle status drops an adopted session exactly like an own launch", async () => {
		const h = await reconciledStreaming();
		const { connection } = await h.backend.sessionEvidence();
		expect(h.backend.adoptLaunchedSession("s9", connection as number)).toBe(
			true,
		);
		h.emit("idle");
		expect(h.backend.ownsLaunchedSession()).toBe(false);
		expect(h.backend.launchedSession()).toBeNull();
	});

	test("a connection whose last status is idle cannot be adopted", async () => {
		const h = await reconciledStreaming();
		const { connection } = await h.backend.sessionEvidence();
		h.emit("idle");
		expect(h.backend.adoptLaunchedSession("s9", connection as number)).toBe(
			false,
		);
	});
});

describe("bind map", () => {
	beforeEach(() => resetBindMapWriter());

	test("publications continue above the generation the adopted sender applied", async () => {
		const dir = mkdtempSync(join(tmpdir(), "takeover-bindmap-"));
		const ips = join(dir, "srtla_ips");
		const deps = defaultBindMapWriterDeps(ips, defaultSidecarPath(ips));
		const entries: BondEntry[] = [
			{ ip: "10.0.0.1", iface: "eth0", linkId: "lnk_a" },
		];
		continueBindMapGenerationAbove(7);
		const first = await publishBondMapping(entries, deps);
		expect(first.ok && first.generation).toBe(8);
		// The same bond again is a new publication, never a reuse of 7.
		expect(first.changed).toBe(true);
		// Never backwards.
		continueBindMapGenerationAbove(3);
		const second = await publishBondMapping(
			[{ ip: "10.0.0.1", iface: "eth1", linkId: "lnk_a" }],
			deps,
		);
		expect(second.ok && second.generation).toBe(9);
		rmSync(dir, { recursive: true, force: true });
	});

	test("required binding is asked for only by a flagged launch and only when advertised", async () => {
		const bond = {
			entries: [{ ip: "10.0.0.1", iface: "eth0", linkId: "lnk_a" }],
			publication: {
				ok: true as const,
				generation: 1,
				changed: true,
				sidecarPath: "/tmp/ips.bindmap.json",
				ipsFileSha256: "a".repeat(64),
			},
		};
		const deps = (required: boolean, contract: number) => ({
			getBond: () => bond,
			probe: async () => ({
				bindMap: true as const,
				bindMapSchemaVersion: 1,
				...(required ? { bindMapRequired: true as const } : {}),
				bindMapContract: contract,
			}),
			announce: () => undefined,
		});
		const flag = { requireWhenAdvertised: true };
		expect(await resolveBindMapArgs("/x", deps(true, 2))).toEqual([
			"--bind-map",
			"/tmp/ips.bindmap.json",
		]);
		expect(await resolveBindMapArgs("/x", deps(true, 2), flag)).toEqual([
			"--bind-map",
			"/tmp/ips.bindmap.json",
			"--require-bind-map",
		]);
		expect(await resolveBindMapArgs("/x", deps(false, 2), flag)).toEqual([
			"--bind-map",
			"/tmp/ips.bindmap.json",
		]);
		expect(await resolveBindMapArgs("/x", deps(true, 1), flag)).toEqual([
			"--bind-map",
			"/tmp/ips.bindmap.json",
		]);
	});
});
