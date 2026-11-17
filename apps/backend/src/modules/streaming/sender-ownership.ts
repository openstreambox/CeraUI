import { readdirSync, readFileSync } from "node:fs";
import { srtlaSendExec } from "./streamloop/exec-paths.ts";
import {
	getStreamingProcesses,
	type StreamingProcess,
} from "./streamloop/process-runner.ts";

/** Live child handles cannot be replaced by a reused PID before Bun reaps them. */
export function ownsSessionSender(
	processes: ReadonlyArray<StreamingProcess> = getStreamingProcesses(),
	executable = srtlaSendExec,
): boolean {
	return processes.some(
		({ spawnfile, proc }) =>
			spawnfile === executable &&
			proc.exitCode === null &&
			proc.signalCode === null,
	);
}

/** Presence is only a safety interlock, never proof of identity or media flow. */
export function senderCensus(
	procRoot = "/proc",
): "absent" | "present" | "unknown" {
	try {
		for (const pid of readdirSync(procRoot)) {
			if (!/^\d+$/.test(pid)) continue;
			try {
				if (
					readFileSync(`${procRoot}/${pid}/comm`, "utf8").trim() ===
					"srtla_send"
				)
					return "present";
			} catch (error) {
				// A process can exit between enumeration and read. Other failures are unknown.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT")
					return "unknown";
			}
		}
		return "absent";
	} catch {
		return "unknown";
	}
}
