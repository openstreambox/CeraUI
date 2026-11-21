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
import { readPeerIdentity } from "../helpers/process-pin.ts";
import {
	type ArmedStreamMarker,
	peekArmedStreamMarker,
} from "../modules/streaming/armed-stream-marker.ts";
import { digest } from "../modules/streaming/continuity-observer.ts";
import {
	type Lifetime,
	lifetimeSchema,
	type Publication,
} from "../modules/streaming/continuity-records.ts";
import * as engineRuntimeState from "../modules/streaming/engine-runtime-state.ts";
import {
	checkControlPeer,
	collectSenderAdoptionEvidence,
	defaultSenderAdoptionIo,
	holdsListeningSocket,
	observeSenderAdoption,
	type PeerCheck,
	readPeerBoundStats,
	readSenderProcessFacts,
	type SenderAdoptionEvidence,
	type SenderAdoptionIo,
	senderAdoptionVerdict,
} from "../modules/streaming/sender-adoption.ts";
import type { UnitFacts } from "../modules/streaming/sender-invocation.ts";
import { unownedSenderCensus } from "../modules/streaming/sender-ownership.ts";
import { getStreamingProcesses } from "../modules/streaming/streamloop/process-runner.ts";

const BOOT = "boot-a";
const PID = 4242;
const START = "987654";
const EXE = "/usr/bin/srtla_send";
const ARGS = digest(JSON.stringify([EXE, "9000"]));
const CGROUP = "/system.slice/ceralive-sender-1.service";
const INVOCATION = "0123456789abcdef0123456789abcdef";
const UNIT = "ceralive-sender-1.service";
const ENGINE_SESSION = {
	invocation: "fedcba9876543210fedcba9876543210",
	mainPid: 777,
	sessionId: "session-1",
};
const LIVE_UNIT: UnitFacts = {
	unit: UNIT,
	invocation: INVOCATION,
	mainPid: PID,
	activeState: "active",
	subState: "running",
	controlGroup: CGROUP,
	restart: "no",
};
/** A pin for a synthetic `/proc`: there is no real process to hold. */
const FAKE_PIN = { pidfd: false, alive: () => true, close: () => undefined };
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
		unit: UNIT,
		unitManager: "system",
		pidfd: true,
		engineSession: { ...ENGINE_SESSION },
		argsDigest: ARGS,
		statsFile: "/tmp/srtla-send-stats-9000.json",
		controlSocket: SOCKET,
		ipsFile: "/run/ceralive/ips",
		sidecarFile: "/run/ceralive/ips.bindmap.json",
		required: true,
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
		bind_map_applied: { generation: 7, ips_file_sha256: SHA },
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
	pidfd: false,
};

