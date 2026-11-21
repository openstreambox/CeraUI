/*
 * Judging, after a backend restart, whether a sender left running could be
 * adopted. DETECT ONLY: this module reads evidence, judges it and logs the
 * verdict. It never registers, signals, stops or starts anything, never reads
 * the sender's socket before every local fact agrees, and runs after stream
 * reconciliation without being awaited.
 *
 * A restarted backend may keep a stream only when it can prove that what is
 * running is exactly what its predecessor left behind and that it is working
 * now. Every fact here is read fresh from the kernel, systemd, the files the
 * sender reads, the sender's own control socket and the engine's session
 * connection; a record only says where to look. A positive verdict means these
 * measured facts agree; it is not proof that a takeover would be safe.
 *
 * Each fact has a production source:
 *
 *   - the process: PID, start time and state from `/proc`, read while a pidfd
 *     pins the PID, so a PID reused during the read is never judged as the
 *     recorded sender; no pidfd, or a liveness answer other than "alive",
 *     refuses;
 *   - the unit: `systemctl show` for the recorded unit (InvocationID, main
 *     PID, state, control group, restart policy);
 *   - the control socket: the peer of the actual connection must be the
 *     recorded PID by SO_PEERCRED and alive under that number by SO_PEERPIDFD
 *     (Linux 6.5+) before any request is written; a kernel without
 *     SO_PEERPIDFD refuses;
 *   - the applied map: `bind_map_applied` in the sender's stats, reported only
 *     by a contract-2 sender that also advertises required binding;
 *   - the engine session: the engine's own session id, asked on the session
 *     connection that reconciliation holds, scoped by the engine unit's
 *     InvocationID and main PID, compared with the id the engine's Start reply
 *     gave for this sender's launch (recorded then, confirmed live).
 *
 * A positive verdict holds only at the moment it is reported: after the
 * engine answers, every local fact is read again on the same pin and must be
 * unchanged. Any unknown answer refuses.
 *
 * On today's devices the sender is a child of the backend, so every record
 * says `host: "backend-child"` and the verdict refuses before any of these
 * live sources is read. Taking a sender over needs more than evidence (a
 * handle bound to the pinned process, a session-bound reconciliation, a
 * unit-aware census, a host that survives the backend); that design is in the
 * stream continuity notes, not in this code.
 */

import { realpathSync } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import {
	createControlClient,
	type SenderStats,
} from "@ceraui/srtla-send/control";
import { logger } from "../../helpers/logger.ts";
import {
	type ProcessPin,
	pinProcess,
	readPeerIdentity,
} from "../../helpers/process-pin.ts";
import {
	type ArmedStreamConfig,
	type ArmedStreamMarker,
	peekArmedStreamMarker,
} from "./armed-stream-marker.ts";
import {
	continuityObserverIo,
	digest,
	readDiskPublication,
} from "./continuity-observer.ts";
import {
	type Lifetime,
	lifetimeSchema,
	type Publication,
	publicationSchema,
	readRecord,
} from "./continuity-records.ts";
import {
	type EngineSessionIdentity,
	readEngineSessionIdentity,
	readUnitFacts,
	statFields,
	type UnitFacts,
	type UnitManager,
	type UnitShow,
} from "./sender-invocation.ts";
import type {
	EngineRuntimeState,
	EngineSessionEvidence,
} from "./streaming-backend.ts";
import { srtlaSendExec } from "./streamloop/exec-paths.ts";

export type SenderProcessFacts = {
	readonly pid: number;
	readonly comm: string;
	/** `/proc/<pid>/exe`; null when unreadable. */
	readonly exe: string | null;
	/** `/proc/<pid>/stat` state letter. */
	readonly state: string;
	readonly processGroup: number;
	readonly startTime: string;
	readonly argsDigest: string;
	/** The unified-hierarchy cgroup path, or null when unreadable. */
	readonly cgroup: string | null;
	/** Every PID directly in that cgroup, or null when unreadable. */
	readonly cgroupMembers: readonly number[] | null;
	/** Child cgroups below it, or null when unreadable. */
	readonly cgroupChildren: number | null;
	/** Every PID whose process group is this PID, or null when unreadable. */
	readonly groupMembers: readonly number[] | null;
	/**
	 * True only when the control socket path is a listening Unix socket whose
	 * inode this PID holds open. A sample of the listener, not proof of who
	 * answers a later connection to that path (that needs the peer's
	 * credentials on the connection itself).
	 */
	readonly ownsControlSocket: boolean;
	/** True when a pidfd pinned the PID across these reads. */
	readonly pidfd: boolean;
};

