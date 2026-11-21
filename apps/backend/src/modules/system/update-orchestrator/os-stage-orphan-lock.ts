import type { Subprocess } from "bun";
import {
	admitGuardedWork,
	isShutdownStarted,
} from "../../../helpers/shutdown-state.ts";
import { superviseWorker } from "../../../helpers/spawn-policy.ts";
import { SOFTWARE_UPDATE_LOCK } from "./lock.ts";
import { OsStageError, type OsStageFailureReason } from "./os-stage-error.ts";
import { OS_STAGE_GUARD_HELPER } from "./os-stage-job-files.ts";

export type OsOrphanLock = {
	readonly pid?: string;
	held(): boolean;
	[Symbol.asyncDispose](): Promise<void>;
};

export async function acquireOsOrphanLock(
	paths = { lock: SOFTWARE_UPDATE_LOCK, helper: OS_STAGE_GUARD_HELPER },
	contended: OsStageFailureReason = "rauc_recovery_unproven",
): Promise<OsOrphanLock> {
	// Admitted before the guardian is spawned, so a SIGTERM during acquisition
	// waits for it. Refused once shutdown began: the caller sees ordinary
	// contention and retries on a later boot, never a new protected write.
	const finished = admitGuardedWork();
	if (!finished) throw new OsStageError(contended);
	try {
		return await acquireAdmitted(paths, contended, finished);
	} catch (error) {
		finished();
		throw error;
	}
}

async function acquireAdmitted(
	paths: { lock: string; helper: string },
	contended: OsStageFailureReason,
	finished: () => void,
): Promise<OsOrphanLock> {
	let child: Subprocess<"pipe", "pipe", "pipe"> | undefined;
	const handle = superviseWorker(
		[
			"/usr/bin/flock",
			"-n",
			"-E",
			"75",
			"-x",
			paths.lock,
			paths.helper,
			"--orphan-lock",
		],
		{
			startupTimeoutMs: 2_000,
			spawn: (argv) => {
				child = Bun.spawn(argv, {
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				});
				return child;
			},
			waitForReady: async (proc) => {
				if (!proc.stdout) throw new OsStageError("rauc_recovery_unproven");
				const reader = proc.stdout.getReader();
				try {
					const reading = await reader.read();
					if (
						reading.done ||
						new TextDecoder().decode(reading.value) !== "locked\n"
					)
						throw new OsStageError("rauc_recovery_unproven");
				} finally {
					reader.releaseLock();
				}
			},
		},
	);
	try {
		await handle.ready;
	} catch (cause) {
		await child?.stdin.end();
		await handle.shutdown();
		await child?.exited;
		// flock -E 75 reports actual contention; every other failure stays unproven.
		const reason =
			child?.exitCode === 75 ? contended : "rauc_recovery_unproven";
		throw new OsStageError(reason, { cause });
	}
	const locked = child;
	if (!locked) throw new OsStageError("rauc_recovery_unproven");
	// Shutdown began while the guardian was coming up: release it before the
	// lease is exposed, so no protected write starts after the signal.
	if (isShutdownStarted()) {
		locked.stdin.write("release\n");
		await locked.stdin.end();
		await new Response(locked.stderr).text();
		await locked.exited;
		throw new OsStageError(contended);
	}
	// The work done under this lock stays guarded until its owner disposes the
	// lease, not until the helper exits: a helper that dies mid-scope must not
	// let shutdown exit before the owner has observed the loss and settled.
	return {
		pid: String(locked.pid),
		held: () => locked.exitCode === null && locked.signalCode === null,
		async [Symbol.asyncDispose]() {
			try {
				locked.stdin.write("release\n");
				await locked.stdin.end();
				await new Response(locked.stderr).text();
				if ((await locked.exited) !== 0)
					throw new OsStageError("rauc_recovery_unproven");
			} finally {
				finished();
			}
		},
	};
}
