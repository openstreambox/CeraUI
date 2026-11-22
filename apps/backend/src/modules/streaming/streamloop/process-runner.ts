/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2025 CeraLive project


    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

// Process supervision layer: owns the list of running stream subprocesses and
// the Bun.spawn lifecycle. This is the SOLE owner of the `streamingProcesses`
// state — every other module reaches it through the exported helpers so the
// mutable list never leaks across module boundaries.

import { logger } from "../../../helpers/logger.ts";
import { periodicCheckForSoftwareUpdates } from "../../system/software-updates.ts";
import {
	SHUTDOWN_SIGKILL_TIMEOUT_MS,
	SHUTDOWN_SIGTERM_GRACE_MS,
} from "../constants.ts";
import {
	broadcastHealthIfChanged,
	reportStreamProcessExit,
} from "../health.ts";
import { stopLinkTelemetry } from "../link-telemetry.ts";
import { updateStatus } from "../streaming.ts";
import type { HostedSender, OutputFollowers } from "./sender-host.ts";
import { captureSenderOutput } from "./sender-output.ts";

// Bun.Subprocess is not an EventEmitter, so the exit lifecycle is modeled here:
// `exitListeners` replaces .on("exit")/.removeAllListeners("exit") and fires once
// when `proc.exited` resolves; `spawnfile` replaces ChildProcess.spawnfile.
export type StreamingProcess = {
	proc: SupervisedProcess;
	spawnfile: string;
	exitListeners: Array<() => void>;
	/**
	 * Set only for a sender in its own systemd unit (`sender-host.ts`), spawned
	 * by this backend or adopted from its predecessor. It is not our child, so
	 * its PID can pass to another process once it exits: ownership checks
	 * compare its start time and its pidfd instead of the parent PID, and every
	 * signal goes through that pidfd.
	 */
	hosted?: HostedSender;
	/** Stops a hosted sender's output followers. */
	stopOutput?: () => void;
};

/**
 * The part of a process handle supervision uses. A spawned child is a
 * `Bun.Subprocess`; a hosted sender is a handle over a pidfd.
 */
export type SupervisedProcess = Pick<
	Bun.Subprocess<"inherit", "inherit" | "pipe", "pipe">,
	"pid" | "exitCode" | "signalCode" | "exited" | "kill"
>;

const forwardProcesses: Array<StreamingProcess> = [];

export function spawnForwardLoop(
	command: string,
	args: string[],
	errCallback: (data: string) => void,
): StreamingProcess {
	return spawnStreamingLoop(command, args, errCallback, forwardProcesses);
}

let streamingProcesses: Array<StreamingProcess> = [];

// Live view of the supervised processes. Returned by reference so callers see
// removals as they happen; never reassigned by callers — mutation goes through
// the helpers below.
export function getStreamingProcesses(): Array<StreamingProcess> {
	return streamingProcesses;
}

/**
 * Every child this backend supervises: the stream session and SRT forwarding.
 * The sender census subtracts these by process id, never by name.
 */
export function getOwnedProcessHandles(): ReadonlyArray<StreamingProcess> {
	return [...streamingProcesses, ...forwardProcesses];
}

export function spawnStreamingLoop(
	launch: string | { readonly command: string; readonly role: "srtla_send" },
	args: Array<string>,
	errCallback: (data: string) => void,
	registry = streamingProcesses,
): StreamingProcess {
	const command = typeof launch === "string" ? launch : launch.command;
	const sender = typeof launch !== "string" && launch.role === "srtla_send";
	const proc = Bun.spawn([command, ...args], {
		stdin: "inherit",
		stdout: sender ? "pipe" : "inherit",
		stderr: "pipe",
		...(sender ? { env: { ...process.env, NO_COLOR: "1" } } : {}),
	});

	const streamingProcess: StreamingProcess = {
		proc,
		spawnfile: command,
		exitListeners: [],
	};
	registry.push(streamingProcess);

	if (proc.stdout) {
		void captureSenderOutput(
			{ stdout: proc.stdout, stderr: proc.stderr },
			errCallback,
		);
	} else {
		// Drain stderr by async iteration: chunks arrive in order, matching the
		// previous stderr.on("data") delivery. Each chunk is decoded on its own,
		// preserving the per-chunk pattern matching the errCallback relies on.
		void (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of proc.stderr) {
				const dataStr = decoder.decode(chunk);
				if (registry !== forwardProcesses)
					logger.debug(`${streamingProcess.spawnfile} stderr: ${dataStr}`);
				errCallback(dataStr);
			}
		})().catch((err) => {
			// stderr is torn down when the process is killed; that surfaces here
			// as a benign cancellation, not a subprocess error to report.
			logger.debug(`${streamingProcess.spawnfile} stderr drain ended`, { err });
		});
	}

	superviseExit(streamingProcess, registry, sender);
	return streamingProcess;
}

