import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SenderStats } from "@ceraui/srtla-send/control";
import { adoptTestProcess } from "../../../../scripts/test-safety.ts";
import {
	type ArmedStreamMarker,
	peekArmedStreamMarker,
} from "../modules/streaming/armed-stream-marker.ts";
import { digest } from "../modules/streaming/continuity-observer.ts";
import type {
	Lifetime,
	Publication,
} from "../modules/streaming/continuity-records.ts";
import * as engineRuntimeState from "../modules/streaming/engine-runtime-state.ts";
import {
	collectSenderAdoptionEvidence,
	defaultSenderAdoptionIo,
	holdsListeningSocket,
	observeSenderAdoption,
	readSenderProcessFacts,
	type SenderAdoptionEvidence,
	type SenderAdoptionIo,
	senderAdoptionVerdict,
} from "../modules/streaming/sender-adoption.ts";
import { unownedSenderCensus } from "../modules/streaming/sender-ownership.ts";
import { getStreamingProcesses } from "../modules/streaming/streamloop/process-runner.ts";

const BOOT = "boot-a";
const PID = 4242;
const START = "987654";
const EXE = "/usr/bin/srtla_send";
const ARGS = digest(JSON.stringify([EXE, "9000"]));
const CGROUP = "/system.slice/ceralive-sender-1.service";
const INVOCATION = "0123456789abcdef0123456789abcdef";
const SOCKET = "/tmp/srtla-send-control-9000.sock";
const SHA = "a".repeat(64);
const CONFIG = { srt_latency: 2000, max_br: 6000, pipeline: "p1" };