/**
 * Whether the peer of the control connection is the recorded process:
 * `verified` when SO_PEERCRED names the recorded PID and SO_PEERPIDFD shows
 * that listener alive under that same number; `mismatch` when either names
 * another process or the listener has exited; `unsupported` when the kernel
 * has no SO_PEERPIDFD, so only the number could be compared; `unavailable`
 * when no connection was made, the credentials could not be read, or the pin
 * on the recorded PID was no longer confirmed alive just before the request.
 * Only `verified` counts. Both options describe the process that called
 * listen(2), not whoever accepts: the check assumes the sender does not share
 * or pass on its listening descriptor (the installed sender listens directly
 * and does not fork).
 */
export type PeerCheck = "verified" | "mismatch" | "unsupported" | "unavailable";

export type SenderAdoptionEvidence = {
	readonly bootId: string;
	readonly lifetime: Lifetime | null;
	readonly process: SenderProcessFacts | null;
	/** The resolved path of the configured sender executable, or null. */
	readonly expectedExe: string | null;
	/** Live facts for the recorded unit, or null when unknown or unread. */
	readonly liveUnit: UnitFacts | null;
	readonly marker: ArmedStreamMarker | null;
	readonly currentConfig: ArmedStreamConfig;
	readonly publication: Publication | null;
	readonly disk: Publication | null;
	/** Whether the control connection's peer is the recorded process. */
	readonly peer: PeerCheck;
	/**
	 * The pin on the recorded process was not confirmed alive after the stats
	 * reads (exited, or its liveness unknown).
	 */
	readonly exitedDuringRead: boolean;
	/** `bind_map_contract` from `get_capabilities` on that connection, or null. */
	readonly senderContract: number | null;
	/** `bind_map_required` from that same answer, or null. */
	readonly senderRequired: boolean | null;
	/**
	 * The final pass after every other read: `agrees` when the pin is still
	 * confirmed alive and a fresh read of every local fact (process, unit,
	 * marker, configuration, publication, map on disk) equals the first and
	 * still passes; `changed` or `exited` otherwise; `not_reached` when an
	 * earlier check refused.
	 */
	readonly revalidated: "agrees" | "changed" | "exited" | "not_reached";
	/** Two reads of `get_stats` over the recorded control socket, in order. */
	readonly reads: readonly (SenderStats | null)[];
	/**
	 * The map the sender reports as applied, the same on both reads, or null
	 * when it cannot say or the two reads differ.
	 */
	readonly appliedMap: {
		readonly generation: number;
		readonly sha256: string;
	} | null;
	/** Identity of the engine session, or null when the engine cannot say. */
	readonly engineSession: EngineSessionIdentity | null;
	readonly engine: EngineRuntimeState;
};

export type SenderAdoptionVerdict =
	| { readonly decision: "adopt" }
	| {
			readonly decision: "refuse";
			readonly check: string;
			readonly reason: string;
	  };

/** States in which a process has exited or is exiting. */
const GONE_STATES = new Set(["Z", "X", "x"]);
/** Stopped or traced: alive, but not a sender to adopt. */
const STOPPED_STATES = new Set(["T", "t"]);

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	return JSON.stringify(value);
}

function onlyMember(members: readonly number[] | null, pid: number): boolean {
	return members !== null && members.length === 1 && members[0] === pid;
}

/** Links the sender reports connected and not timed out. */
function liveLinks(stats: SenderStats): number {
	return stats.links.filter((link) => link.connected && !link.timed_out).length;
}

function refusal(check: string, reason: string): SenderAdoptionVerdict {
	return { decision: "refuse", check, reason };
}

const ADOPT: SenderAdoptionVerdict = { decision: "adopt" };

/**
 * The whole decision, pure, so each fact can be flipped on its own. Every
 * refusal names the first check that failed.
 */
export function senderAdoptionVerdict(
	e: SenderAdoptionEvidence,
): SenderAdoptionVerdict {
	const before = verdictBeforeSenderReads(e);
	if (before.decision !== "adopt") return before;
	const reads = verdictOfSenderReads(e);
	if (reads.decision !== "adopt") return reads;
	return verdictOfEngine(e);
}