/**
 * Supervise a sender that runs in its own unit: one this backend launched with
 * the takeover flag, or one it adopted from its predecessor. From here on it is
 * handled exactly like a spawned sender (ownership, census, reload, Stop and
 * the exit report) through its pidfd-backed handle. Graceful shutdown leaves it
 * running for the next backend.
 */
export function registerHostedSender(
	sender: HostedSender,
	command: string,
	errCallback: (data: string) => void,
	followers: OutputFollowers | null,
): StreamingProcess {
	const streamingProcess: StreamingProcess = {
		proc: sender as unknown as SupervisedProcess,
		spawnfile: command,
		exitListeners: [],
		hosted: sender,
	};
	streamingProcesses.push(streamingProcess);
	if (followers) {
		streamingProcess.stopOutput = () => followers.stop();
		void sender.exited.then(() => followers.stop());
		void captureSenderOutput(
			{ stdout: followers.stdout, stderr: followers.stderr },
			errCallback,
		);
	}
	superviseExit(streamingProcess, streamingProcesses, true);
	return streamingProcess;
}

function superviseExit(
	streamingProcess: StreamingProcess,
	registry: Array<StreamingProcess>,
	sender: boolean,
): void {
	// proc.exited resolves once; run whatever exit listeners are registered at
	// that moment (mirrors a one-shot EventEmitter "exit").
	streamingProcess.proc.exited.then(() => {
		for (const listener of [...streamingProcess.exitListeners]) {
			listener();
		}
	});

	// ADR-0005: systemd is the SOLE process-restart authority. The app must
	// observe-and-notify only — it logs the exit and updates the health state,
	// but never respawns the process (that would create a dual restart authority
	// racing systemd's Restart=on-failure).
	streamingProcess.exitListeners.push(() => {
		if (registry === forwardProcesses) {
			removeProc(streamingProcess);
			return;
		}
		const { exitCode, signalCode } = streamingProcess.proc;
		logger.warn(
			`streamloop: ${streamingProcess.spawnfile} exited (code=${
				exitCode ?? "null"
			}, signal=${
				signalCode ?? "null"
			}); not respawning — systemd owns process restart (ADR-0005)`,
			// The same facts as typed fields, which support downloads keep.
			{
				process: streamingProcess.spawnfile,
				exitCode: exitCode ?? null,
				signal: signalCode ?? null,
			},
		);
		// remove the dead process from the supervised list
		removeProc(streamingProcess);
		// srtla_send is the telemetry producer; its exit ends the stats stream.
		if (sender) {
			stopLinkTelemetry();
		}
		// notify health state: the stream is now dead until systemd respawns it
		reportStreamProcessExit();
		broadcastHealthIfChanged();
	});
}

function isSenderProcess(streamingProcess: StreamingProcess): boolean {
	return streamingProcess.spawnfile.endsWith("srtla_send");
}

/**
 * Signal every live sender this backend supervises, by its own process handle.
 *
 * This replaces signalling by process name for the bond reload: another process
 * that happens to be called `srtla_send` (a second sender, a diagnostic run, a
 * sender another backend should adopt) is never touched. A handle whose process
 * has exited is skipped rather than signalled; until Bun has reaped the child its
 * PID cannot be reused, and reaping and this check run on the same thread.
 *
 * Returns how many senders the signal was delivered to; zero means the reload
 * did not reach any supervised sender and the caller must treat it as failed.
 */
