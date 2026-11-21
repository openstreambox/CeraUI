/*
 * Adopting a running sender after a backend restart.
 *
 * A restarted backend may keep a stream only when it can prove that what is
 * running is exactly what its predecessor left behind and that it is working
 * now. Everything here is evidence read fresh from the kernel, the files the
 * sender reads, the sender's own control socket and the engine; nothing is taken
 * from a record alone. Any missing, unreadable or disagreeing fact refuses, and a
 * refusal changes nothing: the restart-safety path (`stream-session-production`
 * `canReconcileStreaming`) then keeps the session unconfirmed and protected, as
 * before this module existed.
 *
 * WHAT A PRODUCTION BACKEND RECORDS TODAY NEVER ADOPTS. The sender is a child of
 * the backend inside `ceralive.service` (`KillMode=mixed`), so systemd kills it
 * with every restart, and its lifetime record says `host: "backend-child"`. The
 * verdict refuses that host even if such a sender were found alive. Adoption
 * becomes reachable only once a sender host that survives the backend (its own
 * unit, recording `host: "systemd"`, the invocation and its cgroup) exists.
 *
 * The order of the checks is the order of the reasons a support log should name
 * first: whether there is a record for this boot, whether the process at that PID
 * is the one recorded, whether it is supervised on its own, whether the
 * configuration still asks for it, whether the map it runs is the one on disk,
 * whether it is carrying data with receiver replies, and whether the engine
 * still runs the session.
 */

import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
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
	/** `/proc/<pid>/stat` state letter. */
	readonly state: string;
	readonly processGroup: number;
	readonly startTime: string;
	readonly argsDigest: string;
	/** The unified-hierarchy cgroup path, or null when unreadable. */
	readonly cgroup: string | null;
	/** Every PID in that cgroup, or null when unreadable. */
	readonly cgroupMembers: readonly number[] | null;
	/** Every PID whose process group is this PID, or null when unreadable. */
	readonly groupMembers: readonly number[] | null;
};

export type SenderAdoptionEvidence = {
	readonly bootId: string;
	readonly lifetime: Lifetime | null;
	readonly process: SenderProcessFacts | null;
	readonly marker: ArmedStreamMarker | null;
	readonly currentConfig: ArmedStreamConfig;
	readonly publication: Publication | null;
	readonly disk: Publication | null;
	/** Two reads of `get_stats` over the recorded control socket, in order. */
	readonly reads: readonly (SenderStats | null)[];
	readonly engine: EngineRuntimeState;
};

export type SenderAdoptionVerdict =
	| { readonly decision: "adopt" }
	| {
			readonly decision: "refuse";
			readonly check: string;
			readonly reason: string;
	  };

/** States in which a process is not running, or not going to run by itself. */
const NOT_RUNNING_STATES = new Set(["Z", "X", "x", "T", "t"]);

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

/** Links the sender carries with a receiver reply inside its own timeout. */
function answeredLinks(stats: SenderStats): number {
	return stats.links.filter((link) => link.connected && !link.timed_out).length;
}

/**
 * The whole decision, pure, so each fact can be flipped on its own. Every
 * refusal names the first check that failed.
 */