function lifetime(over: Partial<Lifetime> = {}): Lifetime {
	return {
		version: 1,
		bootId: BOOT,
		lifetime: "7d3c4f0e-2a59-4c3f-9a4f-2b6c1b8f0a11",
		pid: PID,
		startTime: START,
		host: "systemd",
		invocation: INVOCATION,
		cgroup: CGROUP,
		argsDigest: ARGS,
		statsFile: "/tmp/srtla-send-stats-9000.json",
		controlSocket: SOCKET,
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
		sha256: SHA,
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

const FACTS = {
	pid: PID,
	comm: "srtla_send",
	exe: EXE,
	state: "S",
	processGroup: PID,
	startTime: START,
	argsDigest: ARGS,
	cgroup: CGROUP,
	cgroupMembers: [PID],
	cgroupChildren: 0,
	groupMembers: [PID],
	ownsControlSocket: true,
};

function evidence(
	over: Partial<SenderAdoptionEvidence> = {},
): SenderAdoptionEvidence {
	return {
		bootId: BOOT,
		lifetime: lifetime(),
		process: { ...FACTS },
		expectedExe: EXE,
		liveInvocation: INVOCATION,
		marker: marker(),
		currentConfig: { ...CONFIG },
		publication: publication(),
		disk: publication(),
		reads: [stats(1_000), stats(400_000)],
		appliedMap: { generation: 7, sha256: SHA },
		engineSession: "session-1",
		engine: "streaming",
		...over,
	};
}

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

	test("the facts this base cannot supply refuse a production-shaped record", () => {
		expect(senderAdoptionVerdict(evidence({ liveInvocation: null }))).toEqual({
			decision: "refuse",
			check: "host",
			reason: "invocation_unverified",
		});
		expect(senderAdoptionVerdict(evidence({ appliedMap: null }))).toEqual({
			decision: "refuse",
			check: "bind_map",
			reason: "applied_identity_unavailable",
		});
		expect(senderAdoptionVerdict(evidence({ engineSession: null }))).toEqual({
			decision: "refuse",
			check: "engine",
			reason: "session_identity_unavailable",
		});
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
			{ process: { ...FACTS, startTime: "111" } },
			"process",
			"pid_reused",
		],
		[
			"a process with another name",
			{ process: { ...FACTS, comm: "sleep" } },
			"process",
			"not_a_sender",
		],
		[
			"a process that executed another program",
			{ process: { ...FACTS, exe: "/usr/bin/other" } },
			"process",
			"executable_changed",
		],
		[
			"an unreadable executable",
			{ process: { ...FACTS, exe: null } },
			"process",
			"executable_changed",
		],
		[
			"no configured executable",
			{ expectedExe: null },
			"process",
			"executable_changed",
		],
		[
			"a zombie sender",
			{ process: { ...FACTS, state: "Z" } },
			"process",
			"not_running",
		],
		[
			"a stopped sender",
			{ process: { ...FACTS, state: "T" } },
			"process",
			"stopped",
		],
		[
			"a traced sender",
			{ process: { ...FACTS, state: "t" } },
			"process",
			"stopped",
		],
		[
			"changed arguments",
			{ process: { ...FACTS, argsDigest: digest("other") } },
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
			"no recorded unit invocation",
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
			"another live invocation",
			{ liveInvocation: "f".repeat(32) },
			"host",
			"invocation_changed",
		],
		[
			"another cgroup",
			{ process: { ...FACTS, cgroup: "/system.slice/ceralive.service" } },
			"host",
			"cgroup_changed",
		],
		[
			"a second process in the cgroup",
			{ process: { ...FACTS, cgroupMembers: [PID, 5000] } },
			"host",
			"cgroup_not_exclusive",
		],
		[
			"an unreadable cgroup",
			{ process: { ...FACTS, cgroupMembers: null } },
			"host",
			"cgroup_not_exclusive",
		],
		[
			"a child cgroup below the sender",
			{ process: { ...FACTS, cgroupChildren: 1 } },
			"host",
			"cgroup_has_children",
		],
		[
			"unreadable child cgroups",
			{ process: { ...FACTS, cgroupChildren: null } },
			"host",
			"cgroup_has_children",
		],
		[
			"not its own process group",
			{ process: { ...FACTS, processGroup: 1 } },
			"host",
			"not_group_leader",
		],
		[
			"a child in its process group",
			{ process: { ...FACTS, groupMembers: [PID, 5001] } },
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
		[
			"a control socket this PID does not hold",
			{ process: { ...FACTS, ownsControlSocket: false } },
			"sender",
			"socket_not_owned",
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
			"no_live_link",
		],
		[
			"every link disconnected",
			{ reads: [disconnected(stats(1)), stats(2)] },
			"sender",
			"no_live_link",
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
		[
			"a map on disk the sender has not applied",
			{ appliedMap: { generation: 6, sha256: SHA } },
			"bind_map",
			"applied_identity_mismatch",
		],
		[
			"another applied IP list",
			{ appliedMap: { generation: 7, sha256: "c".repeat(64) } },
			"bind_map",
			"applied_identity_mismatch",
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

const UNIX_HEADER = "Num       RefCount Protocol Flags    Type St Inode Path\n";

describe("collectSenderAdoptionEvidence", () => {
	let root = "";
	let statsReads = 0;
	let engineQueries = 0;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "sender-adoption-"));
		statsReads = 0;
		engineQueries = 0;
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function writeProcess(
		pid: number,
		state: string,
		group: number,
		start: string,
		socketInode = "777",
	) {
		const dir = join(root, "proc", String(pid));
		mkdirSync(join(dir, "fd"), { recursive: true });
		mkdirSync(join(dir, "net"), { recursive: true });
		writeFileSync(join(dir, "stat"), statLine(pid, state, group, start));
		writeFileSync(join(dir, "comm"), "srtla_send\n");
		writeFileSync(join(dir, "cmdline"), `${EXE}\x009000\x00`);
		writeFileSync(join(dir, "cgroup"), `0::${CGROUP}\n`);
		symlinkSync(EXE, join(dir, "exe"));
		symlinkSync(`socket:[${socketInode}]`, join(dir, "fd", "3"));
		symlinkSync("/dev/null", join(dir, "fd", "0"));
		writeFileSync(
			join(dir, "net", "unix"),
			`${UNIX_HEADER}0000000000000000: 00000002 00000000 00010000 0001 01 777 ${SOCKET}\n0000000000000000: 00000003 00000000 00000000 0001 03 778 ${SOCKET}\n`,
		);
	}
	function writeCgroup(members: number[], children: string[] = []) {
		const dir = join(root, "cgroup", CGROUP);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "cgroup.procs"),
			members.map((m) => `${m}\n`).join(""),
		);
		for (const child of children) mkdirSync(join(dir, child));
	}
	function io(over: Partial<SenderAdoptionIo> = {}): SenderAdoptionIo {
		return {
			procRoot: join(root, "proc"),
			cgroupRoot: join(root, "cgroup"),
			expectedExe: () => EXE,
			bootId: async () => BOOT,
			readLifetime: async () => lifetime(),
			liveInvocation: async () => INVOCATION,
			readPublication: async () => publication(),
			readDisk: async () => publication(),
			readMarker: () => marker(),
			captureConfig: () => ({ ...CONFIG }),
			readStats: async () => {
				statsReads++;
				return {
					reads: [stats(1_000), stats(9_000)],
					appliedMap: { generation: 7, sha256: SHA },
				};
			},
			queryEngine: async () => {
				engineQueries++;
				return { state: "streaming", session: "session-1" };
			},
			...over,
		};
	}

	test("reads the kernel's facts and adopts a sender alone in its unit", async () => {
		writeProcess(PID, "S", PID, START);
		writeCgroup([PID]);
		const e = await collectSenderAdoptionEvidence(io());
		expect(e.process).toEqual({ ...FACTS });
		expect(senderAdoptionVerdict(e)).toEqual({ decision: "adopt" });
	});

	test("a socket held by another process is never read", async () => {
		writeProcess(PID, "S", PID, START, "999");
		writeCgroup([PID]);
		const e = await collectSenderAdoptionEvidence(io());
		expect(e.process?.ownsControlSocket).toBe(false);
		expect(statsReads).toBe(0);
		expect(senderAdoptionVerdict(e)).toMatchObject({
			reason: "socket_not_owned",
		});
	});

	test("only one listening socket at the path counts", async () => {
		writeProcess(PID, "S", PID, START);
		const table = join(root, "proc", String(PID), "net", "unix");
		writeFileSync(
			table,
			`${readFileSync(table, "utf8")}0000000000000000: 00000002 00000000 00010000 0001 01 780 ${SOCKET}\n`,
		);
		expect(await holdsListeningSocket(join(root, "proc"), PID, SOCKET)).toBe(
			false,
		);
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

	test("finds a child cgroup below the sender's", async () => {
		writeProcess(PID, "S", PID, START);
		writeCgroup([PID], ["helper.scope"]);
		const e = await collectSenderAdoptionEvidence(io());
		expect(e.process?.cgroupChildren).toBe(1);
		expect(senderAdoptionVerdict(e)).toMatchObject({
			reason: "cgroup_has_children",
		});
	});

	test("a refusal before the live reads contacts neither the sender nor the engine", async () => {
		writeProcess(PID, "S", PID, START);
		writeCgroup([PID]);
		const e = await collectSenderAdoptionEvidence(
			io({ readLifetime: async () => lifetime({ host: "backend-child" }) }),
		);
		expect(statsReads).toBe(0);
		expect(engineQueries).toBe(0);
		expect(e.reads).toEqual([]);
		expect(e.engine).toBe("unknown");
		expect(senderAdoptionVerdict(e)).toMatchObject({
			reason: "dies_with_backend",
		});
	});

	test("a refusal of the live reads does not ask the engine", async () => {
		writeProcess(PID, "S", PID, START);
		writeCgroup([PID]);
		const e = await collectSenderAdoptionEvidence(
			io({
				readStats: async () => {
					statsReads++;
					return { reads: [stats(5), stats(9)], appliedMap: null };
				},
			}),
		);
		expect(statsReads).toBe(1);
		expect(engineQueries).toBe(0);
		expect(senderAdoptionVerdict(e)).toMatchObject({
			reason: "applied_identity_unavailable",
		});
	});

	test("a missing process and unreadable reads refuse without throwing", async () => {
		const e = await collectSenderAdoptionEvidence(
			io({
				readPublication: async () => {
					throw new Error("torn");
				},
			}),
		);
		expect(e.process).toBeNull();
		expect(e.publication).toBeNull();
		expect(senderAdoptionVerdict(e)).toMatchObject({ reason: "sender_absent" });
	});

	test("the production readers supply no invocation and never probe the engine", async () => {
		const production = defaultSenderAdoptionIo(() => ({ ...CONFIG }));
		expect(await production.liveInvocation(PID)).toBeNull();
		expect(await production.queryEngine()).toEqual({
			state: "unknown",
			session: null,
		});
	});

	test("a record that could never qualify reads no process, marker or map", async () => {
		writeProcess(PID, "S", PID, START);
		writeCgroup([PID]);
		let markerReads = 0;
		let diskReads = 0;
		const e = await collectSenderAdoptionEvidence(
			io({
				readLifetime: async () => lifetime({ host: "backend-child" }),
				readMarker: () => {
					markerReads++;
					return marker();
				},
				readDisk: async () => {
					diskReads++;
					return publication();
				},
			}),
		);
		expect(e.process).toBeNull();
		expect(markerReads).toBe(0);
		expect(diskReads).toBe(0);
		expect(statsReads).toBe(0);
		expect(engineQueries).toBe(0);
		expect(senderAdoptionVerdict(e)).toMatchObject({
			check: "host",
			reason: "dies_with_backend",
		});
	});

	test("the evidence read leaves an unreadable armed marker in place", () => {
		const path = join(root, "stream.armed.json");
		writeFileSync(path, "{torn");
		const deps = {
			markerPath: path,
			readMarker: (file: string) => readFileSync(file, "utf8"),
			writeMarker: () => {
				throw new Error("must not write");
			},
			removeMarker: () => {
				throw new Error("must not remove");
			},
			readBootId: () => BOOT,
		};
		expect(peekArmedStreamMarker(deps)).toBeUndefined();
		expect(readFileSync(path, "utf8")).toBe("{torn");
		writeFileSync(path, JSON.stringify(marker()));
		expect(peekArmedStreamMarker(deps)).toMatchObject(marker());
	});
});

describe("startup wiring", () => {
	test("detect only: logs a verdict, probes nothing and changes nothing", async () => {
		const probe = spyOn(
			engineRuntimeState,
			"queryEngineRuntimeStreaming",
		).mockImplementation(async () => "streaming");
		const before = getStreamingProcesses().length;
		const verdict = await observeSenderAdoption();
		expect(verdict.decision).toBe("refuse");
		expect(probe).not.toHaveBeenCalled();
		expect(getStreamingProcesses().length).toBe(before);
		probe.mockRestore();
	});

	test("an evidence reader that throws is a logged refusal, not a crash", async () => {
		const verdict = await observeSenderAdoption({
			...defaultSenderAdoptionIo(() => ({ ...CONFIG })),
			procRoot: join(tmpdir(), "no-such-proc-root"),
			bootId: async () => BOOT,
			readLifetime: async () => lifetime(),
			captureConfig: () => {
				throw new Error("config unreadable");
			},
		});
		expect(verdict).toEqual({
			decision: "refuse",
			check: "evidence",
			reason: "unreadable",
		});
	});
});

/**
 * A real detached process named `srtla_send` that listens on a Unix socket, in
 * its own session and process group and not our child, judged from the real
 * `/proc`. Synthetic: the cgroup membership (the test runner's cgroup is
 * shared), the unit invocation, the applied map and the engine session (no
 * source exists on this base), and the records.
 */
describe("a real detached sender", () => {
	let root = "";
	let socket = "";
	let pid = 0;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "sender-adoption-real-"));
		socket = join(root, "control.sock");
		// The kernel names a process after the path it was executed by, so a
		// link to this Bun binary runs as `srtla_send`.
		const binary = join(root, "srtla_send");
		symlinkSync(process.execPath, binary);
		const script = `Bun.listen({ unix: ${JSON.stringify(socket)}, socket: { data() {} } }); setInterval(() => {}, 1000);`;
		const launcher = Bun.spawn(
			[
				"setsid",
				"-f",
				"sh",
				"-c",
				`echo $$ > ${root}/pid; exec ${binary} -e '${script}'`,
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		await launcher.exited;
		for (let i = 0; i < 150 && pid === 0; i++) {
			try {
				const text = readFileSync(join(root, "pid"), "utf8").trim();
				const comm = readFileSync(`/proc/${text}/comm`, "utf8").trim();
				if (
					comm === "srtla_send" &&
					(await holdsListeningSocket("/proc", Number(text), socket))
				)
					pid = Number(text);
			} catch {
				// Not written, not exec'd or not listening yet.
			}
			if (pid === 0) await Bun.sleep(20);
		}
		// It escaped by setsid on purpose; the safety guard learns it is ours.
		adoptTestProcess(pid);
	});
	afterEach(() => {
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
		rmSync(root, { recursive: true, force: true });
	});

	async function realIo(
		over: Partial<SenderAdoptionIo> = {},
	): Promise<SenderAdoptionIo> {
		const real = await readSenderProcessFacts(
			"/proc",
			"/sys/fs/cgroup",
			pid,
			socket,
		);
		if (!real?.cgroup) throw new Error("no real process facts");
		mkdirSync(join(root, "cgroup", real.cgroup), { recursive: true });
		writeFileSync(
			join(root, "cgroup", real.cgroup, "cgroup.procs"),
			`${pid}\n`,
		);
		let reads = 0;
		return {
			procRoot: "/proc",
			cgroupRoot: join(root, "cgroup"),
			expectedExe: () => realpathSync(process.execPath),
			bootId: async () => BOOT,
			readLifetime: async () =>
				lifetime({
					pid,
					startTime: real.startTime,
					argsDigest: real.argsDigest,
					cgroup: real.cgroup,
					controlSocket: socket,
				}),
			liveInvocation: async () => INVOCATION,
			readPublication: async () => publication(),
			readDisk: async () => publication(),
			readMarker: () => marker(),
			captureConfig: () => ({ ...CONFIG }),
			readStats: async () => {
				reads++;
				return {
					reads: [stats(reads * 1_000), stats(reads * 9_000)],
					appliedMap: { generation: 7, sha256: SHA },
				};
			},
			queryEngine: async () => ({ state: "streaming", session: "session-1" }),
			...over,
		};
	}

	test("is its own group leader, holds its socket, and is not our child", async () => {
		expect(pid).toBeGreaterThan(0);
		const real = await readSenderProcessFacts(
			"/proc",
			"/sys/fs/cgroup",
			pid,
			socket,
		);
		expect(real?.comm).toBe("srtla_send");
		expect(real?.exe).toBe(realpathSync(process.execPath));
		expect(real?.processGroup).toBe(pid);
		expect(real?.groupMembers).toEqual([pid]);
		expect(real?.ownsControlSocket).toBe(true);
		expect(await holdsListeningSocket("/proc", process.pid, socket)).toBe(
			false,
		);
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
		expect(parent).not.toBe(process.pid);
	});

	test("judged from the real kernel, with the missing sources supplied the verdict would adopt", async () => {
		expect(await observeSenderAdoption(await realIo())).toEqual({
			decision: "adopt",
		});
		// Detect only: nothing was taken over, and the survivor stays foreign.
		expect(getStreamingProcesses().length).toBe(0);
		expect(unownedSenderCensus(getStreamingProcesses(), "/proc")).toBe(
			"present",
		);
		expect(readFileSync(`/proc/${pid}/comm`, "utf8").trim()).toBe("srtla_send");
	});

	test("with this base's readers the same sender is refused at the first missing source", async () => {
		expect(
			await observeSenderAdoption(
				await realIo({ liveInvocation: async () => null }),
			),
		).toEqual({
			decision: "refuse",
			check: "host",
			reason: "invocation_unverified",
		});
	});

	test("a sender stopped by a signal is refused, not judged running", async () => {
		process.kill(pid, "SIGSTOP");
		try {
			expect(await observeSenderAdoption(await realIo())).toEqual({
				decision: "refuse",
				check: "process",
				reason: "stopped",
			});
		} finally {
			process.kill(pid, "SIGCONT");
		}
	});
});