/** The refusal decided by the record alone, if any. */
function recordRefusal(
	e: SenderAdoptionEvidence,
): SenderAdoptionVerdict | undefined {
	const verdict = verdictBeforeSenderReads({ ...e, process: null });
	return verdict.decision === "refuse" && verdict.check !== "process"
		? verdict
		: undefined;
}

/** Records, process identity, supervision, configuration, map on disk, socket. */
function verdictBeforeSenderReads(
	e: SenderAdoptionEvidence,
): SenderAdoptionVerdict {
	const refuse = refusal;
	if (!e.bootId) return refuse("boot", "boot_id_unreadable");
	const l = e.lifetime;
	if (!l) return refuse("lifetime", "missing_or_invalid");
	if (l.bootId !== e.bootId) return refuse("lifetime", "previous_boot");
	if (l.pid === null || l.startTime === null)
		return refuse("lifetime", "never_started");

	// The record's own host: only a unit that outlives the backend qualifies.
	if (l.host !== "systemd") return refuse("host", "dies_with_backend");
	if (!l.invocation) return refuse("host", "invocation_not_recorded");
	if (!l.cgroup) return refuse("host", "cgroup_not_recorded");
	if (!l.unit) return refuse("host", "unit_not_recorded");

	// The process: the one recorded, the configured executable, unchanged.
	const p = e.process;
	if (!p || p.pid !== l.pid) return refuse("process", "sender_absent");
	if (p.startTime !== l.startTime) return refuse("process", "pid_reused");
	if (p.comm !== "srtla_send") return refuse("process", "not_a_sender");
	if (!e.expectedExe || p.exe !== e.expectedExe)
		return refuse("process", "executable_changed");
	if (GONE_STATES.has(p.state)) return refuse("process", "not_running");
	if (STOPPED_STATES.has(p.state)) return refuse("process", "stopped");
	// Without a pidfd nothing ties the reads to one process: unknown, refused.
	if (!p.pidfd) return refuse("process", "pin_unavailable");
	if (p.argsDigest !== l.argsDigest)
		return refuse("process", "arguments_changed");

	// Supervision: that unit, live, with the sender as its main process, no
	// restart policy that could replace it, alone in its cgroup (no child
	// cgroups) and in its own process group.
	const u = e.liveUnit;
	if (!u) return refuse("host", "invocation_unverified");
	if (u.invocation !== l.invocation)
		return refuse("host", "invocation_changed");
	if (u.mainPid !== p.pid) return refuse("host", "not_main_pid");
	if (u.activeState !== "active" || u.subState !== "running")
		return refuse("host", "unit_not_running");
	if (u.restart !== "no") return refuse("host", "unit_restarts");
	if (p.cgroup !== l.cgroup || u.controlGroup !== l.cgroup)
		return refuse("host", "cgroup_changed");
	if (!onlyMember(p.cgroupMembers, p.pid))
		return refuse("host", "cgroup_not_exclusive");
	if (p.cgroupChildren !== 0) return refuse("host", "cgroup_has_children");
	if (p.processGroup !== p.pid) return refuse("host", "not_group_leader");
	if (!onlyMember(p.groupMembers, p.pid))
		return refuse("host", "group_not_exclusive");

	// The configuration still asks for this stream.
	const m = e.marker;
	if (!m) return refuse("config", "no_armed_stream");
	if (m.bootId !== e.bootId) return refuse("config", "previous_boot");
	if (canonical(m.config) !== canonical(e.currentConfig))
		return refuse("config", "config_changed");

	// The map on disk is the one published.
	const pub = e.publication;
	if (!pub) return refuse("bind_map", "publication_missing");
	if (pub.bootId !== e.bootId) return refuse("bind_map", "previous_boot");
	if (!l.sidecarFile) return refuse("bind_map", "sender_unmapped");
	if (!e.disk) return refuse("bind_map", "disk_unreadable");
	if (pub.generation > e.disk.generation)
		return refuse("bind_map", "record_ahead_of_disk");
	if (
		pub.generation !== e.disk.generation ||
		pub.sha256 !== e.disk.sha256 ||
		canonical(pub.links) !== canonical(e.disk.links)
	)
		return refuse("bind_map", "disk_mismatch");

	// Only now may the socket be contacted, and only if this PID holds it.
	if (!p.ownsControlSocket) return refuse("sender", "socket_not_owned");
	return ADOPT;
}

