import { readdirSync, readFileSync } from "node:fs";
import { srtlaSendExec } from "./streamloop/exec-paths.ts";
import {
	getOwnedProcessHandles,
	getStreamingProcesses,
	type StreamingProcess,
} from "./streamloop/process-runner.ts";

export type SenderCensus = "absent" | "present" | "unknown";

function isLive({ proc }: StreamingProcess): boolean {
	return proc.exitCode === null && proc.signalCode === null;
}

/** Live child handles cannot be replaced by a reused PID before Bun reaps them. */
export function ownsSessionSender(
	processes: ReadonlyArray<StreamingProcess> = getStreamingProcesses(),
	executable = srtlaSendExec,
): boolean {
	return processes.some(
		(process) => process.spawnfile === executable && isLive(process),
	);
}

/** A live stream-session child remains; forwarding children are not counted. */
export function ownedSessionProcessesRemain(
	processes: ReadonlyArray<StreamingProcess> = getStreamingProcesses(),
): boolean {
	return processes.some(isLive);
}

/**
 * The process table the census reads. Production reads the kernel's `/proc`;
 * the test preload points this at an empty private directory so ordinary unit
 * tests never observe processes running on the host.
 */
export function senderCensusProcRoot(): string {
	return process.env.CERALIVE_SENDER_CENSUS_PROC_ROOT ?? "/proc";
}

/** Process ids named `srtla_send`, or undefined when the table is unreadable. */
function senderPids(procRoot: string): number[] | undefined {
	const pids: number[] = [];
	try {
		for (const pid of readdirSync(procRoot)) {
			if (!/^\d+$/.test(pid)) continue;
			try {
				if (
					readFileSync(`${procRoot}/${pid}/comm`, "utf8").trim() ===
					"srtla_send"
				)
					pids.push(Number(pid));
			} catch (error) {
				// A process can exit between enumeration and read. Other failures are unknown.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT")
					return undefined;
			}
		}
	} catch {
		return undefined;
	}
	return pids;
}

/** Presence is only a safety interlock, never proof of identity or media flow. */
export function senderCensus(procRoot = senderCensusProcRoot()): SenderCensus {
	const pids = senderPids(procRoot);
	if (pids === undefined) return "unknown";
	return pids.length > 0 ? "present" : "absent";
}

/** Fields of `/proc/<pid>/stat` after the name, which may hold spaces. */
function statFields(stat: string): string[] {
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

/** The parent field of `/proc/<pid>/stat`. */
function parentPid(stat: string): number | undefined {
	const parent = Number(statFields(stat)[1]);
	return Number.isInteger(parent) ? parent : undefined;
}

/**
 * Whether a supervised handle owns the row it was matched to. A child must
 * name this process as its parent; a hosted sender (its own unit, not our
 * child) must have the start time recorded when it was pinned and a pidfd
 * that still says it is alive.
 */
function ownsRow(
	handle: StreamingProcess,
	stat: string,
	selfPid: number,
): boolean {
	if (handle.hosted === undefined) return parentPid(stat) === selfPid;
	return (
		statFields(stat)[19] === handle.hosted.startTime &&
		handle.hosted.pin.alive() === true
	);
}

/**
 * Presence of a sender this backend does not own.
 *
 * A matching process is subtracted only when one of our supervised handles
 * (stream session or SRT forwarding) has that exact PID, is still unreaped, and
 * the kernel names this process as its parent. Handle liveness is read after
 * the table: a child that is still unreaped now was unreaped during the scan, so
 * its PID could not have been reused. A hosted sender is subtracted only by its
 * recorded start time and a live pidfd. A stale handle, a reused PID, a foreign
 * parent or an unreadable row keeps the census conservative. Names alone never
 * make a sender owned.
 */
export function unownedSenderCensus(
	owned: ReadonlyArray<StreamingProcess> = getOwnedProcessHandles(),
	procRoot = senderCensusProcRoot(),
	selfPid = process.pid,
): SenderCensus {
	const pids = senderPids(procRoot);
	if (pids === undefined) return "unknown";
	for (const pid of pids) {
		const handle = owned.find(({ proc }) => proc.pid === pid);
		if (handle === undefined) return "present";
		let stat: string;
		try {
			stat = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return "unknown";
		}
		if (!isLive(handle) || !ownsRow(handle, stat, selfPid)) return "present";
	}
	return "absent";
}
