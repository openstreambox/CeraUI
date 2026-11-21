/*
 * Judging, after a backend restart, whether a sender left running could be
 * adopted. DETECT ONLY: this module reads evidence, judges it and logs the
 * verdict. It never registers, signals, stops or starts anything, never reads
 * the sender's socket before every local fact agrees, never probes the engine
 * on this base, and runs after stream reconciliation without being awaited.
 *
 * A restarted backend may keep a stream only when it can prove that what is
 * running is exactly what its predecessor left behind and that it is working
 * now. Every fact here is read fresh from the kernel, the files the sender
 * reads and the sender's own control socket; a record only says where to look.
 *
 * Three facts the verdict requires have no source yet, so it always refuses
 * at one of them on this base:
 *
 *   - the live systemd invocation of the unit holding the PID (today the
 *     sender is a child inside `ceralive.service`, records
 *     `host: "backend-child"` and dies with every restart anyway);
 *   - the map the sender has actually applied (generation and SHA-256): link
 *     ids and `mapped` cannot tell a map written to disk before a crash from
 *     the one the sender runs;
 *   - an identity for the engine session the sender carries: the engine seam
 *     answers only `streaming | idle | unknown`.
 *
 * Taking a sender over needs more than these sources (a handle bound to the
 * peer, a session-bound reconciliation, a unit-aware census); that design is in
 * the stream continuity notes, not in this code.
 */

import { realpathSync } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import {
	createControlClient,
	type SenderStats,
} from "@ceraui/srtla-send/control";
import { logger } from "../../helpers/logger.ts";
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
import type { EngineRuntimeState } from "./streaming-backend.ts";
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
	 * inode this PID holds open. Ties the socket's answers to this process.
	 */
	readonly ownsControlSocket: boolean;
};

export type SenderAdoptionEvidence = {
	readonly bootId: string;
	readonly lifetime: Lifetime | null;
	readonly process: SenderProcessFacts | null;
	/** The resolved path of the configured sender executable, or null. */
	readonly expectedExe: string | null;
	/** The live invocation id of the unit holding the PID, or null when no source. */
	readonly liveInvocation: string | null;
	readonly marker: ArmedStreamMarker | null;
	readonly currentConfig: ArmedStreamConfig;
	readonly publication: Publication | null;
	readonly disk: Publication | null;
	/** Two reads of `get_stats` over the recorded control socket, in order. */
	readonly reads: readonly (SenderStats | null)[];
	/** The map the sender reports as applied, or null when it cannot say. */
	readonly appliedMap: {
		readonly generation: number;
		readonly sha256: string;
	} | null;
	/** Identity of the engine session, or null when the engine cannot say. */
	readonly engineSession: string | null;
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
	if (l.host !== "systemd" || !l.invocation)
		return refuse("host", "dies_with_backend");
	if (!l.cgroup) return refuse("host", "cgroup_not_recorded");

	// The process: the one recorded, the configured executable, unchanged.
	const p = e.process;
	if (!p || p.pid !== l.pid) return refuse("process", "sender_absent");
	if (p.startTime !== l.startTime) return refuse("process", "pid_reused");
	if (p.comm !== "srtla_send") return refuse("process", "not_a_sender");
	if (!e.expectedExe || p.exe !== e.expectedExe)
		return refuse("process", "executable_changed");
	if (GONE_STATES.has(p.state)) return refuse("process", "not_running");
	if (STOPPED_STATES.has(p.state)) return refuse("process", "stopped");
	if (p.argsDigest !== l.argsDigest)
		return refuse("process", "arguments_changed");

	// Supervision: that unit, live, with the sender alone in its cgroup (no
	// child cgroups) and in its own process group.
	if (!e.liveInvocation) return refuse("host", "invocation_unverified");
	if (e.liveInvocation !== l.invocation)
		return refuse("host", "invocation_changed");
	if (p.cgroup !== l.cgroup) return refuse("host", "cgroup_changed");
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
	if (e.reads.length !== 2) return refuse("sender", "two_reads_required");
	const expectedLinks = canonical(
		pub.links.map(({ linkId, iface }) => ({ linkId, iface })),
	);
	for (const read of e.reads) {
		if (!read) return refuse("sender", "control_unavailable");
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
	// Link ids and `mapped` cannot tell a map written before a crash (and never
	// signalled) from the one the sender runs; only its applied identity can.
	if (!e.appliedMap) return refuse("bind_map", "applied_identity_unavailable");
	if (
		e.appliedMap.generation !== pub.generation ||
		e.appliedMap.sha256 !== pub.sha256
	)
		return refuse("bind_map", "applied_identity_mismatch");
	return ADOPT;
}

/** The engine still runs the session this sender carries. */
function verdictOfEngine(e: SenderAdoptionEvidence): SenderAdoptionVerdict {
	if (!e.engineSession)
		return refusal("engine", "session_identity_unavailable");
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
	/** The live invocation of the unit holding `pid`; null with no source. */
	readonly liveInvocation: (pid: number) => Promise<string | null>;
	readonly readPublication: () => Promise<Publication | null>;
	readonly readDisk: (lifetime: Lifetime) => Promise<Publication | null>;
	readonly readMarker: () => ArmedStreamMarker | null;
	readonly captureConfig: () => ArmedStreamConfig;
	readonly readStats: (controlSocket: string) => Promise<{
		readonly reads: readonly (SenderStats | null)[];
		readonly appliedMap: SenderAdoptionEvidence["appliedMap"];
	}>;
	/** Engine state with a session identity; never called before it can matter. */
	readonly queryEngine: () => Promise<{
		readonly state: EngineRuntimeState;
		readonly session: string | null;
	}>;
};

/** Gap between the two control reads; the sender's counters move continuously. */
export const SENDER_ADOPTION_READ_GAP_MS = 500;
const CONTROL_TIMEOUT_MS = 500;

async function readTwoStats(controlSocket: string) {
	const client = await createControlClient({
		socketPath: controlSocket,
		timeoutMs: CONTROL_TIMEOUT_MS,
	});
	// The installed binding exposes no applied map identity.
	if (!client) return { reads: [null, null], appliedMap: null };
	try {
		const first = await client.getStats();
		await Bun.sleep(SENDER_ADOPTION_READ_GAP_MS);
		const second = await client.getStats();
		return { reads: [first, second], appliedMap: null };
	} catch {
		return { reads: [null, null], appliedMap: null };
	} finally {
		client.close();
	}
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
		// No reader for a unit's live invocation exists on this base.
		liveInvocation: async () => null,
		readPublication: () =>
			readRecord(
				`${continuityObserverIo.directory}/publication.json`,
				publicationSchema,
			),
		readDisk: (lifetime) => readDiskPublication(lifetime),
		// Read without side effects: an unreadable marker stays for restoration.
		readMarker: () => peekArmedStreamMarker() ?? null,
		captureConfig,
		readStats: readTwoStats,
		// The engine seam has no session identity, so it is never probed from
		// here: a probe is the stateful reconciliation entry point and would
		// attach the engine client ahead of the orchestrator.
		queryEngine: async () => ({ state: "unknown", session: null }),
	};
}

