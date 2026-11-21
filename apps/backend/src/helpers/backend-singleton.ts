import { accessSync, closeSync, constants, openSync } from "node:fs";
import { dirname } from "node:path";
import type { Subprocess } from "bun";
import { OS_STAGE_GUARD_HELPER } from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { BackendSingletonError } from "./backend-singleton-error.ts";
import {
	monitorSingletonPath,
	type SingletonClock,
	singletonClock,
} from "./backend-singleton-monitor.ts";
import {
	singletonArgv,
	singletonHolderPresent,
	singletonLockIdentity,
	singletonPathMatches,
} from "./backend-singleton-proof.ts";
import type { SingletonCensusIO } from "./backend-singleton-qualify.ts";
import { logger } from "./logger.ts";
import { CHILD_STOP_GRACE_MS, waitBounded } from "./shutdown-state.ts";
import { superviseWorker } from "./spawn-policy.ts";

export const BACKEND_SINGLETON_LOCK = "/run/lock/ceralive-backend.lock";

export { BackendSingletonError } from "./backend-singleton-error.ts";

// Production compilation inlines this direct NODE_ENV read; only the exact
// source-development value exempts boot, never runtime mock/device overrides.
export function backendSingletonApplies(
	nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
	return nodeEnv !== "development";
}

export type BackendSingletonLease = {
	readonly exited: Promise<number>;
	[Symbol.asyncDispose](): Promise<void>;
};

let processLease: BackendSingletonLease | undefined;
// Set when the shutdown path asked for a release before any lease existed.
let releaseRequested = false;
// The enforcement still in flight (acquisition plus any late release), so a
// release at shutdown can join it.
let pendingAcquisition: Promise<unknown> | undefined;

/** Fixed production paths; explicit arguments are only an injected I/O seam. */
export async function acquireBackendSingleton(
	paths = { lock: BACKEND_SINGLETON_LOCK, helper: OS_STAGE_GUARD_HELPER },
	clock: SingletonClock = singletonClock,
	censusIO?: SingletonCensusIO,
): Promise<BackendSingletonLease> {
	try {
		closeSync(
			openSync(
				paths.lock,
				constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
				0o600,
			),
		);
	} catch (cause) {
		// Only a directory that genuinely cannot create the lock permits dev boot.
		try {
			accessSync(dirname(paths.lock), constants.W_OK);
		} catch (directoryError) {
			if (
				directoryError instanceof Error &&
				"code" in directoryError &&
				["EACCES", "EROFS", "ENOENT"].includes(String(directoryError.code))
			)
				throw new BackendSingletonError("directory-unavailable", { cause });
		}
		throw new BackendSingletonError("unproven", { cause });
	}
	if (await singletonHolderPresent(paths, undefined, censusIO))
		throw new BackendSingletonError("contended");
	let child: Subprocess<"pipe", "pipe", "pipe"> | undefined;
	const handle = superviseWorker(singletonArgv(paths), {
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
			if (!proc.stdout) throw new BackendSingletonError("unproven");
			const reader = proc.stdout.getReader();
			try {
				const reading = await reader.read();
				if (
					reading.done ||
					new TextDecoder().decode(reading.value) !== "locked\n"
				)
					throw new BackendSingletonError("unproven");
			} finally {
				reader.releaseLock();
			}
		},
	});
	let identity: Awaited<ReturnType<typeof singletonLockIdentity>> = null;
	try {
		await handle.ready;
		if (!child) throw new BackendSingletonError("unproven");
		if (await singletonHolderPresent(paths, child.pid, censusIO))
			throw new BackendSingletonError("contended");
		identity = await singletonLockIdentity(child.pid);
		if (!identity || !(await singletonPathMatches(paths.lock, identity)))
			throw new BackendSingletonError("unproven");
	} catch (cause) {
		await child?.stdin.end();
		await handle.shutdown();
		await child?.exited;
		throw new BackendSingletonError(
			child?.exitCode === 75 ||
				(cause instanceof BackendSingletonError && cause.reason === "contended")
				? "contended"
				: "unproven",
			{ cause },
		);
	}
	const locked = child;
	if (!locked || !identity) throw new BackendSingletonError("unproven");
	const monitor = monitorSingletonPath(paths.lock, identity, clock);
	// Keep draining: a failed helper must never block on an inherited stderr pipe.
	void new Response(locked.stderr).text();
	return {
		exited: Promise.race([
			locked.exited.finally(() => monitor.stop()),
			monitor.lost,
		]),
		async [Symbol.asyncDispose]() {
			monitor.stop();
			locked.stdin.write("release\n");
			await locked.stdin.end();
			await locked.exited;
		},
	};
}

/** Retained until process death, not scoped to the top-level module's evaluation. */
export async function enforceBackendSingleton(
	acquire: () => Promise<BackendSingletonLease> = acquireBackendSingleton,
): Promise<void> {
	const run = enforceOnce(acquire);
	pendingAcquisition = run;
	try {
		await run;
	} finally {
		if (pendingAcquisition === run) pendingAcquisition = undefined;
	}
}

async function enforceOnce(
	acquire: () => Promise<BackendSingletonLease>,
): Promise<void> {
	try {
		const lease = await acquire();
		processLease = lease;
		// SIGTERM landed while the guardian was coming up and the shutdown path
		// already reached its release step: release it now instead of leaving it.
		if (releaseRequested) {
			await releaseBackendSingleton();
			return;
		}
		void lease.exited.then(() => {
			if (processLease !== lease) return;
			logger.error("Backend singleton lock lost; refusing to continue");
			process.exit(1);
		});
	} catch (error) {
		if (
			error instanceof BackendSingletonError &&
			error.reason === "directory-unavailable"
		) {
			logger.warn(
				"Backend singleton lock directory unavailable; continuing without exclusivity",
				{ error },
			);
			return;
		}
		logger.error(
			"Backend singleton acquisition failed; another instance may be running",
			{ error },
		);
		throw error;
	}
}

/** Test seam: forget a release requested before any lease existed. */
export function resetBackendSingletonReleaseForTest(): void {
	releaseRequested = false;
}

/**
 * Shutdown: release the singleton guardian explicitly instead of leaving its
 * flock child for systemd to SIGKILL after the backend exits. Called last in
 * the shutdown sequence, once teardown and guarded work are done, because the
 * lock is what keeps a restarted backend from writing beside this one.
 * Bounded: a guardian that does not exit in time is left to the unit.
 */
export async function releaseBackendSingleton(
	graceMs: number = CHILD_STOP_GRACE_MS * 2,
): Promise<void> {
	if (!processLease) {
		releaseRequested = true;
		// Acquisition still running (boot-time SIGTERM): join it within the same
		// bound. The joined promise includes the late release enforcement runs
		// when it sees this request, so exit cannot overtake that release.
		const acquiring = pendingAcquisition;
		if (acquiring && !(await waitBounded(acquiring, graceMs)))
			logger.warn("Backend singleton acquisition still running at shutdown");
		return;
	}
	const lease = processLease;
	// Detach first so the expected guardian exit is not read as a lost lock.
	processLease = undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), graceMs);
	});
	try {
		const outcome = await Promise.race([
			lease[Symbol.asyncDispose]().then(() => "released" as const),
			timedOut,
		]);
		if (outcome === "timeout")
			logger.warn("Backend singleton guardian did not exit after release");
	} finally {
		clearTimeout(timer);
	}
}
