import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SenderStats } from "@ceraui/srtla-send/control";
import { adoptTestProcess } from "../../../../scripts/test-safety.ts";
import type { ArmedStreamMarker } from "../modules/streaming/armed-stream-marker.ts";
import {
	continueBindMapGenerationAbove,
	currentBindMapGeneration,
	resetBindMapWriter,
} from "../modules/streaming/bind-map-writer.ts";
import { digest } from "../modules/streaming/continuity-observer.ts";
import type {
	Lifetime,
	Publication,
} from "../modules/streaming/continuity-records.ts";
import * as engineRuntimeState from "../modules/streaming/engine-runtime-state.ts";
import {
	type AdoptedProcessIo,
	adoptedSender,
	attemptSenderAdoption,
	collectSenderAdoptionEvidence,
	createAdoptedProcess,
	defaultSenderAdoptionEffects,
	readSenderProcessFacts,
	resetSenderAdoptionForTest,
	type SenderAdoptionEffects,
	type SenderAdoptionEvidence,
	type SenderAdoptionIo,
	senderAdoptionVerdict,
} from "../modules/streaming/sender-adoption.ts";
import {
	ownsSessionSender,
	unownedSenderCensus,
} from "../modules/streaming/sender-ownership.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import { srtlaSendExec } from "../modules/streaming/streamloop/exec-paths.ts";
import {
	getStreamingProcesses,
	type StreamingProcess,
	signalSenders,
	stopProcessAndWait,
} from "../modules/streaming/streamloop/process-runner.ts";

const BOOT = "boot-a";
const PID = 4242;
const START = "987654";
const ARGS = digest(JSON.stringify(["/usr/bin/srtla_send", "9000"]));
const CGROUP = "/system.slice/ceralive-sender-1.service";
const CONFIG = { srt_latency: 2000, max_br: 6000, pipeline: "p1" };

function lifetime(over: Partial<Lifetime> = {}): Lifetime {
	return {
		version: 1,
		bootId: BOOT,
		lifetime: "7d3c4f0e-2a59-4c3f-9a4f-2b6c1b8f0a11",
		pid: PID,
		startTime: START,
		host: "systemd",
		invocation: "0123456789abcdef0123456789abcdef",
		cgroup: CGROUP,
		argsDigest: ARGS,
		statsFile: "/tmp/srtla-send-stats-9000.json",
		controlSocket: "/tmp/srtla-send-control-9000.sock",
		ipsFile: "/run/ceralive/ips",
		sidecarFile: "/run/ceralive/ips.bindmap.json",
		required: false,
		contract: 0,
		capabilitiesDigest: null,
		createdAt: 1,
		...over,
	};
}

const LINKS = [
	{ linkId: "modem-a", iface: "wwan0", ip: "10.0.0.2" },
	{ linkId: "eth", iface: "eth0", ip: "192.168.1.5" },
];

function publication(over: Partial<Publication> = {}): Publication {
	return {
		version: 1,
		bootId: BOOT,
		generation: 7,
		sha256: "a".repeat(64),
		links: LINKS,
		...over,
	};
}

function stats(bytes: number, over: Partial<SenderStats> = {}): SenderStats {
	const link = (conn_id: number, link_id: string, iface: string) => ({
		conn_id,
		link_id,
		iface,
		connected: true,
		timed_out: false,
		window: 20,
		in_flight: 2,
		rtt_ms: 80,
		nak_count: 0,
		bitrate_bytes_per_sec: 250_000,
		base_score: 6,
		quality_multiplier: 1,
	});
	return {
		mode: "classic",
		session_bytes_sent: bytes,
		links: [link(0, "modem-a", "wwan0"), link(1, "eth", "eth0")],
		disposition: { state: "mapped" },
		...over,
	};
}

function marker(over: Partial<ArmedStreamMarker> = {}): ArmedStreamMarker {
	return { armedAt: 1, bootId: BOOT, config: { ...CONFIG }, ...over };
}