/** The two live reads over the sender's control socket. */
function verdictOfSenderReads(
	e: SenderAdoptionEvidence,
): SenderAdoptionVerdict {
	const refuse = refusal;
	const pub = e.publication;
	if (!pub) return refuse("bind_map", "publication_missing");
	// The pinned process must have lived through the reads, and nothing read
	// over a connection counts unless its peer is that process.
	if (e.exitedDuringRead) return refuse("process", "exited_during_read");
	if (e.peer === "mismatch") return refuse("sender", "peer_mismatch");
	if (e.peer === "unsupported")
		return refuse("sender", "peer_pidfd_unsupported");
	if (e.peer !== "verified") return refuse("sender", "peer_unverified");
	if (e.reads.length !== 2) return refuse("sender", "two_reads_required");
	const expectedLinks = canonical(
		pub.links.map(({ linkId, iface }) => ({ linkId, iface })),
	);
	for (const read of e.reads) {
		if (!read) return refuse("sender", "control_unavailable");
		if (read.bind_map_pending) return refuse("bind_map", "apply_pending");
		if (read.disposition?.state !== "mapped")
			return refuse("sender", "not_mapped");
		const links = canonical(
			read.links.map((link) => ({
				linkId: link.link_id ?? "",
				iface: link.iface ?? "",
			})),
		);
		if (links !== expectedLinks) return refuse("sender", "links_mismatch");
		if (liveLinks(read) === 0) return refuse("sender", "no_live_link");
	}
	const [first, second] = e.reads;
	if (
		first?.session_bytes_sent === undefined ||
		second?.session_bytes_sent === undefined
	)
		return refuse("sender", "byte_counter_unavailable");
	if (second.session_bytes_sent <= first.session_bytes_sent)
		return refuse("sender", "no_progress");
	// The applied identity exists from contract 2, and only required mode
	// refuses to fall back to an unmapped bond.
	if (e.senderContract === null || e.senderContract < 2)
		return refuse("sender", "contract_below_2");
	if (e.senderRequired !== true)
		return refuse("sender", "required_unsupported");
	if (!e.lifetime?.required) return refuse("sender", "not_required_mode");
	// Link ids and `mapped` cannot tell a map written before a crash (and never
	// signalled) from the one the sender runs, so an applied identity is
	// required. Even that compares generation and the IP-list hash only, not
	// sidecar-only fields such as `id_path`.
	if (!e.appliedMap) return refuse("bind_map", "applied_identity_unavailable");
	if (
		e.appliedMap.generation !== pub.generation ||
		e.appliedMap.sha256 !== pub.sha256
	)
		return refuse("bind_map", "applied_identity_mismatch");
	return ADOPT;
}

/**
 * The engine half, then the final pass. The same engine process (unit
 * InvocationID and main PID) reports the session id its Start reply gave for
 * this sender's launch, and its session connection reported `streaming`
 * before and after the question. The binding documents `session_id` as
 * optional with no stated uniqueness, so equal ids mean "same id from the
 * same engine process", not more.
 */
function verdictOfEngine(e: SenderAdoptionEvidence): SenderAdoptionVerdict {
	const engine = verdictOfEngineSession(e);
	if (engine.decision !== "adopt") return engine;
	// Valid only at the moment it is reported: everything read again last.
	if (e.revalidated === "exited")
		return refusal("process", "exited_during_read");
	if (e.revalidated === "changed")
		return refusal("evidence", "changed_during_read");
	if (e.revalidated !== "agrees") return refusal("evidence", "not_revalidated");
	return ADOPT;
}

/** The engine half alone, before the final pass. */
function verdictOfEngineSession(
	e: SenderAdoptionEvidence,
): SenderAdoptionVerdict {
	const recorded = e.lifetime?.engineSession;
	if (!recorded) return refusal("engine", "session_not_recorded");
	const live = e.engineSession;
	if (!live) return refusal("engine", "session_identity_unavailable");
	if (
		live.invocation !== recorded.invocation ||
		live.mainPid !== recorded.mainPid
	)
		return refusal("engine", "engine_restarted");
	if (live.sessionId !== recorded.sessionId)
		return refusal("engine", "session_changed");
	if (e.engine !== "streaming") return refusal("engine", `engine_${e.engine}`);
	return ADOPT;
}