export function senderAdoptionVerdict(
	e: SenderAdoptionEvidence,
): SenderAdoptionVerdict {
	const refuse = (check: string, reason: string): SenderAdoptionVerdict => ({
		decision: "refuse",
		check,
		reason,
	});
	if (!e.bootId) return refuse("boot", "boot_id_unreadable");
	const l = e.lifetime;
	if (!l) return refuse("lifetime", "missing_or_invalid");
	if (l.bootId !== e.bootId) return refuse("lifetime", "previous_boot");
	if (l.pid === null || l.startTime === null)
		return refuse("lifetime", "never_started");

	// The process: the one recorded, still running, unchanged.
	const p = e.process;
	if (!p || p.pid !== l.pid) return refuse("process", "sender_absent");
	if (p.startTime !== l.startTime) return refuse("process", "pid_reused");
	if (p.comm !== "srtla_send") return refuse("process", "not_a_sender");
	if (NOT_RUNNING_STATES.has(p.state)) return refuse("process", "not_running");
	if (p.argsDigest !== l.argsDigest)
		return refuse("process", "arguments_changed");

	// Supervision: only a host that outlives the backend, and the sender alone
	// in the cgroup and process group that host gave it.
	if (l.host !== "systemd" || !l.invocation)
		return refuse("host", "dies_with_backend");
	if (!l.cgroup) return refuse("host", "cgroup_not_recorded");
	if (p.cgroup !== l.cgroup) return refuse("host", "cgroup_changed");
	if (!onlyMember(p.cgroupMembers, p.pid))
		return refuse("host", "cgroup_not_exclusive");
	if (p.processGroup !== p.pid) return refuse("host", "not_group_leader");
	if (!onlyMember(p.groupMembers, p.pid))
		return refuse("host", "group_not_exclusive");

	// The configuration still asks for this stream.
	const m = e.marker;
	if (!m) return refuse("config", "no_armed_stream");
	if (m.bootId !== e.bootId) return refuse("config", "previous_boot");
	if (canonical(m.config) !== canonical(e.currentConfig))
		return refuse("config", "config_changed");

	// The map: what was published is on disk, and the sender runs it.
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

	// The sender itself, twice: mapped to exactly those links, receiver replies
	// on at least one of them, and its own byte counter moving.
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
		if (answeredLinks(read) === 0) return refuse("sender", "no_receiver_reply");
	}
	const [first, second] = e.reads;
	if (
		first?.session_bytes_sent === undefined ||
		second?.session_bytes_sent === undefined
	)
		return refuse("sender", "byte_counter_unavailable");
	if (second.session_bytes_sent <= first.session_bytes_sent)
		return refuse("sender", "no_progress");

	// The engine still runs the session this sender carries.
	if (e.engine !== "streaming") return refuse("engine", `engine_${e.engine}`);
	return { decision: "adopt" };
}

/** Kernel and file reads, injectable so tests never read the host's tables. */
export type SenderAdoptionIo = {
	readonly procRoot: string;
	readonly cgroupRoot: string;
	readonly bootId: () => Promise<string>;
	readonly readLifetime: () => Promise<Lifetime | null>;
	readonly readPublication: () => Promise<Publication | null>;
	readonly readDisk: (lifetime: Lifetime) => Promise<Publication | null>;
	readonly readMarker: () => ArmedStreamMarker | null;
	readonly captureConfig: () => ArmedStreamConfig;
	readonly readStats: (
		controlSocket: string,
	) => Promise<readonly (SenderStats | null)[]>;
	readonly queryEngine: () => Promise<EngineRuntimeState>;
};

/** Gap between the two control reads; the sender's counters move continuously. */
export const SENDER_ADOPTION_READ_GAP_MS = 500;
const CONTROL_TIMEOUT_MS = 500;

async function readTwoStats(
	controlSocket: string,
): Promise<readonly (SenderStats | null)[]> {
	const client = await createControlClient({
		socketPath: controlSocket,
		timeoutMs: CONTROL_TIMEOUT_MS,
	});
	if (!client) return [null, null];
	try {
		const first = await client.getStats();
		await Bun.sleep(SENDER_ADOPTION_READ_GAP_MS);
		const second = await client.getStats();
		return [first, second];
	} catch {
		return [null, null];
	} finally {
		client.close();
	}
}

export function defaultSenderAdoptionIo(
	queryEngine: () => Promise<EngineRuntimeState>,
	captureConfig: () => ArmedStreamConfig,
): SenderAdoptionIo {
	return {
		procRoot: "/proc",
		cgroupRoot: "/sys/fs/cgroup",
		bootId: () => continuityObserverIo.bootId(),
		readLifetime: () =>
			readRecord(
				`${continuityObserverIo.directory}/lifetime.json`,
				lifetimeSchema,
			),
		readPublication: () =>
			readRecord(
				`${continuityObserverIo.directory}/publication.json`,
				publicationSchema,
			),
		readDisk: (lifetime) => readDiskPublication(lifetime),
		readMarker: () => readArmedStreamMarker() ?? null,
		captureConfig,
		readStats: readTwoStats,
		queryEngine,
	};
}

