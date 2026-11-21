/*
 * Adopting a running sender after a backend restart.
 *
 * A restarted backend may keep a stream only when it can prove that what is
 * running is exactly what its predecessor left behind and that it is working
 * now. Everything here is evidence read fresh from the kernel, the files the
 * sender reads and the sender's own control socket; nothing is taken from a
 * record alone. Any missing, unreadable or disagreeing fact refuses, and a
 * refusal changes nothing: no signal, no start, no stop, no engine probe. The
 * restart-safety path (`stream-session-production` `canReconcileStreaming`)
 * then keeps the session unconfirmed and protected, as before.
 *
 * THIS BASE NEVER ADOPTS, BY CONSTRUCTION. Three facts the verdict requires
 * have no source yet, and the collector reports each as unavailable:
 *
 *   - the live systemd invocation of the unit that holds the PID (today the
 *     sender is a child inside `ceralive.service` and records
 *     `host: "backend-child"`, so it dies with every restart anyway);
 *   - the map the sender has actually applied (generation and SHA-256): the
 *     installed binding reports link ids and `mapped`, which cannot tell a map
 *     written to disk before a crash from the one the sender runs;
 *   - an identity for the engine session the sender carries: the engine seam
 *     answers only `streaming | idle | unknown`, so a session that replaced
 *     the adopted one would be indistinguishable.
 *
 * The verdict, the staged collector and the adopted handle exist so that each
 * of those becomes one reader to add, not a redesign, and so that every check
 * that can be measured today is measured and tested today.
 */

import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import {
	createControlClient,
	type SenderStats,
} from "@ceraui/srtla-send/control";
import { logger } from "../../helpers/logger.ts";
import {
	type ArmedStreamConfig,
	type ArmedStreamMarker,
	readArmedStreamMarker,
} from "./armed-stream-marker.ts";
import { continueBindMapGenerationAbove } from "./bind-map-writer.ts";
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
import {
	getStreamingProcesses,
	registerAdoptedSender,
	type StreamingProcess,
	type SupervisedProcess,
} from "./streamloop/process-runner.ts";

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

	// Supervision: only a live unit that outlives the backend, with the sender
	// alone in its cgroup (no child cgroups) and in its own process group.
	if (l.host !== "systemd" || !l.invocation)
		return refuse("host", "dies_with_backend");
	if (!l.cgroup) return refuse("host", "cgroup_not_recorded");
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
		readMarker: () => readArmedStreamMarker() ?? null,
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

/** What must not move between judging the evidence and taking the sender. */
function localFingerprint(e: SenderAdoptionEvidence): string {
	return canonical({
		bootId: e.bootId,
		lifetime: e.lifetime,
		process: e.process,
		liveInvocation: e.liveInvocation,
		marker: e.marker,
		currentConfig: e.currentConfig,
		publication: e.publication,
		disk: e.disk,
	});
}

/** Poll cadence for the exit of a sender that is not our child. */
export const ADOPTED_SENDER_POLL_MS = 500;

export type AdoptedIdentity = "same" | "gone" | "uncertain";

export type AdoptedProcessIo = {
	readonly identity: (pid: number) => AdoptedIdentity;
	readonly signal: (pid: number, signal: NodeJS.Signals | number) => void;
	readonly poll: (callback: () => void, ms: number) => () => void;
};

/**
 * Same: the PID still has the adopted start time and executable and has not
 * exited (stopped or traced still counts as alive). Gone: it exited, is a
 * zombie, or the PID now names another process or program. Uncertain: the
 * table could not be read; neither exit nor ownership is claimed.
 */
export function adoptedIdentity(
	procRoot: string,
	pid: number,
	startTime: string,
	exe: string,
): AdoptedIdentity {
	let stat: string;
	try {
		stat = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? "gone"
			: "uncertain";
	}
	const fields = statFields(stat);
	if (GONE_STATES.has(fields[0] ?? "") || fields[19] !== startTime)
		return "gone";
	try {
		return readlinkSync(`${procRoot}/${pid}/exe`) === exe ? "same" : "gone";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? "gone"
			: "uncertain";
	}
}