function evidence(
	over: Partial<SenderAdoptionEvidence> = {},
): SenderAdoptionEvidence {
	return {
		bootId: BOOT,
		lifetime: lifetime(),
		process: {
			pid: PID,
			comm: "srtla_send",
			state: "S",
			processGroup: PID,
			startTime: START,
			argsDigest: ARGS,
			cgroup: CGROUP,
			cgroupMembers: [PID],
			groupMembers: [PID],
		},
		marker: marker(),
		currentConfig: { ...CONFIG },
		publication: publication(),
		disk: publication(),
		reads: [stats(1_000), stats(400_000)],
		engine: "streaming",
		...over,
	};
}

const facts = evidence().process;
if (!facts) throw new Error("fixture");

describe("senderAdoptionVerdict", () => {
	test("adopts only when every fact agrees", () => {
		expect(senderAdoptionVerdict(evidence())).toEqual({ decision: "adopt" });
	});

	test("configuration equality ignores key order and absent keys", () => {
		expect(
			senderAdoptionVerdict(
				evidence({
					currentConfig: {
						pipeline: "p1",
						max_br: 6000,
						srt_latency: 2000,
						asrc: undefined,
					},
				}),
			),
		).toEqual({ decision: "adopt" });
	});

	const timedOut = (s: SenderStats): SenderStats => ({
		...s,
		links: s.links.map((link) => ({ ...link, timed_out: true })),
	});
	const disconnected = (s: SenderStats): SenderStats => ({
		...s,
		links: s.links.map((link) => ({ ...link, connected: false })),
	});
	const refusals: Array<
		[string, Partial<SenderAdoptionEvidence>, string, string]
	> = [
		["unreadable boot id", { bootId: "" }, "boot", "boot_id_unreadable"],
		[
			"no lifetime record",
			{ lifetime: null },
			"lifetime",
			"missing_or_invalid",
		],
		[
			"a record from another boot",
			{ lifetime: lifetime({ bootId: "boot-b" }) },
			"lifetime",
			"previous_boot",
		],
		[
			"a sender that never started",
			{ lifetime: lifetime({ pid: null, startTime: null }) },
			"lifetime",
			"never_started",
		],
		["no process at the PID", { process: null }, "process", "sender_absent"],
		[
			"the PID reused by another process",
			{ process: { ...facts, startTime: "111" } },
			"process",
			"pid_reused",
		],
		[
			"a process with another name",
			{ process: { ...facts, comm: "sleep" } },
			"process",
			"not_a_sender",
		],
		[
			"a zombie sender",
			{ process: { ...facts, state: "Z" } },
			"process",
			"not_running",
		],
		[
			"a stopped sender",
			{ process: { ...facts, state: "T" } },
			"process",
			"not_running",
		],
		[
			"a traced sender",
			{ process: { ...facts, state: "t" } },
			"process",
			"not_running",
		],
		[
			"changed arguments",
			{ process: { ...facts, argsDigest: digest("other") } },
			"process",
			"arguments_changed",
		],
		[
			"a backend-child host (today's production record)",
			{ lifetime: lifetime({ host: "backend-child" }) },
			"host",
			"dies_with_backend",
		],
		[
			"no unit invocation",
			{ lifetime: lifetime({ invocation: null }) },
			"host",
			"dies_with_backend",
		],
		[
			"no recorded cgroup",
			{ lifetime: lifetime({ cgroup: undefined }) },
			"host",
			"cgroup_not_recorded",
		],
		[
			"another cgroup",
			{ process: { ...facts, cgroup: "/system.slice/ceralive.service" } },
			"host",
			"cgroup_changed",
		],
		[
			"a second process in the cgroup",
			{ process: { ...facts, cgroupMembers: [PID, 5000] } },
			"host",
			"cgroup_not_exclusive",
		],
		[
			"an unreadable cgroup",
			{ process: { ...facts, cgroupMembers: null } },
			"host",
			"cgroup_not_exclusive",
		],
		[
			"not its own process group",
			{ process: { ...facts, processGroup: 1 } },
			"host",
			"not_group_leader",
		],
		[
			"a child in its process group",
			{ process: { ...facts, groupMembers: [PID, 5001] } },
			"host",
			"group_not_exclusive",
		],
		["no armed stream", { marker: null }, "config", "no_armed_stream"],
		[
			"an armed stream from another boot",
			{ marker: marker({ bootId: "boot-b" }) },
			"config",
			"previous_boot",
		],
		[
			"a configuration changed during the restart",
			{ currentConfig: { ...CONFIG, max_br: 3000 } },
			"config",
			"config_changed",
		],
		[
			"no publication record",
			{ publication: null },
			"bind_map",
			"publication_missing",
		],
		[
			"a publication from another boot",
			{ publication: publication({ bootId: "boot-b" }) },
			"bind_map",
			"previous_boot",
		],
		[
			"an unmapped sender",
			{ lifetime: lifetime({ sidecarFile: null }) },
			"bind_map",
			"sender_unmapped",
		],
		[
			"an unreadable map on disk",
			{ disk: null },
			"bind_map",
			"disk_unreadable",
		],
		[
			"a publication interrupted before the disk",
			{ disk: publication({ generation: 6 }) },
			"bind_map",
			"record_ahead_of_disk",
		],
		[
			"different IP list bytes",
			{ disk: publication({ sha256: "b".repeat(64) }) },
			"bind_map",
			"disk_mismatch",
		],
		[
			"different links on disk",
			{ disk: publication({ links: LINKS.slice(0, 1) }) },
			"bind_map",
			"disk_mismatch",
		],
		["one control read", { reads: [stats(1)] }, "sender", "two_reads_required"],
		[
			"no control answer",
			{ reads: [stats(1), null] },
			"sender",
			"control_unavailable",
		],
		[
			"the last valid map retained",
			{
				reads: [
					stats(1),
					stats(2, { disposition: { state: "retained_last_valid" } }),
				],
			},
			"sender",
			"not_mapped",
		],
		[
			"no disposition reported",
			{ reads: [stats(1, { disposition: undefined }), stats(2)] },
			"sender",
			"not_mapped",
		],
		[
			"a link missing in the sender",
			{ reads: [stats(1), { ...stats(2), links: stats(2).links.slice(0, 1) }] },
			"sender",
			"links_mismatch",
		],
		[
			"every link timed out",
			{ reads: [stats(1), timedOut(stats(2))] },
			"sender",
			"no_receiver_reply",
		],
		[
			"every link disconnected",
			{ reads: [disconnected(stats(1)), stats(2)] },
			"sender",
			"no_receiver_reply",
		],
		[
			"no byte counter",
			{ reads: [stats(1, { session_bytes_sent: undefined }), stats(2)] },
			"sender",
			"byte_counter_unavailable",
		],
		[
			"bytes not moving",
			{ reads: [stats(5), stats(5)] },
			"sender",
			"no_progress",
		],
		["the engine idle", { engine: "idle" }, "engine", "engine_idle"],
		["the engine unknown", { engine: "unknown" }, "engine", "engine_unknown"],
	];
	for (const [name, change, check, reason] of refusals)
		test(`refuses ${name}`, () => {
			expect(senderAdoptionVerdict(evidence(change))).toEqual({
				decision: "refuse",
				check,
				reason,
			});
		});
});