/** Kernel and file reads, injectable so tests never read the host's tables. */
export type SenderAdoptionIo = {
	readonly procRoot: string;
	readonly cgroupRoot: string;
	readonly expectedExe: () => string | null;
	readonly bootId: () => Promise<string>;
	readonly readLifetime: () => Promise<Lifetime | null>;
	/** Pin a PID for the length of the collection (a pidfd where available). */
	readonly pin: (pid: number) => Promise<ProcessPin | null>;
	/** Live facts for a recorded unit; null when unknown or unreadable. */
	readonly liveUnit: (
		unit: string,
		manager: UnitManager,
	) => Promise<UnitFacts | null>;
	readonly readPublication: () => Promise<Publication | null>;
	readonly readDisk: (lifetime: Lifetime) => Promise<Publication | null>;
	readonly readMarker: () => ArmedStreamMarker | null;
	readonly captureConfig: () => ArmedStreamConfig;
	/**
	 * Both reads over one connection whose peer must be `pid`; `pinned` must
	 * still confirm the recorded process alive just before the first request.
	 */
	readonly readStats: (
		controlSocket: string,
		pid: number,
		pinned: () => boolean,
	) => Promise<SenderReads>;
	/** Engine state with a session identity; never called before it can matter. */
	readonly queryEngine: () => Promise<{
		readonly state: EngineRuntimeState;
		readonly session: EngineSessionIdentity | null;
	}>;
};

export type SenderReads = {
	readonly peer: PeerCheck;
	readonly senderContract: number | null;
	readonly senderRequired: boolean | null;
	readonly reads: readonly (SenderStats | null)[];
	readonly appliedMap: SenderAdoptionEvidence["appliedMap"];
};

/** Gap between the two control reads; the sender's counters move continuously. */
export const SENDER_ADOPTION_READ_GAP_MS = 500;
const CONTROL_TIMEOUT_MS = 500;

/**
 * Whether the peer of connected socket `fd` is `pid`. SO_PEERCRED names the
 * process that listened; SO_PEERPIDFD, where the kernel has it, says whether
 * that same process is still alive under that number.
 */
export async function checkControlPeer(
	fd: number,
	pid: number,
	read: typeof readPeerIdentity = readPeerIdentity,
): Promise<PeerCheck> {
	const peer = await read(fd).catch(() => null);
	if (!peer) return "unavailable";
	if (peer.pid !== pid) return "mismatch";
	switch (peer.pidfd.state) {
		case "alive":
			return peer.pidfd.pid === pid ? "verified" : "mismatch";
		case "exited":
			return "mismatch";
		case "unsupported":
			return "unsupported";
		default:
			return "unavailable";
	}
}

/** The applied identity both reads agree on, or null. */
export function appliedMapOf(
	reads: readonly (SenderStats | null)[],
): SenderAdoptionEvidence["appliedMap"] {
	const [first, second] = reads;
	const a = first?.bind_map_applied;
	const b = second?.bind_map_applied;
	if (!a || !b) return null;
	if (a.generation !== b.generation || a.ips_file_sha256 !== b.ips_file_sha256)
		return null;
	return { generation: a.generation, sha256: a.ips_file_sha256 };
}

const NO_READS: SenderReads = {
	peer: "unavailable",
	senderContract: null,
	senderRequired: null,
	reads: [null, null],
	appliedMap: null,
};

/**
 * Capabilities and two stats reads over ONE connection, and only after its
 * peer is shown to be `pid`: nothing is written to a socket some other
 * process answers.
 */
export async function readPeerBoundStats(
	controlSocket: string,
	pid: number,
	check: (fd: number, pid: number) => Promise<PeerCheck> = checkControlPeer,
	pinned: () => boolean = () => true,
): Promise<SenderReads> {
	let peer: PeerCheck = "unavailable";
	const client = await createControlClient({
		socketPath: controlSocket,
		timeoutMs: CONTROL_TIMEOUT_MS,
		verifyPeer: async (fd) => {
			peer = await check(fd, pid);
			// The recorded process, confirmed alive at the last moment before
			// anything is written.
			if (peer === "verified" && !pinned()) peer = "unavailable";
			return peer === "verified";
		},
	});
	if (!client) return { ...NO_READS, peer };
	try {
		const capabilities = await client.getCapabilities();
		const first = await client.getStats();
		await Bun.sleep(SENDER_ADOPTION_READ_GAP_MS);
		const second = await client.getStats();
		const reads = [first, second];
		return {
			peer,
			senderContract: capabilities?.capabilities.bind_map_contract ?? null,
			senderRequired: capabilities?.capabilities.bind_map_required ?? null,
			reads,
			appliedMap: appliedMapOf(reads),
		};
	} catch {
		return { ...NO_READS, peer };
	} finally {
		client.close();
	}
}

