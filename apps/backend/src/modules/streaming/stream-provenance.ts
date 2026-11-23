/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Which engine session this backend's Start opened, kept in `/run` so a
 * restarted backend can recognise its predecessor's session and nothing else.
 *
 * A backend restart mid-stream ends the sender (it is this process's child,
 * and the unit kills its control group) but not the engine session, and the
 * stream's OTA marker stays behind. The record names that session (the
 * engine's `session_id`, which is only a per-process counter, so together
 * with the engine process) and the sender that carried it. A later process
 * may stop the session only when the engine still reports exactly that
 * session from exactly that process and nothing can carry it any more. Any
 * missing or mismatching piece leaves the session to an operator Stop.
 *
 * The record is written after the engine acknowledged a Start this process
 * committed, and removed when the session is confirmed idle. A crash between
 * the two leaves no record, which only means no automatic Stop.
 */

import fs from "node:fs";
import { z } from "zod";
import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import { run } from "../../helpers/run.ts";
import { readSystemBootId } from "./armed-stream-marker.ts";
import { SRTLA_LISTEN_PORT } from "./constants.ts";
import { ENGINE_UNIT } from "./engine-unit-state.ts";
import {
	ownedSessionProcessesRemain,
	senderCensus,
	senderCensusProcRoot,
} from "./sender-ownership.ts";

export function streamProvenancePath(): string {
	return (
		process.env.CERALIVE_STREAM_PROVENANCE ??
		"/run/ceralive/stream-session.json"
	);
}

/**
 * Whether a later process may STOP an earlier process's session by itself.
 * Off unless `CERALIVE_STOP_ORPHANED_SESSIONS=1`: the engine's `stop` takes no
 * session, so between the last check and the engine executing the stop a
 * replacement session or a new carrier could still appear. Settling a session
 * the engine already ended (`gone`) needs no stop and is not behind this flag.
 */
export function orphanStopEnabled(): boolean {
	return process.env.CERALIVE_STOP_ORPHANED_SESSIONS === "1";
}

const processIdentity = z.strictObject({
	pid: z.number().int().positive(),
	startTime: z.string().regex(/^\d+$/),
});
export type ProcessIdentity = z.infer<typeof processIdentity>;

const provenanceSchema = z.strictObject({
	version: z.literal(2),
	bootId: z.string().min(1),
	sessionId: z.string().min(1),
	engine: processIdentity,
	sender: processIdentity,
	/** The local UDP port the session sends to, where its sender listened. */
	port: z.number().int().min(1).max(65_535),
});
export type StreamProvenance = z.infer<typeof provenanceSchema>;