/** A synthetic `/proc/<pid>/stat` line; the name holds a space and a paren. */
function statLine(pid: number, state: string, group: number, start: string) {
	const rest = [state, "1", String(group), String(group)];
	while (rest.length < 19) rest.push("0");
	rest.push(start, "0");
	return `${pid} (srtla send) x) ${rest.join(" ")}\n`;
}

describe("collectSenderAdoptionEvidence", () => {
	let root = "";
	let statsReads = 0;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "sender-adoption-"));
		statsReads = 0;
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function writeProcess(
		pid: number,
		state: string,
		group: number,
		start: string,
	) {
		const dir = join(root, "proc", String(pid));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "stat"), statLine(pid, state, group, start));
		writeFileSync(join(dir, "comm"), "srtla_send\n");
		writeFileSync(join(dir, "cmdline"), "/usr/bin/srtla_send\x009000\x00");
		writeFileSync(join(dir, "cgroup"), `0::${CGROUP}\n`);
	}
	function writeCgroup(members: number[]) {
		const dir = join(root, "cgroup", CGROUP);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "cgroup.procs"),
			members.map((m) => `${m}\n`).join(""),
		);
	}
	function io(over: Partial<SenderAdoptionIo> = {}): SenderAdoptionIo {
		return {
			procRoot: join(root, "proc"),
			cgroupRoot: join(root, "cgroup"),
			bootId: async () => BOOT,
			readLifetime: async () => lifetime(),
			readPublication: async () => publication(),
			readDisk: async () => publication(),
			readMarker: () => marker(),
			captureConfig: () => ({ ...CONFIG }),
			readStats: async () => {
				statsReads++;
				return [stats(1_000), stats(9_000)];
			},
			queryEngine: async () => "streaming",
			...over,
		};
	}

	test("reads the kernel's facts and adopts a sender alone in its unit", async () => {
		writeProcess(PID, "S", PID, START);
		writeCgroup([PID]);
		const e = await collectSenderAdoptionEvidence(io());
		expect(e.process).toEqual({
			pid: PID,
			comm: "srtla_send",
			state: "S",
			processGroup: PID,
			startTime: START,
			argsDigest: ARGS,
			cgroup: CGROUP,
			cgroupMembers: [PID],
			groupMembers: [PID],
		});
		expect(senderAdoptionVerdict(e)).toEqual({ decision: "adopt" });
	});

	test("never contacts a reused PID", async () => {
		writeProcess(PID, "S", PID, "5");
		writeCgroup([PID]);
		const e = await collectSenderAdoptionEvidence(io());
		expect(statsReads).toBe(0);
		expect(senderAdoptionVerdict(e)).toMatchObject({ reason: "pid_reused" });
	});

	test("finds a second member of the sender's process group", async () => {
		writeProcess(PID, "S", PID, START);
		writeProcess(PID + 1, "S", PID, "999999");
		writeCgroup([PID]);
		const e = await collectSenderAdoptionEvidence(io());
		expect(e.process?.groupMembers?.sort()).toEqual([PID, PID + 1]);
		expect(senderAdoptionVerdict(e)).toMatchObject({
			reason: "group_not_exclusive",
		});
	});

	test("a missing process and unreadable reads refuse without throwing", async () => {
		const e = await collectSenderAdoptionEvidence(
			io({
				readPublication: async () => {
					throw new Error("torn");
				},
				queryEngine: async () => {
					throw new Error("down");
				},
			}),
		);
		expect(e.process).toBeNull();
		expect(e.publication).toBeNull();
		expect(e.engine).toBe("unknown");
		expect(senderAdoptionVerdict(e)).toMatchObject({ reason: "sender_absent" });
	});

	test("a sender gone by the time its handle is made is not registered", async () => {
		resetSenderAdoptionForTest();
		writeProcess(PID, "S", PID, START);
		writeCgroup([PID]);
		const before = getStreamingProcesses().length;
		let registered = 0;
		const verdict = await attemptSenderAdoption(io(), {
			register: (() => {
				registered++;
				return {} as StreamingProcess;
			}) as SenderAdoptionEffects["register"],
			createProcess: (pid, start) =>
				createAdoptedProcess(pid, start, {
					startTime: () => undefined,
					signal: () => {
						throw new Error("must not signal");
					},
					poll: () => () => {},
				}),
			continueGeneration: () => {
				registered++;
			},
			attachTelemetry: () => {
				registered++;
			},
		});
		expect(verdict).toEqual({
			decision: "refuse",
			check: "process",
			reason: "exited_during_adoption",
		});
		expect(registered).toBe(0);
		expect(adoptedSender()).toBeUndefined();
		expect(getStreamingProcesses().length).toBe(before);
		// The refusal did not use up the one adoption this process may make.
		expect(
			await attemptSenderAdoption(
				io({ queryEngine: async () => "idle" }),
				defaultSenderAdoptionEffects,
			),
		).toMatchObject({ reason: "engine_idle" });
	});

	test("an adoption refused changes nothing", async () => {
		resetSenderAdoptionForTest();
		const before = getStreamingProcesses().length;
		let effects = 0;
		const count = () => {
			effects++;
		};
		const verdict = await attemptSenderAdoption(
			io({ readLifetime: async () => lifetime({ host: "backend-child" }) }),
			{
				register: (() => {
					effects++;
					return {} as StreamingProcess;
				}) as SenderAdoptionEffects["register"],
				createProcess: () => {
					effects++;
					throw new Error("must not run");
				},
				continueGeneration: count,
				attachTelemetry: count,
			},
		);
		expect(verdict).toMatchObject({ decision: "refuse" });
		expect(effects).toBe(0);
		expect(adoptedSender()).toBeUndefined();
		expect(getStreamingProcesses().length).toBe(before);
	});
});