/**
 * The engine's session identity from the session connection reconciliation
 * holds, and the last state that connection reported. Read only.
 */
export async function querySessionEngine(
	sessionEvidence?: () => Promise<EngineSessionEvidence>,
	show?: UnitShow,
): Promise<{
	state: EngineRuntimeState;
	session: EngineSessionIdentity | null;
}> {
	let ask: () => Promise<EngineSessionEvidence>;
	if (sessionEvidence) ask = sessionEvidence;
	else {
		const { getStreamingBackend } = await import("./streaming-engine.ts");
		ask = () => getStreamingBackend().sessionEvidence();
	}
	let state: EngineRuntimeState = "unknown";
	const session = await readEngineSessionIdentity(async () => {
		const evidence = await ask();
		state = evidence.state;
		return evidence.sessionId;
	}, show);
	// No identity, no claim about the state either.
	return session ? { state, session } : { state: "unknown", session: null };
}

function resolvedSenderExe(): string | null {
	try {
		return realpathSync(srtlaSendExec);
	} catch {
		return null;
	}
}

export function defaultSenderAdoptionIo(
	captureConfig: () => ArmedStreamConfig,
): SenderAdoptionIo {
	return {
		procRoot: "/proc",
		cgroupRoot: "/sys/fs/cgroup",
		expectedExe: resolvedSenderExe,
		bootId: () => continuityObserverIo.bootId(),
		readLifetime: () =>
			readRecord(
				`${continuityObserverIo.directory}/lifetime.json`,
				lifetimeSchema,
			),
		pin: pinProcess,
		liveUnit: (unit, manager) => readUnitFacts(unit, manager),
		readPublication: () =>
			readRecord(
				`${continuityObserverIo.directory}/publication.json`,
				publicationSchema,
			),
		readDisk: (lifetime) => readDiskPublication(lifetime),
		// Read without side effects: an unreadable marker stays for restoration.
		readMarker: () => peekArmedStreamMarker() ?? null,
		captureConfig,
		readStats: (controlSocket, pid, pinned) =>
			readPeerBoundStats(controlSocket, pid, checkControlPeer, pinned),
		// Never the reconciliation probe (the stateful entry point): one read
		// on the connection reconciliation already holds, plus systemd.
		queryEngine: () => querySessionEngine(),
	};
}

async function cgroupFacts(
	cgroupRoot: string,
	cgroup: string,
): Promise<{ members: number[] | null; children: number | null }> {
	const dir = `${cgroupRoot}${cgroup}`;
	let members: number[] | null = null;
	let children: number | null = null;
	try {
		members = (await readFile(`${dir}/cgroup.procs`, "utf8"))
			.split("\n")
			.filter((line) => line.length > 0)
			.map(Number);
	} catch {
		members = null;
	}
	try {
		children = (await readdir(dir, { withFileTypes: true })).filter((entry) =>
			entry.isDirectory(),
		).length;
	} catch {
		children = null;
	}
	return { members, children };
}

async function processGroupMembers(
	procRoot: string,
	group: number,
): Promise<number[] | null> {
	let entries: string[];
	try {
		entries = await readdir(procRoot);
	} catch {
		return null;
	}
	const members: number[] = [];
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		let stat: string;
		try {
			stat = await readFile(`${procRoot}/${entry}/stat`, "utf8");
		} catch (error) {
			// Exited between the listing and the read.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return null;
		}
		if (Number(statFields(stat)[2]) === group) members.push(Number(entry));
	}
	return members;
}

/**
 * The listening socket at `path` in the PID's network namespace, by inode, and
 * whether one of the PID's descriptors is that inode.
 */