function statFields(stat: string): string[] {
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
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

/** Everything the kernel says about one PID, or null when it is gone. */
export async function readSenderProcessFacts(
	procRoot: string,
	cgroupRoot: string,
	pid: number,
	controlSocket: string,
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
	return {
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
	};
}

/** Every fact that needs no contact with the sender or the engine. */
async function collectLocalEvidence(
	io: SenderAdoptionIo,
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
		liveInvocation: null,
		marker: null,
		currentConfig: {},
		publication: null,
		disk: null,
		reads: [],
		appliedMap: null,
		engineSession: null,
		engine: "unknown",
	};
	if (recordRefusal(recordOnly) !== undefined) return recordOnly;
	const process =
		lifetime?.pid != null
			? await readSenderProcessFacts(
					io.procRoot,
					io.cgroupRoot,
					lifetime.pid,
					lifetime.controlSocket,
				)
			: null;
	return {
		bootId,
		lifetime,
		process,
		expectedExe: io.expectedExe(),
		liveInvocation:
			process === null
				? null
				: await io.liveInvocation(process.pid).catch(() => null),
		marker: io.readMarker(),
		currentConfig: io.captureConfig(),
		publication: await io.readPublication().catch(() => null),
		disk: lifetime ? await io.readDisk(lifetime).catch(() => null) : null,
		reads: [],
		appliedMap: null,
		engineSession: null,
		engine: "unknown",
	};
}

/**
 * Fresh evidence, in stages. The sender's socket is contacted only once every
 * local fact agrees and this PID holds that socket; the engine is asked only
 * once the sender's reads agree too. A refusal therefore costs no socket read
 * and no engine query. Facts not gathered read as unavailable.
 */
export async function collectSenderAdoptionEvidence(
	io: SenderAdoptionIo,
): Promise<SenderAdoptionEvidence> {
	const local = await collectLocalEvidence(io);
	if (!local.lifetime || verdictBeforeSenderReads(local).decision !== "adopt")
		return local;
	const sender = await io
		.readStats(local.lifetime.controlSocket)
		.catch(() => ({ reads: [null, null], appliedMap: null }));
	const withReads = { ...local, ...sender };
	if (verdictOfSenderReads(withReads).decision !== "adopt") return withReads;
	const engine = await io
		.queryEngine()
		.catch(() => ({ state: "unknown" as const, session: null }));
	return { ...withReads, engine: engine.state, engineSession: engine.session };
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