export function defaultAdoptedProcessIo(
	startTime: string,
	exe: string,
	procRoot = "/proc",
): AdoptedProcessIo {
	return {
		identity: (pid) => adoptedIdentity(procRoot, pid, startTime, exe),
		signal: (pid, signal) => process.kill(pid, signal),
		poll: (callback, ms) => {
			const timer = setInterval(callback, ms);
			timer.unref?.();
			return () => clearInterval(timer);
		},
	};
}

/**
 * A handle on a sender that is not our child. The kernel will not hold its PID
 * for us, so its identity (PID, start time, executable) is checked again
 * immediately before every signal. A changed identity marks it exited without
 * signalling; an unreadable one throws, so a caller never counts a signal that
 * was not delivered. A failed delivery throws too. Its exit status cannot be
 * observed; an exit is reported as code -1.
 *
 * Residual window: between that check and the signal the sender could exit and
 * its PID be reused (start time has clock-tick granularity). A pidfd would close
 * it; Bun does not expose one.
 */
export function createAdoptedProcess(
	pid: number,
	io: AdoptedProcessIo,
): SupervisedProcess {
	let exitCode: number | null = null;
	const { promise: exited, resolve: resolveExited } =
		Promise.withResolvers<number>();
	let stopPolling: () => void = () => undefined;
	const check = (): AdoptedIdentity => {
		if (exitCode !== null) return "gone";
		const identity = io.identity(pid);
		if (identity === "gone") {
			exitCode = -1;
			stopPolling();
			resolveExited(-1);
		}
		return identity;
	};
	if (check() !== "gone")
		stopPolling = io.poll(() => {
			check();
		}, ADOPTED_SENDER_POLL_MS);
	return {
		pid,
		get exitCode() {
			return exitCode;
		},
		signalCode: null,
		exited,
		kill(signal?: NodeJS.Signals | number) {
			const identity = check();
			if (identity === "gone") return;
			if (identity === "uncertain")
				throw new Error("adopted sender identity unreadable; not signalled");
			try {
				io.signal(pid, signal ?? "SIGTERM");
			} catch (error) {
				if (check() !== "gone") throw error;
			}
		},
	} as SupervisedProcess;
}

type Adoption = {
	readonly pid: number;
	readonly lifetime: string;
	readonly handle: StreamingProcess;
	reconciled: boolean;
};

/** The adoption this process made, if any. At most one per process. */
let adoption: Adoption | undefined;
let adoptionMade = false;

function adoptionLive(current: Adoption | undefined): current is Adoption {
	if (current === undefined) return false;
	const { proc } = current.handle;
	return (
		proc.exitCode === null &&
		proc.signalCode === null &&
		getStreamingProcesses().includes(current.handle)
	);
}

/** The adopted sender while its own handle is live and supervised. */
export function adoptedSender():
	| { readonly pid: number; readonly lifetime: string }
	| undefined {
	const current = adoption;
	return adoptionLive(current)
		? { pid: current.pid, lifetime: current.lifetime }
		: undefined;
}

/**
 * The reconciliation exception, once. The startup reconciliation that follows
 * an adoption may accept it in place of this process's launch evidence; any
 * later reconciliation cannot tell the adopted engine session from one that
 * replaced it, so it gets no exception and falls back to the unconfirmed,
 * protected path.
 */
export function takeAdoptionForReconcile(): boolean {
	const current = adoption;
	if (!adoptionLive(current) || current.reconciled) return false;
	current.reconciled = true;
	return true;
}

/** Test isolation only. */
export function resetSenderAdoptionForTest(): void {
	adoption = undefined;
	adoptionMade = false;
}