export function readStreamProvenance(
	path = streamProvenancePath(),
): StreamProvenance | undefined {
	try {
		const parsed = provenanceSchema.safeParse(
			JSON.parse(fs.readFileSync(path, "utf8")),
		);
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

export const STREAM_PROVENANCE_MODE = 0o600;

export function writeStreamProvenance(
	record: StreamProvenance,
	path = streamProvenancePath(),
): void {
	writeFileAtomicSync(path, `${JSON.stringify(record)}\n`, {
		mode: STREAM_PROVENANCE_MODE,
	});
}

export function clearStreamProvenance(path = streamProvenancePath()): void {
	try {
		fs.rmSync(path, { force: true });
	} catch {
		// A record that cannot be removed only names a session that ended; the
		// next process still checks the engine before it acts on it.
	}
}

/** Field 22 of `/proc/<pid>/stat`, the start time in clock ticks since boot. */
export function processStartTime(
	pid: number,
	procRoot = senderCensusProcRoot(),
): string | undefined {
	try {
		const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const start = fields[19];
		return start !== undefined && /^\d+$/.test(start) ? start : undefined;
	} catch {
		return undefined;
	}
}

/** Same PID and the same start time: the same process, not a reused PID. */
export function processRuns(
	identity: ProcessIdentity,
	procRoot = senderCensusProcRoot(),
): boolean {
	return processStartTime(identity.pid, procRoot) === identity.startTime;
}

/**
 * Whether any socket is bound to `port` in the network namespace whose
 * `net/udp` and `net/udp6` tables sit under `netRoot` (`/proc` for this
 * process, `/proc/<pid>` for another's). Undefined when a table cannot be read.
 */
export function localSenderPortBound(
	netRoot = senderCensusProcRoot(),
	port = SRTLA_LISTEN_PORT,
): boolean | undefined {
	const hex = port.toString(16).toUpperCase().padStart(4, "0");
	let bound = false;
	for (const table of ["udp", "udp6"]) {
		let text: string;
		try {
			text = fs.readFileSync(`${netRoot}/net/${table}`, "utf8");
		} catch {
			return undefined;
		}
		for (const row of text.split("\n").slice(1)) {
			const local = row.trim().split(/\s+/)[1];
			if (local?.split(":")[1]?.toUpperCase() === hex) bound = true;
		}
	}
	return bound;
}

/**
 * Nothing can carry the recorded session: its sender process is gone (by PID
 * and start time), no process named `srtla_send` runs, no child of this
 * backend's session remains, and nothing holds the recorded port, neither in
 * this process's network namespace nor, while the recorded engine process still
 * runs, in the engine's, where its packets go.
 * That also covers a sender under another name. Unreadable evidence is not
 * absence. Limits: a carrier on another port, or in a third namespace the
 * engine's loopback cannot reach, is not looked for, because it cannot
 * receive what the engine sends to its own `127.0.0.1:<port>`.
 */
export function carrierAbsent(
	record: StreamProvenance,
	procRoot = senderCensusProcRoot(),
	ownedRemain: () => boolean = ownedSessionProcessesRemain,
): boolean {
	return (
		!processRuns(record.sender, procRoot) &&
		senderCensus(procRoot) === "absent" &&
		!ownedRemain() &&
		localSenderPortBound(procRoot, record.port) === false &&
		// The engine's namespace, while the recorded engine process still runs.
		// Once it has exited (an engine restart), nothing it sent can arrive.
		(!processRuns(record.engine, procRoot) ||
			localSenderPortBound(`${procRoot}/${record.engine.pid}`, record.port) ===
				false)
	);
}

/** The engine unit's main process, or undefined when systemd cannot say. */
export async function engineProcess(
	procRoot = senderCensusProcRoot(),
	show: () => Promise<string> = () =>
		run("systemctl", ["show", ENGINE_UNIT, "--property=MainPID"], {
			timeout: 3_000,
			maxBuffer: 1024,
		}),
): Promise<ProcessIdentity | undefined> {
	try {
		const match = /^MainPID=(\d+)$/m.exec(await show());
		const pid = Number(match?.[1]);
		if (!Number.isInteger(pid) || pid <= 0) return undefined;
		const startTime = processStartTime(pid, procRoot);
		return startTime === undefined ? undefined : { pid, startTime };
	} catch {
		return undefined;
	}
}

const sameProcess = (
	a: ProcessIdentity | undefined,
	b: ProcessIdentity,
): boolean => a !== undefined && a.pid === b.pid && a.startTime === b.startTime;

export type OrphanOutcome = "stopped" | "gone" | "refused";

export type OrphanRetirementDeps = {
	readonly readRecord: () => StreamProvenance | undefined;
	readonly bootId: () => string | undefined;
	readonly carrierAbsent: (record: StreamProvenance) => boolean;
	readonly engineProcess: () => Promise<ProcessIdentity | undefined>;
	/** A valid snapshot with no session id, no active input and no targets. */
	readonly engineReportsNoSession: () => Promise<boolean>;
	readonly stopEnabled: () => boolean;
	readonly stopRecordedSession:
		| ((
				sessionId: string,
				beforeDispatch: () => boolean,
				afterSnapshot: () => Promise<boolean>,
		  ) => Promise<boolean>)
		| undefined;
};

/**
 * Decide, and for a live session act, on a session an earlier backend process
 * of this boot left, only on that process's record of it.
 *
 * `silent`: the engine answered and sent no status. If a fresh snapshot is a
 * valid answer naming no session, the recorded session has ended (`gone`) and
 * no Stop is needed.
 *
 * `streaming`: the engine reports a session this process cannot confirm. Only
 * with the stop enabled, and only for the recorded engine process (sampled
 * before the connection and again after its snapshot), the recorded
 * `session_id` in that snapshot, and no carrier, checked again in the tick the
 * stop is written. The engine's `stop` is still unconditional on its side, so
 * this stays off by default.
 *
 * Everything else is `refused` and changes nothing.
 */
export async function retireOrphanedSession(
	engine: "streaming" | "silent",
	deps: OrphanRetirementDeps,
): Promise<OrphanOutcome> {
	const record = deps.readRecord();
	if (record === undefined || record.bootId !== deps.bootId()) return "refused";
	if (!deps.carrierAbsent(record)) return "refused";
	if (engine === "silent")
		return (await deps.engineReportsNoSession()) ? "gone" : "refused";
	if (!deps.stopEnabled() || deps.stopRecordedSession === undefined)
		return "refused";
	if (!sameProcess(await deps.engineProcess(), record.engine)) return "refused";
	return (await deps.stopRecordedSession(
		record.sessionId,
		() => deps.carrierAbsent(record),
		async () => sameProcess(await deps.engineProcess(), record.engine),
	))
		? "stopped"
		: "refused";
}

/**
 * What the production paths read about processes and the boot. Tests replace
 * them so a host's systemd and process table are never consulted.
 */
export type ProvenanceProbes = {
	readonly engineProcess: () => Promise<ProcessIdentity | undefined>;
	readonly bootId: () => string | undefined;
	readonly processStartTime: (pid: number) => string | undefined;
};
const hostProbes: ProvenanceProbes = {
	engineProcess: () => engineProcess(),
	bootId: () => readSystemBootId(),
	processStartTime: (pid) => processStartTime(pid),
};
let probes: ProvenanceProbes = hostProbes;
export function provenanceProbes(): ProvenanceProbes {
	return probes;
}
export function setProvenanceProbesForTest(
	overrides: Partial<ProvenanceProbes> | null,
): void {
	probes = overrides === null ? hostProbes : { ...hostProbes, ...overrides };
}

export const defaultOrphanRetirementDeps = (backend: {
	readonly stopRecordedSession?: OrphanRetirementDeps["stopRecordedSession"];
	readonly engineReportsNoSession?: () => Promise<boolean>;
}): OrphanRetirementDeps => ({
	readRecord: () => readStreamProvenance(),
	bootId: () => probes.bootId(),
	carrierAbsent: (record) => carrierAbsent(record),
	engineProcess: () => probes.engineProcess(),
	engineReportsNoSession: async () =>
		(await backend.engineReportsNoSession?.()) === true,
	stopEnabled: orphanStopEnabled,
	stopRecordedSession: backend.stopRecordedSession,
});

/**
 * Write the record for the session this process just committed. Every piece
 * must be known: the engine's session id from our Start, the engine and sender
 * processes by PID and start time, the port and the boot, and the session must
 * still be ours after the engine was sampled. Otherwise nothing is written,
 * which only means a later process will not settle the session by itself.
 */
export async function recordLaunchedSession(deps: {
	readonly sessionId: () => string | undefined;
	readonly senderPid: () => number | undefined;
	readonly bootId: () => string | undefined;
	readonly port: number;
	readonly engineProcess: () => Promise<ProcessIdentity | undefined>;
	readonly processStartTime: (pid: number) => string | undefined;
	readonly current: () => boolean;
	readonly write: (record: StreamProvenance) => void;
}): Promise<boolean> {
	const sessionId = deps.sessionId();
	const senderPid = deps.senderPid();
	const bootId = deps.bootId();
	if (sessionId === undefined || senderPid === undefined || !bootId)
		return false;
	const senderStart = deps.processStartTime(senderPid);
	const engine = await deps.engineProcess();
	if (
		senderStart === undefined ||
		engine === undefined ||
		!deps.current() ||
		deps.sessionId() !== sessionId ||
		deps.processStartTime(senderPid) !== senderStart
	)
		return false;
	deps.write({
		version: 2,
		bootId,
		sessionId,
		engine,
		sender: { pid: senderPid, startTime: senderStart },
		port: deps.port,
	});
	return true;
}