describe("createAdoptedProcess", () => {
	function fakeIo() {
		let start: string | undefined = START;
		let tick: (() => void) | undefined;
		const signals: Array<NodeJS.Signals | number> = [];
		const io: AdoptedProcessIo = {
			startTime: () => start,
			signal: (_pid, signal) => {
				signals.push(signal);
			},
			poll: (callback) => {
				tick = callback;
				return () => {
					tick = undefined;
				};
			},
		};
		return {
			io,
			signals,
			setStart: (value: string | undefined) => {
				start = value;
			},
			tick: () => tick?.(),
			polling: () => tick !== undefined,
		};
	}

	test("signals only while the PID still has the adopted start time", async () => {
		const fake = fakeIo();
		const proc = createAdoptedProcess(PID, START, fake.io);
		proc.kill("SIGHUP");
		expect(fake.signals).toEqual(["SIGHUP"]);
		expect(proc.exitCode).toBeNull();
		fake.setStart("1");
		proc.kill("SIGTERM");
		expect(fake.signals).toEqual(["SIGHUP"]);
		expect(proc.exitCode).toBe(-1);
		expect(await proc.exited).toBe(-1);
		expect(fake.polling()).toBe(false);
		fake.setStart(START);
		proc.kill("SIGKILL");
		expect(fake.signals).toEqual(["SIGHUP"]);
	});

	test("the poll notices an exit without any signal", async () => {
		const fake = fakeIo();
		const proc = createAdoptedProcess(PID, START, fake.io);
		fake.tick();
		expect(proc.exitCode).toBeNull();
		fake.setStart(undefined);
		fake.tick();
		expect(await proc.exited).toBe(-1);
		expect(fake.polling()).toBe(false);
	});
});