export type SenderAdoptionEffects = {
	readonly register: typeof registerAdoptedSender;
	readonly createProcess: (
		pid: number,
		startTime: string,
		exe: string,
	) => SupervisedProcess;
	readonly continueGeneration: (applied: number) => void;
	readonly attachTelemetry: (
		lifetime: Lifetime,
		current: () => boolean,
	) => void;
};

/**
 * Collect, judge and, only on full agreement, take the sender over. Runs once
 * at startup before stream reconciliation. Never signals, stops or starts
 * anything on a refusal.
 */
export async function attemptSenderAdoption(
	io: SenderAdoptionIo,
	effects: SenderAdoptionEffects,
): Promise<SenderAdoptionVerdict> {
	const refused = (verdict: SenderAdoptionVerdict) => {
		logger.info("sender adoption refused", verdict);
		return verdict;
	};
	if (adoptionMade) return refusal("adoption", "already_adopted");
	let evidence: SenderAdoptionEvidence;
	let verdict: SenderAdoptionVerdict;
	try {
		evidence = await collectSenderAdoptionEvidence(io);
		verdict = senderAdoptionVerdict(evidence);
	} catch {
		return refused(refusal("evidence", "unreadable"));
	}
	if (verdict.decision !== "adopt") return refused(verdict);
	const { lifetime, publication, process } = evidence;
	if (!lifetime || !publication || !process?.exe)
		return refused(refusal("evidence", "unreadable"));
	// Nothing local may have moved while the sender and engine were read: an
	// operator Stop, a configuration push, a new publication, a new process.
	const again = await collectLocalEvidence(io).catch(() => undefined);
	if (
		again === undefined ||
		localFingerprint(again) !== localFingerprint(evidence)
	)
		return refused(refusal("evidence", "changed_during_adoption"));
	// The handle checks the identity once more as it is made.
	const proc = effects.createProcess(
		process.pid,
		process.startTime,
		process.exe,
	);
	if (proc.exitCode !== null)
		return refused(refusal("process", "exited_during_adoption"));
	const handle = effects.register(proc, srtlaSendExec, process.startTime);
	adoptionMade = true;
	const made: Adoption = {
		pid: process.pid,
		lifetime: lifetime.lifetime,
		handle,
		reconciled: false,
	};
	adoption = made;
	void proc.exited.then(() => {
		if (adoption === made) adoption = undefined;
	});
	effects.continueGeneration(publication.generation);
	effects.attachTelemetry(
		lifetime,
		() => adoption === made && adoptionLive(made),
	);
	logger.info("sender adopted after restart", {
		pid: process.pid,
		generation: publication.generation,
	});
	return verdict;
}

export const defaultSenderAdoptionEffects: SenderAdoptionEffects = {
	register: registerAdoptedSender,
	createProcess: (pid, startTime, exe) =>
		createAdoptedProcess(pid, defaultAdoptedProcessIo(startTime, exe)),
	continueGeneration: continueBindMapGenerationAbove,
	attachTelemetry: (lifetime, current) => {
		// Lazy: link telemetry sits further down the streaming graph. The fence
		// after the awaits keeps a late attach from restarting a watcher for a
		// sender that has already exited or been stopped.
		void (async () => {
			const { startLinkTelemetry } = await import("./link-telemetry.ts");
			const ips = (await readFile(lifetime.ipsFile, "utf8"))
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
			if (!current()) return;
			startLinkTelemetry(lifetime.statsFile, ips, {
				controlSocket: lifetime.controlSocket,
			});
		})().catch((error) =>
			logger.warn("adopted sender telemetry could not be attached", { error }),
		);
	},
};

/** Production entry point, called once at startup before stream reconciliation. */
export async function adoptRunningSenderAtStartup(): Promise<SenderAdoptionVerdict> {
	const { captureArmedStreamConfig } = await import("./stream-restoration.ts");
	return attemptSenderAdoption(
		defaultSenderAdoptionIo(captureArmedStreamConfig),
		defaultSenderAdoptionEffects,
	);
}