export async function holdsListeningSocket(
	procRoot: string,
	pid: number,
	path: string,
): Promise<boolean> {
	let table: string;
	try {
		table = await readFile(`${procRoot}/${pid}/net/unix`, "utf8");
	} catch {
		return false;
	}
	// Num RefCount Protocol Flags Type St Inode Path; Flags 00010000 = listening.
	const inodes = new Set<string>();
	for (const line of table.split("\n").slice(1)) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 8 || fields.slice(7).join(" ") !== path) continue;
		if (fields[3] !== "00010000") continue;
		if (fields[6]) inodes.add(fields[6]);
	}
	if (inodes.size !== 1) return false;
	let fds: string[];
	try {
		fds = await readdir(`${procRoot}/${pid}/fd`);
	} catch {
		return false;
	}
	for (const fd of fds) {
		try {
			const target = await readlink(`${procRoot}/${pid}/fd/${fd}`);
			const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
			if (inode !== undefined && inodes.has(inode)) return true;
		} catch {
			// Closed between the listing and the read.
		}
	}
	return false;
}

/**
 * Everything the kernel says about one PID, or null when it is gone. With a
 * pin, the facts are discarded when the pinned process is no longer alive at
 * the end, so a PID reused during the reads is never described.
 */
export async function readSenderProcessFacts(
	procRoot: string,
	cgroupRoot: string,
	pid: number,
	controlSocket: string,
	pin: ProcessPin | null = null,
): Promise<SenderProcessFacts | null> {
	let stat: string;
	let comm: string;
	let cmdline: string;
	try {
		stat = await readFile(`${procRoot}/${pid}/stat`, "utf8");
		comm = (await readFile(`${procRoot}/${pid}/comm`, "utf8")).trim();
		cmdline = await readFile(`${procRoot}/${pid}/cmdline`, "utf8");
	} catch {
		return null;
	}
	const fields = statFields(stat);
	const args = cmdline.split("\0");
	if (args.at(-1) === "") args.pop();
	let exe: string | null = null;
	try {
		exe = await readlink(`${procRoot}/${pid}/exe`);
	} catch {
		exe = null;
	}
	let cgroup: string | null = null;
	try {
		const line = (await readFile(`${procRoot}/${pid}/cgroup`, "utf8"))
			.split("\n")
			.find((entry) => entry.startsWith("0::"));
		cgroup = line ? line.slice(3) : null;
	} catch {
		cgroup = null;
	}
	const processGroup = Number(fields[2]);
	const facts =
		cgroup === null
			? { members: null, children: null }
			: await cgroupFacts(cgroupRoot, cgroup);
	const result: SenderProcessFacts = {
		pid,
		comm,
		exe,
		state: fields[0] ?? "",
		processGroup,
		startTime: fields[19] ?? "",
		argsDigest: digest(JSON.stringify(args)),
		cgroup,
		cgroupMembers: facts.members,
		cgroupChildren: facts.children,
		groupMembers: Number.isInteger(processGroup)
			? await processGroupMembers(procRoot, processGroup)
			: null,
		ownsControlSocket: await holdsListeningSocket(procRoot, pid, controlSocket),
		pidfd: pin?.pidfd === true,
	};
	// A pinned process not confirmed alive is not described.
	if (pin?.pidfd && pin.alive() !== true) return null;
	return result;
}

/** Every fact that needs no contact with the sender or the engine. */
async function collectLocalEvidence(
	io: SenderAdoptionIo,
	pinFor: (pid: number) => Promise<ProcessPin | null>,
): Promise<SenderAdoptionEvidence> {
	const bootId = await io.bootId().catch(() => "");
	const lifetime = await io.readLifetime().catch(() => null);
	// Record facts decide first: no process table, cgroup, marker or map read
	// for a record that could never qualify (every record on this base).
	const recordOnly: SenderAdoptionEvidence = {
		bootId,
		lifetime,
		process: null,
		expectedExe: null,
		liveUnit: null,
		marker: null,
		currentConfig: {},
		publication: null,
		disk: null,
		peer: "unavailable",
		exitedDuringRead: false,
		senderContract: null,
		senderRequired: null,
		revalidated: "not_reached",
		reads: [],
		appliedMap: null,
		engineSession: null,
		engine: "unknown",
	};
	if (recordRefusal(recordOnly) !== undefined) return recordOnly;
	let process: SenderProcessFacts | null = null;
	if (lifetime?.pid != null) {
		const pin = await pinFor(lifetime.pid);
		if (pin) {
			process = await readSenderProcessFacts(
				io.procRoot,
				io.cgroupRoot,
				lifetime.pid,
				lifetime.controlSocket,
				pin,
			);
		}
	}
	return {
		...recordOnly,
		process,
		expectedExe: io.expectedExe(),
		liveUnit:
			process === null || !lifetime?.unit
				? null
				: await io
						.liveUnit(lifetime.unit, lifetime.unitManager ?? "system")
						.catch(() => null),
		marker: io.readMarker(),
		currentConfig: io.captureConfig(),
		publication: await io.readPublication().catch(() => null),
		disk: lifetime ? await io.readDisk(lifetime).catch(() => null) : null,
	};
}

