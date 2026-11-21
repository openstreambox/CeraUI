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
		(process) =>
			process.spawnfile === executable &&
			isLive(process) &&
			process.proc.isCurrent?.() !== false,
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

/** The parent field of `/proc/<pid>/stat`; the name before it may hold spaces. */
function parentPid(stat: string): number | undefined {
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const parent = Number(fields[1]);
	return Number.isInteger(parent) ? parent : undefined;
}

/**
 * Presence of a sender this backend does not own.
 *
 * A matching process is subtracted only when one of our supervised handles
 * (stream session or SRT forwarding) has that exact PID, is still unreaped, and
 * the kernel names this process as its parent (or, for a sender run by its own
 * systemd unit, the handle confirms the process sits in that unit's cgroup).
 * Handle liveness is read after the table: a child that is still unreaped now
 * was unreaped during the scan, so its PID could not have been reused. A stale handle, a reused PID, a foreign
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
		// A sender in its own systemd unit is not our child: its handle proves
		// ownership by the unit's cgroup instead of the parent PID.
		if (handle.proc.owns) {
			if (!isLive(handle) || !handle.proc.owns(pid, procRoot)) return "present";
			continue;
		}
		let parent: number | undefined;
		try {
			parent = parentPid(readFileSync(`${procRoot}/${pid}/stat`, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return "unknown";
		}
		if (!isLive(handle) || parent !== selfPid) return "present";
	}
	return "absent";
}
