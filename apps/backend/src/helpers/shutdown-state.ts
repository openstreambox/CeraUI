/*
 * Process-wide shutdown state shared by the SIGTERM path and the long-lived
 * helpers it has to stop.
 *
 * ceralive.service runs with KillMode=mixed: systemd sends SIGTERM to the main
 * process only and SIGKILLs whatever is still in the cgroup once it exits. So
 * every helper the backend leaves running at exit dies by SIGKILL. This module
 * gives the shutdown path three things:
 *
 *  - a flag set synchronously at the first termination signal, so supervisors
 *    stop respawning and refuse to start new children;
 *  - `terminateChild`, which sends SIGTERM and waits a bounded time for the
 *    child to exit. It never escalates: a child that ignores SIGTERM is left to
 *    the unit's KillMode;
 *  - a registry of work running under a flock guardian, so the shutdown path
 *    can wait for that work to finish before the backend exits and its
 *    guardians are released.
 *
 * Deliberately a leaf module (no imports) so supervisors can depend on it
 * without pulling the shutdown sequence or the logger into their graph.
 */

/** Budget for one helper to exit after SIGTERM before it is left to systemd. */
export const CHILD_STOP_GRACE_MS = 1_000;

/** Budget for guarded work in flight at shutdown to finish on its own. */
export const GUARDED_WORK_GRACE_MS = 10_000;

let started = false;
const guarded = new Set<Promise<void>>();

/** Marks shutdown as begun. Idempotent; never reverts outside tests. */
export function beginShutdown(): void {
	started = true;
}

/** True once a termination signal has started the shutdown sequence. */
export function isShutdownStarted(): boolean {
	return started;
}

/** Test seam: clears the flag and forgets tracked work. */
export function resetShutdownStateForTest(): void {
	started = false;
	guarded.clear();
}

/** The subset of a child process `terminateChild` needs. */
export interface TerminableChild {
	readonly exited: Promise<number>;
	kill(signal?: number): void;
}

const SIGTERM = 15;

/**
 * Send SIGTERM and wait up to `graceMs` for the child to exit. Resolves true
 * when it exited in time, false when it is still running (or kill threw on a
 * child that is already gone, in which case `exited` decides). Never sends
 * SIGKILL: escalation belongs to systemd's stop timeout and KillMode.
 */
export async function terminateChild(
	child: TerminableChild,
	graceMs: number = CHILD_STOP_GRACE_MS,
): Promise<boolean> {
	try {
		child.kill(SIGTERM);
	} catch {
		// Already reaped; the `exited` race below still reports it.
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), graceMs);
	});
	try {
		return await Promise.race([
			child.exited.then(
				() => true as const,
				() => true as const,
			),
			timedOut,
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Register work that runs while a flock guardian holds a lock on its behalf.
 * The returned function marks the work finished; it is idempotent. Shutdown
 * waits for every registered entry (bounded) before the backend exits, so a
 * guardian is never released, by an explicit release or by the backend's
 * death closing its pipe, while the write it protects is still running.
 */
export function holdGuardedWork(): () => void {
	let finish!: () => void;
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	guarded.add(done);
	let finished = false;
	return () => {
		if (finished) return;
		finished = true;
		guarded.delete(done);
		finish();
	};
}

/** Number of guarded entries still running (diagnostics and tests). */
export function pendingGuardedWork(): number {
	return guarded.size;
}

/**
 * Wait until no guarded entry is running, or until `timeoutMs` elapses. Work
 * registered while waiting is waited for too. Resolves true when nothing was
 * left running.
 */
export async function settleGuardedWork(
	timeoutMs: number = GUARDED_WORK_GRACE_MS,
): Promise<boolean> {
	if (guarded.size === 0) return true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), timeoutMs);
	});
	try {
		while (guarded.size > 0) {
			const settled = await Promise.race([
				Promise.all([...guarded]).then(() => true as const),
				timedOut,
			]);
			if (!settled) return false;
		}
		return true;
	} finally {
		clearTimeout(timer);
	}
}