export function signalSenders(
	signal: NodeJS.Signals,
	procs: ReadonlyArray<StreamingProcess> = streamingProcesses,
): number {
	let delivered = 0;
	for (const sp of procs) {
		if (!isSenderProcess(sp) || !isProcAlive(sp)) continue;
		try {
			// A hosted sender counts only when its pidfd confirms delivery.
			if (sp.hosted) {
				if (sp.hosted.signal(signal) === true) delivered++;
				continue;
			}
			sp.proc.kill(signal);
			delivered++;
		} catch (err) {
			logger.warn(`signalSenders: ${signal} to ${sp.spawnfile} failed`, {
				err,
			});
		}
	}
	return delivered;
}

function removeProc(streamingProcess: StreamingProcess) {
	const index = forwardProcesses.indexOf(streamingProcess);
	if (index >= 0) forwardProcesses.splice(index, 1);
	streamingProcesses = streamingProcesses.filter((p) => p !== streamingProcess);
}

export function stopProcess(streamingProcess: StreamingProcess) {
	streamingProcess.exitListeners = [];
	streamingProcess.exitListeners.push(() => {
		removeProc(streamingProcess);
	});

	if (
		streamingProcess.proc.exitCode === null &&
		streamingProcess.proc.signalCode === null
	) {
		streamingProcess.proc.kill("SIGTERM");
		return false;
	}

	removeProc(streamingProcess);
	return true;
}

export async function stopProcessAndWait(
	streamingProcess: StreamingProcess,
	escalationMs: number = SHUTDOWN_SIGKILL_TIMEOUT_MS,
): Promise<void> {
	if (stopProcess(streamingProcess)) return;
	let killTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
	try {
		await Promise.race([
			streamingProcess.proc.exited.then(() => undefined),
			new Promise<void>((resolve) => {
				killTimer = globalThis.setTimeout(() => {
					if (
						streamingProcess.proc.exitCode === null &&
						streamingProcess.proc.signalCode === null
					) {
						streamingProcess.proc.kill("SIGKILL");
					}
					resolve();
				}, escalationMs);
			}),
		]);
		if (streamingProcess.hosted) {
			await stopHostedBounded(streamingProcess.hosted, escalationMs);
			return;
		}
		await streamingProcess.proc.exited;
	} finally {
		if (killTimer !== undefined) globalThis.clearTimeout(killTimer);
	}
}