function evidence(
	over: Partial<SenderAdoptionEvidence> = {},
): SenderAdoptionEvidence {
	return {
		bootId: BOOT,
		lifetime: lifetime(),
		process: { ...FACTS },
		expectedExe: EXE,
		liveUnit: { ...LIVE_UNIT },
		marker: marker(),
		currentConfig: { ...CONFIG },
		publication: publication(),
		disk: publication(),
		peer: "verified",
		exitedDuringRead: false,
		senderContract: 2,
		reads: [stats(1_000), stats(400_000)],
		appliedMap: { generation: 7, sha256: SHA },
		engineSession: { ...ENGINE_SESSION },
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

	test("a missing live source refuses at its own check", () => {
		expect(senderAdoptionVerdict(evidence({ liveUnit: null }))).toEqual({
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
			"a systemd record without its invocation",
			{ lifetime: lifetime({ invocation: null }) },
			"host",
			"invocation_not_recorded",
		],
		[
			"no recorded cgroup",
			{ lifetime: lifetime({ cgroup: undefined }) },
			"host",
			"cgroup_not_recorded",
		],
		[
			"a systemd record without its unit",
			{ lifetime: lifetime({ unit: null }) },
			"host",
			"unit_not_recorded",
		],
		[
			"another live invocation",
			{ liveUnit: { ...LIVE_UNIT, invocation: "f".repeat(32) } },
			"host",
			"invocation_changed",
		],
		[
			"a unit whose main process is another PID",
			{ liveUnit: { ...LIVE_UNIT, mainPid: PID + 1 } },
			"host",
			"not_main_pid",
		],
		[
			"a unit that is stopping",
			{
				liveUnit: {
					...LIVE_UNIT,
					activeState: "deactivating",
					subState: "stop-sigterm",
				},
			},
			"host",
			"unit_not_running",
		],
		[
			"a unit that would restart the sender",
			{ liveUnit: { ...LIVE_UNIT, restart: "on-failure" } },
			"host",
			"unit_restarts",
		],
		[
			"another cgroup",
			{ process: { ...FACTS, cgroup: "/system.slice/ceralive.service" } },
			"host",
			"cgroup_changed",
		],
		[
			"a unit whose control group moved",
			{
				liveUnit: { ...LIVE_UNIT, controlGroup: "/system.slice/other.service" },
			},
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
		[
			"a sender that exited while it was read",
			{ exitedDuringRead: true, peer: "unavailable" },
			"process",
			"exited_during_read",
		],
		[
			"a control peer that is another process",
			{ peer: "mismatch" },
			"sender",
			"peer_mismatch",
		],
		[
			"a control peer whose credentials could not be read",
			{ peer: "unavailable" },
			"sender",
			"peer_unverified",
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
			"a publication the sender has read but not applied",
			{
				reads: [
					stats(1),
					stats(2, {
						bind_map_pending: { generation: 8, ips_file_sha256: SHA },
					}),
				],
			},
			"bind_map",
			"apply_pending",
		],
		[
			"a sender below contract 2",
			{ senderContract: 1 },
			"sender",
			"contract_below_2",
		],
		[
			"a sender that cannot say its contract",
			{ senderContract: null },
			"sender",
			"contract_below_2",
		],
		[
			"a sender not started in required mode",
			{ lifetime: lifetime({ required: false }) },
			"sender",
			"not_required_mode",
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
		[
			"no engine session recorded at launch",
			{ lifetime: lifetime({ engineSession: null }) },
			"engine",
			"session_not_recorded",
		],
		[
			"an engine restarted under the same unit",
			{
				engineSession: {
					...ENGINE_SESSION,
					invocation: "0".repeat(32),
				},
			},
			"engine",
			"engine_restarted",
		],
		[
			"an engine process replaced",
			{ engineSession: { ...ENGINE_SESSION, mainPid: 778 } },
			"engine",
			"engine_restarted",
		],
		[
			"another engine session in the same engine",
			{ engineSession: { ...ENGINE_SESSION, sessionId: "session-2" } },
			"engine",
			"session_changed",
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
			pin: async () => FAKE_PIN,
			liveUnit: async () => ({ ...LIVE_UNIT }),
			readPublication: async () => publication(),
			readDisk: async () => publication(),
			readMarker: () => marker(),
			captureConfig: () => ({ ...CONFIG }),
			readStats: async () => {
				statsReads++;
				return {
					peer: "verified",
					senderContract: 2,
					reads: [stats(1_000), stats(9_000)],
					appliedMap: { generation: 7, sha256: SHA },
				};
			},
			queryEngine: async () => {
				engineQueries++;
				return { state: "streaming", session: { ...ENGINE_SESSION } };
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
					return {
						peer: "verified",
						senderContract: 2,
						reads: [stats(5), stats(9)],
						appliedMap: null,
					};
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

	test("the production readers ask systemd and the session connection, never the reconciliation probe", async () => {
		const probe = spyOn(
			engineRuntimeState,
			"queryEngineRuntimeStreaming",
		).mockImplementation(async () => "streaming");
		const production = defaultSenderAdoptionIo(() => ({ ...CONFIG }));
		// No such unit is loaded on any test host.
		expect(
			await production.liveUnit("ceraui-no-such-sender.service", "user"),
		).toBeNull();
		// Without a running engine unit the session connection is never asked.
		expect(await production.queryEngine()).toEqual({
			state: "unknown",
			session: null,
		});
		expect(probe).not.toHaveBeenCalled();
		probe.mockRestore();
	});

	test("a record that could never qualify reads no process facts, marker, publication or map", async () => {
		writeProcess(PID, "S", PID, START);
		writeCgroup([PID]);
		let markerReads = 0;
		let diskReads = 0;
		let publicationReads = 0;
		const e = await collectSenderAdoptionEvidence(
			io({
				readLifetime: async () => lifetime({ host: "backend-child" }),
				readPublication: async () => {
					publicationReads++;
					return publication();
				},
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
		expect(publicationReads).toBe(0);
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

describe("observeSenderAdoption, the entry point main.ts calls", () => {
	test("with no record it refuses, probes no engine and registers no process", async () => {
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

/** The capability document a contract-2 sender answers. */
const CONTRACT_2_CAPABILITIES = {
	schema_version: 1,
	binary: "srtla_send",
	version: "0.0.0-test",
	capabilities: {
		bind_map: true,
		stats_file: true,
		dry_run: true,
		control_socket_jsonrpc: true,
		conn_timeout_ms: true,
		modes: ["classic", "enhanced"],
		bind_map_required: true,
		bind_map_required_empty_reload: true,
		bind_map_contract: 2,
	},
};

/**
 * A script for a fake sender: it listens on `socket`, answers
 * `get_capabilities` and `get_stats` (bytes rising on every read) and appends
 * one line to `requests` for every request it is sent.
 */
function fakeSenderScript(socket: string, requests: string): string {
	return `
const { appendFileSync } = require("node:fs");
let bytes = 1000;
const caps = ${JSON.stringify(CONTRACT_2_CAPABILITIES)};
const stats = ${JSON.stringify(stats(0))};
Bun.listen({
	unix: ${JSON.stringify(socket)},
	socket: {
		data(s, chunk) {
			for (const line of chunk.toString().split("\\n")) {
				if (!line.trim()) continue;
				const req = JSON.parse(line);
				appendFileSync(${JSON.stringify(requests)}, req.method + "\\n");
				let result;
				if (req.method === "get_capabilities") result = caps;
				else if (req.method === "get_stats") {
					bytes += 5000;
					result = { ...stats, session_bytes_sent: bytes };
				}
				s.write(JSON.stringify(result === undefined
					? { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "no" } }
					: { jsonrpc: "2.0", id: req.id, result }) + "\\n");
			}
		},
	},
});
setInterval(() => {}, 1000);
`;
}

/**
 * A real detached process named `srtla_send` that answers on a Unix socket, in
 * its own session and process group and not our child, judged from the real
 * `/proc` with a real pidfd, and read over the production peer-bound client.
 * Synthetic: the cgroup membership (the test runner's cgroup is shared), the
 * unit facts, the engine session and the records.
 */
describe("a real detached sender", () => {
	let root = "";
	let socket = "";
	let requests = "";
	let pid = 0;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "sender-adoption-real-"));
		socket = join(root, "control.sock");
		requests = join(root, "requests");
		// The kernel names a process after the path it was executed by, so a
		// link to this Bun binary runs as `srtla_send`.
		const binary = join(root, "srtla_send");
		symlinkSync(process.execPath, binary);
		const script = join(root, "sender.js");
		writeFileSync(script, fakeSenderScript(socket, requests));
		const launcher = Bun.spawn(
			[
				"setsid",
				"-f",
				"sh",
				"-c",
				`echo $$ > ${root}/pid; exec ${binary} ${script}`,
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

	const requestsSeen = () => {
		try {
			return readFileSync(requests, "utf8").split("\n").filter(Boolean);
		} catch {
			return [];
		}
	};

	async function realIo(
		over: Partial<SenderAdoptionIo> = {},
		record: Partial<Lifetime> = {},
	): Promise<SenderAdoptionIo> {
		const real = await readSenderProcessFacts(
			"/proc",
			"/sys/fs/cgroup",
			pid,
			socket,
		);
		if (!real?.cgroup) throw new Error("no real process facts");
		const cgroup = real.cgroup;
		mkdirSync(join(root, "cgroup", cgroup), { recursive: true });
		writeFileSync(join(root, "cgroup", cgroup, "cgroup.procs"), `${pid}\n`);
		return {
			...defaultSenderAdoptionIo(() => ({ ...CONFIG })),
			cgroupRoot: join(root, "cgroup"),
			expectedExe: () => realpathSync(process.execPath),
			bootId: async () => BOOT,
			readLifetime: async () =>
				lifetime({
					pid,
					startTime: real.startTime,
					argsDigest: real.argsDigest,
					cgroup,
					controlSocket: socket,
					...record,
				}),
			liveUnit: async () => ({
				...LIVE_UNIT,
				mainPid: pid,
				controlGroup: cgroup,
			}),
			readPublication: async () => publication(),
			readDisk: async () => publication(),
			readMarker: () => marker(),
			queryEngine: async () => ({
				state: "streaming",
				session: { ...ENGINE_SESSION },
			}),
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

	test("read over the production client, pinned and peer-checked, the facts agree and nothing is taken over", async () => {
		const io = await realIo();
		const e = await collectSenderAdoptionEvidence(io);
		expect(e.process?.pidfd).toBe(true);
		expect(e.peer).toBe("verified");
		expect(e.senderContract).toBe(2);
		expect(e.appliedMap).toEqual({ generation: 7, sha256: SHA });
		expect(e.exitedDuringRead).toBe(false);
		expect(requestsSeen()).toEqual([
			"get_capabilities",
			"get_stats",
			"get_stats",
		]);
		expect(await observeSenderAdoption(io)).toEqual({ decision: "adopt" });
		// Detect only: nothing was taken over, and the survivor stays foreign.
		expect(getStreamingProcesses().length).toBe(0);
		expect(unownedSenderCensus(getStreamingProcesses(), "/proc")).toBe(
			"present",
		);
		expect(readFileSync(`/proc/${pid}/comm`, "utf8").trim()).toBe("srtla_send");
	});

	test("a peer that is not the recorded PID is sent nothing", async () => {
		const reads = await readPeerBoundStats(socket, process.pid);
		expect(reads.peer).toBe("mismatch");
		expect(reads.reads).toEqual([null, null]);
		expect(requestsSeen()).toEqual([]);
		const verified = await readPeerBoundStats(socket, pid);
		expect(verified.peer).toBe("verified");
		expect(requestsSeen().length).toBe(3);
	});

	test("SO_PEERCRED names the sender and its live pidfd agrees", async () => {
		const seen: PeerCheck[] = [];
		await readPeerBoundStats(socket, pid, async (fd, expected) => {
			const peer = await readPeerIdentity(fd);
			expect(peer?.pid).toBe(pid);
			// Kernels without SO_PEERPIDFD report null; with it, the live PID.
			expect([pid, null]).toContain(peer?.pidfdPid ?? null);
			const result = await checkControlPeer(fd, expected);
			seen.push(result);
			return result;
		});
		expect(seen).toEqual(["verified"]);
	});

	test("a stale PID reused by another process is refused before the socket is touched", async () => {
		const e = await collectSenderAdoptionEvidence(
			await realIo({}, { startTime: "1" }),
		);
		expect(senderAdoptionVerdict(e)).toEqual({
			decision: "refuse",
			check: "process",
			reason: "pid_reused",
		});
		expect(requestsSeen()).toEqual([]);
	});

	test("a sender that exits after its reads is caught by the pin", async () => {
		const io = await realIo({
			readStats: async (path, expected) => {
				const reads = await readPeerBoundStats(path, expected);
				process.kill(pid, "SIGKILL");
				for (let i = 0; i < 100; i++) {
					try {
						readFileSync(`/proc/${pid}/stat`);
						await Bun.sleep(10);
					} catch {
						break;
					}
				}
				return reads;
			},
		});
		const e = await collectSenderAdoptionEvidence(io);
		expect(e.peer).toBe("verified");
		expect(e.exitedDuringRead).toBe(true);
		expect(senderAdoptionVerdict(e)).toEqual({
			decision: "refuse",
			check: "process",
			reason: "exited_during_read",
		});
	});

	test("with no live unit source the same sender is refused at the host", async () => {
		expect(
			await observeSenderAdoption(await realIo({ liveUnit: async () => null })),
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

test("a malformed recorded cgroup reads as absent instead of failing the record", () => {
	const parsed = lifetimeSchema.parse({ ...lifetime(), cgroup: 42 });
	expect(parsed.cgroup).toBeNull();
	expect(parsed.pid).toBe(PID);
});