test("the bind-map writer continues above an adopted sender's generation", () => {
	resetBindMapWriter();
	continueBindMapGenerationAbove(7);
	expect(currentBindMapGeneration()).toBe(7);
	continueBindMapGenerationAbove(3);
	expect(currentBindMapGeneration()).toBe(7);
	continueBindMapGenerationAbove(Number.NaN);
	expect(currentBindMapGeneration()).toBe(7);
	resetBindMapWriter();
});

/**
 * A real detached process named `srtla_send`, in its own session and process
 * group and not our child, judged from the real `/proc`. Only the cgroup
 * membership is a fixture: the test runner's cgroup is shared.
 */
describe("a real detached sender", () => {
	let root = "";
	let pid = 0;
	let engine: "idle" | "streaming" | "unknown" = "streaming";

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "sender-adoption-real-"));
		// The kernel names a process after the path it was executed by, so a
		// link to this Bun binary runs as `srtla_send` and idles until killed.
		const binary = join(root, "srtla_send");
		symlinkSync(process.execPath, binary);
		const launcher = Bun.spawn(
			[
				"setsid",
				"-f",
				"sh",
				"-c",
				`echo $$ > ${root}/pid; exec ${binary} -e 'setInterval(() => {}, 1000)'`,
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		await launcher.exited;
		for (let i = 0; i < 100 && pid === 0; i++) {
			try {
				const text = readFileSync(join(root, "pid"), "utf8").trim();
				const comm = readFileSync(`/proc/${text}/comm`, "utf8").trim();
				if (comm === "srtla_send") pid = Number(text);
			} catch {
				// Not written or not exec'd yet.
			}
			if (pid === 0) await Bun.sleep(20);
		}
		// It escaped by setsid on purpose; the safety guard learns it is ours.
		adoptTestProcess(pid);
		engine = "streaming";
		spyOn(engineRuntimeState, "queryEngineRuntimeStreaming").mockImplementation(
			async () => engine,
		);
		resetSenderAdoptionForTest();
		resetBindMapWriter();
	});
	afterEach(async () => {
		for (const handle of getStreamingProcesses().filter((p) => p.adopted))
			await stopProcessAndWait(handle);
		try {
			if (
				pid > 0 &&
				readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "srtla_send"
			)
				process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
		pid = 0;
		resetSenderAdoptionForTest();
		resetBindMapWriter();
		rmSync(root, { recursive: true, force: true });
	});

	async function realIo(): Promise<SenderAdoptionIo> {
		const real = await readSenderProcessFacts("/proc", "/sys/fs/cgroup", pid);
		if (!real?.cgroup) throw new Error("no real process facts");
		mkdirSync(join(root, "cgroup", real.cgroup), { recursive: true });
		writeFileSync(
			join(root, "cgroup", real.cgroup, "cgroup.procs"),
			`${pid}\n`,
		);
		return {
			procRoot: "/proc",
			cgroupRoot: join(root, "cgroup"),
			bootId: async () => BOOT,
			readLifetime: async () =>
				lifetime({
					pid,
					startTime: real.startTime,
					argsDigest: real.argsDigest,
					cgroup: real.cgroup,
				}),
			readPublication: async () => publication(),
			readDisk: async () => publication(),
			readMarker: () => marker(),
			captureConfig: () => ({ ...CONFIG }),
			readStats: async () => [stats(1_000), stats(9_000)],
			queryEngine: async () => engine,
		};
	}

	test("is its own group leader, alone, and not our child", async () => {
		expect(pid).toBeGreaterThan(0);
		const real = await readSenderProcessFacts("/proc", "/sys/fs/cgroup", pid);
		expect(real?.comm).toBe("srtla_send");
		expect(real?.processGroup).toBe(pid);
		expect(real?.groupMembers).toEqual([pid]);
		const parent = Number(
			readFileSync(`/proc/${pid}/stat`, "utf8")
				.slice(readFileSync(`/proc/${pid}/stat`, "utf8").lastIndexOf(")") + 2)
				.split(" ")[1],
		);
		expect(parent).not.toBe(process.pid);
	});

	test("an unadopted survivor stays foreign and blocks replacement", async () => {
		expect(unownedSenderCensus(getStreamingProcesses(), "/proc")).toBe(
			"present",
		);
		expect(streamSessionProductionDeps.canReconcileStreaming?.(undefined)).toBe(
			false,
		);
	});

	test("adopted on full evidence, reconciled as streaming, reloaded and stopped through its handle", async () => {
		const io = await realIo();
		let telemetry = 0;
		const verdict = await attemptSenderAdoption(io, {
			...defaultSenderAdoptionEffects,
			attachTelemetry: () => {
				telemetry++;
			},
		});
		expect(verdict).toEqual({ decision: "adopt" });
		expect(adoptedSender()?.pid).toBe(pid);
		expect(telemetry).toBe(1);
		expect(currentBindMapGeneration()).toBe(7);
		const handle = getStreamingProcesses().find((p) => p.adopted);
		expect(handle?.spawnfile).toBe(srtlaSendExec);
		expect(ownsSessionSender()).toBe(true);
		expect(unownedSenderCensus(getStreamingProcesses(), "/proc")).toBe(
			"absent",
		);
		expect(streamSessionProductionDeps.canReconcileStreaming?.(undefined)).toBe(
			true,
		);
		// A second adoption in the same process is refused.
		expect(
			await attemptSenderAdoption(io, defaultSenderAdoptionEffects),
		).toEqual({
			decision: "refuse",
			check: "adoption",
			reason: "already_adopted",
		});

		const session = createStreamSessionOrchestrator({
			...streamSessionProductionDeps,
			initialLiveness: "unknown",
			markStreamingForOta: () => true,
			unmarkStreamingForOta: () => true,
			confirmStreamingForOta: () => true,
			awaitsIdleWitness: () => false,
			setLifecycleState: () => {},
			seedLifecycleState: () => {},
			setStreamingStatus: () => {},
			setLivenessUnconfirmed: () => {},
		});
		expect(await session.reconcile()).toBe("streaming");
		expect(session.streamLiveness()).toBe("streaming");

		// SIGCONT is harmless to the idle process; it proves reload reaches the handle.
		expect(signalSenders("SIGCONT")).toBe(1);
		if (!handle) throw new Error("no handle");
		await stopProcessAndWait(handle);
		expect(handle.proc.exitCode).toBe(-1);
		expect(getStreamingProcesses()).not.toContain(handle);
		expect(adoptedSender()).toBeUndefined();
		expect(ownsSessionSender()).toBe(false);
		// A sender spawned later in this process does not inherit the adoption:
		// without its own launch evidence it is not reconciled as streaming.
		const later = {
			spawnfile: srtlaSendExec,
			proc: { pid: 1, exitCode: null, signalCode: null },
			exitListeners: [],
		} as unknown as StreamingProcess;
		const live = getStreamingProcesses();
		live.push(later);
		try {
			expect(ownsSessionSender()).toBe(true);
			expect(
				streamSessionProductionDeps.canReconcileStreaming?.(undefined),
			).toBe(false);
		} finally {
			live.splice(live.indexOf(later), 1);
		}
		expect(streamSessionProductionDeps.canReconcileStreaming?.(undefined)).toBe(
			false,
		);
		expect(unownedSenderCensus(getStreamingProcesses(), "/proc")).toBe(
			"absent",
		);
	});

	test("a sender that exits by itself is noticed and no longer owned", async () => {
		const verdict = await attemptSenderAdoption(await realIo(), {
			...defaultSenderAdoptionEffects,
			attachTelemetry: () => {},
		});
		expect(verdict).toEqual({ decision: "adopt" });
		const handle = getStreamingProcesses().find((p) => p.adopted);
		if (!handle) throw new Error("no handle");
		process.kill(pid, "SIGKILL");
		expect(await handle.proc.exited).toBe(-1);
		await Bun.sleep(0);
		expect(getStreamingProcesses()).not.toContain(handle);
		expect(ownsSessionSender()).toBe(false);
	});

	test("the engine no longer streaming refuses and leaves the survivor alone", async () => {
		engine = "idle";
		const verdict = await attemptSenderAdoption(await realIo(), {
			...defaultSenderAdoptionEffects,
			attachTelemetry: () => {},
		});
		expect(verdict).toEqual({
			decision: "refuse",
			check: "engine",
			reason: "engine_idle",
		});
		expect(getStreamingProcesses().some((p) => p.adopted)).toBe(false);
		expect(readFileSync(`/proc/${pid}/comm`, "utf8").trim()).toBe("srtla_send");
	});
});