/** Whether `promise` settles within `ms`. */
async function settlesWithin(
	promise: Promise<unknown>,
	ms: number,
): Promise<boolean> {
	let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<boolean>((resolve) => {
				timer = globalThis.setTimeout(() => resolve(false), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) globalThis.clearTimeout(timer);
	}
}

/**
 * A hosted sender whose pidfd never confirms the exit after TERM and KILL:
 * ask systemd to stop its unit (bounded), look again, and if the exit is
 * still not confirmed, fail the stop instead of waiting forever. Unknown is
 * never taken as exited.
 */
async function stopHostedBounded(
	hosted: HostedSender,
	ms: number,
): Promise<void> {
	if (await settlesWithin(hosted.exited, ms)) return;
	const outcome = await hosted.stopUnit().catch(() => "failed" as const);
	hosted.refresh();
	if (hosted.exitCode !== null) return;
	if (
		(outcome === "stopped" || outcome === "absent") &&
		(await settlesWithin(hosted.exited, ms))
	)
		return;
	logger.warn("stop: the hosted sender's exit is not confirmed", {
		unit: hosted.unit,
		outcome,
	});
	throw new Error("hosted_sender_stop_unconfirmed");
}

/**
 * Drop a hosted sender from supervision without signalling it: a takeover
 * that rolls back hands the sender to systemd, which stops its unit by name.
 */
export function forgetHostedSender(sender: HostedSender): void {
	for (const streamingProcess of [...streamingProcesses]) {
		if (streamingProcess.hosted !== sender) continue;
		streamingProcess.exitListeners = [];
		streamingProcess.stopOutput?.();
		removeProc(streamingProcess);
	}
	sender.release();
}

const stopCheckInterval = 50;
let shutdownStartTime: number | null = null;

function waitForAllProcessesToTerminate() {
	if (streamingProcesses.length === 0) {
		logger.info("stop: all processes terminated");
		updateStatus(false);
		stopLinkTelemetry();
		shutdownStartTime = null;

		periodicCheckForSoftwareUpdates();
		return;
	}

	// Initialize shutdown timer on first call
	if (shutdownStartTime === null) {
		shutdownStartTime = Date.now();
	}

	const elapsedMs = Date.now() - shutdownStartTime;

	// If timeout exceeded, SIGKILL remaining processes
	if (elapsedMs >= SHUTDOWN_SIGKILL_TIMEOUT_MS) {
		const killedProcesses = [...streamingProcesses];
		for (const p of killedProcesses) {
			logger.warn(
				`stop: SIGKILL timeout (${SHUTDOWN_SIGKILL_TIMEOUT_MS}ms) exceeded for ${p.spawnfile}; sending SIGKILL`,
			);
			p.proc.kill("SIGKILL");
		}
		// Reset timer and continue polling for actual termination
		shutdownStartTime = Date.now();
	} else {
		for (const p of streamingProcesses) {
			logger.info(`stop: still waiting for ${p.spawnfile} to terminate...`);
		}
	}

	setTimeout(waitForAllProcessesToTerminate, stopCheckInterval);
}

export function stopAll() {
	for (const p of streamingProcesses) {
		stopProcess(p);
	}
	setTimeout(waitForAllProcessesToTerminate, stopCheckInterval);
}

type Timer = ReturnType<typeof globalThis.setTimeout>;

// Injectable so the SIGTERM→SIGKILL escalation is testable with no real wait.
export interface ShutdownTimers {
	setTimeout(fn: () => void, ms: number): Timer;
	clearTimeout(timer: Timer): void;
}

const realShutdownTimers: ShutdownTimers = {
	setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
	clearTimeout: (timer) => {
		globalThis.clearTimeout(timer);
	},
};

function isProcAlive(sp: StreamingProcess): boolean {
	return sp.proc.exitCode === null && sp.proc.signalCode === null;
}

/**
 * Process-level graceful shutdown (systemd SIGTERM / SIGINT). SIGTERM every live
 * subprocess, resolve as soon as they have all exited, and SIGKILL any survivor
 * once `timeoutMs` elapses. Resolves either way so the caller can exit cleanly.
 *
 * Unlike {@link stopAll} (the in-app stream-stop poll), this is the short window
 * systemd grants before it kills CeraUI itself. The process list and timers are
 * injectable so the escalation is testable with zero real waits.
 */
export function gracefulShutdown(
	timeoutMs: number = SHUTDOWN_SIGTERM_GRACE_MS,
	procs: Array<StreamingProcess> = streamingProcesses,
	timers: ShutdownTimers = realShutdownTimers,
): Promise<void> {
	// A hosted sender is left running: the next backend adopts it or stops its
	// unit. Only the watching ends here.
	for (const sp of [...procs]) {
		if (!sp.hosted || !isProcAlive(sp)) continue;
		logger.info("gracefulShutdown: leaving the hosted sender running", {
			unit: sp.hosted.unit,
		});
		sp.exitListeners = [];
		sp.hosted.release();
		removeProc(sp);
	}
	const remaining = new Set(
		[...procs].filter((sp) => !sp.hosted && isProcAlive(sp)),
	);
	if (remaining.size === 0) return Promise.resolve();

	return new Promise<void>((resolve) => {
		let settled = false;
		let killTimer: Timer | null = null;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			if (killTimer !== null) timers.clearTimeout(killTimer);
			resolve();
		};

		for (const sp of remaining) {
			sp.exitListeners.push(() => {
				removeProc(sp);
				remaining.delete(sp);
				if (remaining.size === 0) finish();
			});
			sp.proc.kill("SIGTERM");
		}

		killTimer = timers.setTimeout(() => {
			for (const sp of remaining) {
				if (!isProcAlive(sp)) continue;
				logger.warn(
					`gracefulShutdown: ${sp.spawnfile} ignored SIGTERM for ${timeoutMs}ms; sending SIGKILL`,
				);
				sp.proc.kill("SIGKILL");
			}
			finish();
		}, timeoutMs);
	});
}