/**
 * Fresh evidence, in stages. The sender's socket is contacted only once every
 * local fact agrees and this PID holds that socket, and nothing is written to
 * it before its peer is shown to be that PID and the pin confirms the process
 * alive; the engine source is asked only once the sender's reads agree too,
 * so an earlier refusal reads neither; a final pass reads every local fact
 * again. On today's devices none of this is reached: every record says
 * `backend-child`. Facts not gathered read as unavailable.
 */
export async function collectSenderAdoptionEvidence(
	io: SenderAdoptionIo,
): Promise<SenderAdoptionEvidence> {
	// One pin on the recorded PID for the whole collection: the process facts,
	// the peer check, the reads and the final pass all describe that one
	// process. It does not keep the process alive; it is checked again just
	// before the first request, after the reads, and last of all.
	let pin: ProcessPin | null = null;
	const pinFor = async (pid: number) => {
		pin ??= await io.pin(pid).catch(() => null);
		return pin;
	};
	const confirmedAlive = () => (pin as ProcessPin | null)?.alive() === true;
	try {
		const local = await collectLocalEvidence(io, pinFor);
		if (
			!local.lifetime?.pid ||
			verdictBeforeSenderReads(local).decision !== "adopt"
		)
			return local;
		const sender = await io
			.readStats(
				local.lifetime.controlSocket,
				local.lifetime.pid,
				confirmedAlive,
			)
			.catch(() => NO_READS);
		const withReads: SenderAdoptionEvidence = {
			...local,
			...sender,
			exitedDuringRead: !confirmedAlive(),
		};
		if (verdictOfSenderReads(withReads).decision !== "adopt") return withReads;
		const engine = await io
			.queryEngine()
			.catch(() => ({ state: "unknown" as const, session: null }));
		const withEngine: SenderAdoptionEvidence = {
			...withReads,
			engine: engine.state,
			engineSession: engine.session,
		};
		if (verdictOfEngineSession(withEngine).decision !== "adopt")
			return withEngine;
		// The final pass, immediately before the verdict is reported: every
		// local fact read again on the same pin, unchanged and still passing,
		// and the process still confirmed alive after it.
		const again = await collectLocalEvidence(io, pinFor);
		const revalidated = !confirmedAlive()
			? "exited"
			: verdictBeforeSenderReads(again).decision === "adopt" &&
					localFingerprint(again) === localFingerprint(local)
				? "agrees"
				: "changed";
		return { ...withEngine, revalidated };
	} finally {
		(pin as ProcessPin | null)?.close();
	}
}

/** Every local fact, canonically, for the final comparison. */
function localFingerprint(e: SenderAdoptionEvidence): string {
	return canonical({
		bootId: e.bootId,
		lifetime: e.lifetime,
		process: e.process,
		expectedExe: e.expectedExe,
		liveUnit: e.liveUnit,
		marker: e.marker,
		currentConfig: e.currentConfig,
		publication: e.publication,
		disk: e.disk,
	});
}

/**
 * Production entry point: collect, judge, log. Detect only; called once at
 * startup after stream reconciliation and not awaited.
 */
export async function observeSenderAdoption(
	io?: SenderAdoptionIo,
): Promise<SenderAdoptionVerdict> {
	let verdict: SenderAdoptionVerdict;
	try {
		const source =
			io ??
			defaultSenderAdoptionIo(
				(await import("./stream-restoration.ts")).captureArmedStreamConfig,
			);
		verdict = senderAdoptionVerdict(
			await collectSenderAdoptionEvidence(source),
		);
	} catch {
		verdict = refusal("evidence", "unreadable");
	}
	logger.info("sender adoption verdict (detect only)", verdict);
	return verdict;
}