function statFields(stat: string): string[] {
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

async function cgroupMembers(
	cgroupRoot: string,
	cgroup: string,
): Promise<number[] | null> {
	try {
		return (await readFile(`${cgroupRoot}${cgroup}/cgroup.procs`, "utf8"))
			.split("\n")
			.filter((line) => line.length > 0)
			.map(Number);
	} catch {
		return null;
	}
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

/** Everything the kernel says about one PID, or null when it is gone. */
export async function readSenderProcessFacts(
	procRoot: string,
	cgroupRoot: string,
	pid: number,
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
	return {
		pid,
		comm,
		state: fields[0] ?? "",
		processGroup,
		startTime: fields[19] ?? "",
		argsDigest: digest(JSON.stringify(args)),
		cgroup,
		cgroupMembers:
			cgroup === null ? null : await cgroupMembers(cgroupRoot, cgroup),
		groupMembers: Number.isInteger(processGroup)
			? await processGroupMembers(procRoot, processGroup)
			: null,
	};
}

/** Fresh evidence. The sender is only contacted once its process identity holds. */
export async function collectSenderAdoptionEvidence(
	io: SenderAdoptionIo,
): Promise<SenderAdoptionEvidence> {
	const bootId = await io.bootId().catch(() => "");
	const lifetime = await io.readLifetime().catch(() => null);
	const process =
		lifetime?.pid != null
			? await readSenderProcessFacts(io.procRoot, io.cgroupRoot, lifetime.pid)
			: null;
	const identityHolds =
		lifetime !== null &&
		process !== null &&
		lifetime.bootId === bootId &&
		process.startTime === lifetime.startTime &&
		process.comm === "srtla_send";
	const reads = identityHolds
		? await io.readStats(lifetime.controlSocket).catch(() => [null, null])
		: [];
	return {
		bootId,
		lifetime,
		process,
		marker: io.readMarker(),
		currentConfig: io.captureConfig(),
		publication: await io.readPublication().catch(() => null),
		disk: lifetime ? await io.readDisk(lifetime).catch(() => null) : null,
		reads,
		engine: await io.queryEngine().catch(() => "unknown" as const),
	};
}

/** Poll cadence for the exit of a sender that is not our child. */
export const ADOPTED_SENDER_POLL_MS = 500;

export type AdoptedProcessIo = {
	/** The current start time of the PID, or undefined when it is gone or a zombie. */
	readonly startTime: (pid: number) => string | undefined;
	readonly signal: (pid: number, signal: NodeJS.Signals | number) => void;
	readonly poll: (callback: () => void, ms: number) => () => void;
};

function liveStartTime(procRoot: string, pid: number): string | undefined {
	try {
		const fields = statFields(readFileSync(`${procRoot}/${pid}/stat`, "utf8"));
		return NOT_RUNNING_STATES.has(fields[0] ?? "") ? undefined : fields[19];
	} catch {
		return undefined;
	}
}

export function defaultAdoptedProcessIo(procRoot = "/proc"): AdoptedProcessIo {
	return {
		startTime: (pid) => liveStartTime(procRoot, pid),
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
 * for us, so the identity (PID plus start time) is checked again immediately
 * before every signal, and a mismatch marks it exited without signalling. Its
 * exit status cannot be observed; an exit is reported as code -1.
 *
 * Residual window: between that check and the signal the sender could exit and
 * its PID be reused. That needs the whole PID space to wrap within one
 * synchronous step, and a pidfd would close it; Bun does not expose one yet.
 */
export function createAdoptedProcess(
	pid: number,
	startTime: string,
	io: AdoptedProcessIo = defaultAdoptedProcessIo(),
): SupervisedProcess {
	let exitCode: number | null = null;
	const { promise: exited, resolve: resolveExited } =
		Promise.withResolvers<number>();
	const identityHolds = (): boolean => {
		if (exitCode !== null) return false;
		if (io.startTime(pid) === startTime) return true;
		exitCode = -1;
		stopPolling();
		resolveExited(-1);
		return false;
	};
	const stopPolling = io.poll(() => {
		identityHolds();
	}, ADOPTED_SENDER_POLL_MS);
	identityHolds();
	return {
		pid,
		get exitCode() {
			return exitCode;
		},
		signalCode: null,
		exited,
		kill(signal?: NodeJS.Signals | number) {
			if (!identityHolds()) return;
			try {
				io.signal(pid, signal ?? "SIGTERM");
			} catch {
				identityHolds();
			}
		},
	} as SupervisedProcess;
}

type Adoption = {
	readonly pid: number;
	readonly lifetime: string;
	readonly handle: StreamingProcess;
};

/** The adoption this process made, if any. At most one per process. */
let adoption: Adoption | undefined;
let adoptionMade = false;

/**
 * The adopted sender while its own handle is still live and supervised, else
 * undefined. Bound to that handle, so a sender this process spawns later never
 * inherits the adoption's exception to the launch evidence.
 */
export function adoptedSender():
	| { readonly pid: number; readonly lifetime: string }
	| undefined {
	const current = adoption;
	if (current === undefined) return undefined;
	const { proc } = current.handle;
	if (
		proc.exitCode !== null ||
		proc.signalCode !== null ||
		!getStreamingProcesses().includes(current.handle)
	)
		return undefined;
	return { pid: current.pid, lifetime: current.lifetime };
}

/** Test isolation only. */
export function resetSenderAdoptionForTest(): void {
	adoption = undefined;
	adoptionMade = false;
}

export type SenderAdoptionEffects = {
	readonly register: typeof registerAdoptedSender;
	readonly createProcess: (pid: number, startTime: string) => SupervisedProcess;
	readonly continueGeneration: (applied: number) => void;
	readonly attachTelemetry: (
		lifetime: Lifetime,
		publication: Publication,
	) => void;
};

/**
 * Collect, judge and, only on full agreement, take the sender over. Runs once
 * at startup before stream reconciliation, which then finds an owned sender.
 * Never signals, stops or starts anything on a refusal.
 */
export async function attemptSenderAdoption(
	io: SenderAdoptionIo,
	effects: SenderAdoptionEffects,
): Promise<SenderAdoptionVerdict> {
	if (adoptionMade)
		return { decision: "refuse", check: "adoption", reason: "already_adopted" };
	let verdict: SenderAdoptionVerdict;
	let evidence: SenderAdoptionEvidence;
	try {
		evidence = await collectSenderAdoptionEvidence(io);
		verdict = senderAdoptionVerdict(evidence);
	} catch {
		verdict = { decision: "refuse", check: "evidence", reason: "unreadable" };
		logger.info("sender adoption refused", verdict);
		return verdict;
	}
	if (verdict.decision !== "adopt") {
		logger.info("sender adoption refused", verdict);
		return verdict;
	}
	const { lifetime, publication, process } = evidence;
	// The verdict has proven all three; the guards satisfy the type checker.
	if (!lifetime || !publication || !process)
		return { decision: "refuse", check: "evidence", reason: "unreadable" };
	// The handle checks the identity once more as it is made; a sender that
	// exited while the evidence was read is not registered.
	const proc = effects.createProcess(process.pid, process.startTime);
	if (proc.exitCode !== null) {
		verdict = {
			decision: "refuse",
			check: "process",
			reason: "exited_during_adoption",
		};
		logger.info("sender adoption refused", verdict);
		return verdict;
	}
	const handle = effects.register(proc, srtlaSendExec, process.startTime);
	adoptionMade = true;
	adoption = { pid: process.pid, lifetime: lifetime.lifetime, handle };
	void proc.exited.then(() => {
		if (adoption?.handle === handle) adoption = undefined;
	});
	effects.continueGeneration(publication.generation);
	effects.attachTelemetry(lifetime, publication);
	logger.info("sender adopted after restart", {
		pid: process.pid,
		generation: publication.generation,
	});
	return verdict;
}

export const defaultSenderAdoptionEffects: SenderAdoptionEffects = {
	register: registerAdoptedSender,
	createProcess: (pid, startTime) => createAdoptedProcess(pid, startTime),
	continueGeneration: continueBindMapGenerationAbove,
	attachTelemetry: (lifetime) => {
		// Lazy: link telemetry sits further down the streaming graph.
		void (async () => {
			const { startLinkTelemetry } = await import("./link-telemetry.ts");
			const ips = (await readFile(lifetime.ipsFile, "utf8"))
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
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
	const [{ queryEngineRuntimeStreaming }, { captureArmedStreamConfig }] =
		await Promise.all([
			import("./engine-runtime-state.ts"),
			import("./stream-restoration.ts"),
		]);
	return attemptSenderAdoption(
		defaultSenderAdoptionIo(
			queryEngineRuntimeStreaming,
			captureArmedStreamConfig,
		),
		defaultSenderAdoptionEffects,
	);
}
