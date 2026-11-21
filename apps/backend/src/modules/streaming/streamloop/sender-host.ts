/*
 * A sender that outlives the backend: its own transient systemd unit, and a
 * handle the backend supervises it through.
 *
 * Only used with the `stream_continuity_takeover` flag. The unit is
 * `ceralive-srtla-send-<16 hex>.service`, one per sender lifetime, with
 * `Restart=no` (systemd never replaces it), `KillMode=control-group` (when the
 * sender exits, anything left in its cgroup goes with it) and
 * `CollectMode=inactive-or-failed` (the unit disappears once it is done).
 * Stdout goes to the journal and stderr to a file, so the sender's output never
 * breaks when the backend that read it dies.
 *
 * The handle holds a pidfd on the unit's main process for the whole lifetime:
 * every signal goes through `pidfd_send_signal`, so a PID the kernel has given
 * to another process is never reached, and exit is seen by polling that pidfd.
 * A liveness answer that is neither "alive" nor "exited" keeps the handle
 * alive: only a verified exit retires it.
 *
 * The unit is stopped, when the backend gives up on it, by its NAME through
 * systemd, never by PID.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { logger } from "../../../helpers/logger.ts";
import { type ProcessPin, pinProcess } from "../../../helpers/process-pin.ts";
import { run } from "../../../helpers/run.ts";
import { spawnWatcher } from "../../../helpers/spawn-policy.ts";
import {
	readProcessCgroup,
	readUnitFacts,
	statFields,
	systemctlShow,
	type UnitFacts,
	type UnitShow,
} from "../sender-invocation.ts";

/** Every hosted sender unit carries this prefix; nothing else is ever stopped. */
export const SENDER_UNIT_PREFIX = "ceralive-srtla-send-";
const SENDER_UNIT_RE = /^ceralive-srtla-send-[0-9a-f]{16}\.service$/;
/** Root-only directory for the hosted senders' stderr files. */
export const SENDER_OUTPUT_DIR =
	process.env.CERALIVE_SENDER_OUTPUT_DIR ?? "/run/ceralive/sender";
/** How often a hosted handle asks its pidfd whether the sender still runs. */
export const HOSTED_EXIT_POLL_MS = 250;
/** How long a unit stop may take before the backend stops waiting for it. */
export const SENDER_UNIT_STOP_TIMEOUT_MS = 10_000;

export function isSenderUnit(unit: string): boolean {
	return SENDER_UNIT_RE.test(unit);
}

export function senderStderrFile(unit: string): string {
	return `${SENDER_OUTPUT_DIR}/${unit.replace(/\.service$/, "")}.stderr`;
}

/** Where a hosted sender's output can be read: one pipe per stream. */
export type OutputFollowers = {
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	stop(): void;
};

/** The part of a process handle the supervisor uses. */
export type HostedSender = {
	readonly pid: number;
	readonly unit: string;
	readonly startTime: string;
	readonly pin: ProcessPin;
	/** Null while running; -1 once exited (the unit's status is not ours to reap). */
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | null;
	readonly exited: Promise<number>;
	/** Signal through the pidfd; never throws. */
	kill(signal?: NodeJS.Signals | number): void;
	/** The same, with the answer: true sent, false exited, null unknown. */
	signal(signal: NodeJS.Signals | number): boolean | null;
	/** Stop watching (the sender keeps running); closes the pidfd. */
	release(): void;
};

export type HostedSenderOptions = {
	readonly pollMs?: number;
	readonly schedule?: (callback: () => void, ms: number) => unknown;
	readonly cancel?: (timer: unknown) => void;
};

/**
 * A supervision handle over a pinned process. Exit is a verified exit only:
 * the pidfd says the process is gone, or a signal through it found it gone.
 */
export function hostedSenderHandle(
	pid: number,
	startTime: string,
	unit: string,
	pin: ProcessPin,
	options: HostedSenderOptions = {},
): HostedSender {
	const pollMs = options.pollMs ?? HOSTED_EXIT_POLL_MS;
	const schedule =
		options.schedule ??
		((callback: () => void, ms: number) => {
			const timer = setTimeout(callback, ms);
			timer.unref?.();
			return timer;
		});
	const cancel =
		options.cancel ??
		((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	let exitCode: number | null = null;
	let released = false;
	let timer: unknown;
	let resolveExited: (code: number) => void = () => undefined;
	const exited = new Promise<number>((resolve) => {
		resolveExited = resolve;
	});
	const markExited = () => {
		if (exitCode !== null) return;
		exitCode = -1;
		if (timer !== undefined) cancel(timer);
		timer = undefined;
		pin.close();
		resolveExited(-1);
	};
	const poll = () => {
		timer = undefined;
		if (exitCode !== null || released) return;
		// Only a verified exit retires the handle; unknown keeps watching.
		if (pin.alive() === false) {
			markExited();
			return;
		}
		timer = schedule(poll, pollMs);
	};
	timer = schedule(poll, pollMs);
	const signal = (sig: NodeJS.Signals | number): boolean | null => {
		if (exitCode !== null) return false;
		if (released) return null;
		const sent = pin.signal(sig);
		if (sent === false) markExited();
		return sent;
	};
	return {
		pid,
		unit,
		startTime,
		pin,
		get exitCode() {
			return exitCode;
		},
		signalCode: null,
		exited,
		kill: (sig = "SIGTERM") => {
			const sent = signal(sig);
			if (sent === null)
				logger.warn("hosted sender: signal not confirmed", {
					unit,
					signal: String(sig),
				});
		},
		signal,
		release: () => {
			if (released || exitCode !== null) return;
			released = true;
			if (timer !== undefined) cancel(timer);
			timer = undefined;
			pin.close();
		},
	};
}

export type SenderHostDeps = {
	readonly run: (command: string, args: string[]) => Promise<string>;
	readonly show: UnitShow;
	readonly pin: (pid: number) => Promise<ProcessPin | null>;
	readonly readStat: (pid: number) => Promise<string>;
	readonly readCgroup: (pid: number) => Promise<string | null>;
	readonly mkdir: (path: string) => Promise<void>;
	readonly unitId: () => string;
	readonly follow: (
		unit: string,
		from: "start" | "now",
	) => OutputFollowers | null;
	readonly wait: (ms: number) => Promise<void>;
	readonly now: () => number;
};

export const defaultSenderHostDeps: SenderHostDeps = {
	run: (command, args) => run(command, args, { timeout: 5_000 }),
	show: systemctlShow,
	pin: pinProcess,
	readStat: (pid) => readFile(`/proc/${pid}/stat`, "utf8"),
	readCgroup: (pid) => readProcessCgroup("/proc", pid),
	mkdir: async (path) => {
		await mkdir(path, { recursive: true, mode: 0o700 });
	},
	unitId: () => randomBytes(8).toString("hex"),
	follow: followSenderOutput,
	wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => performance.now(),
};

/** Why a hosted launch did not produce a supervised sender. */
export class HostedLaunchError extends Error {
	constructor(
		readonly reason: string,
		readonly unit: string,
	) {
		super(`hosted sender launch failed: ${reason}`);
		this.name = "HostedLaunchError";
	}
}

export type HostedLaunch = {
	readonly sender: HostedSender;
	readonly followers: OutputFollowers | null;
};

/**
 * Start `command args` as its own unit and return a handle over its main
 * process. The main PID is read from systemd, pinned, and confirmed again after
 * the pin (same MainPID and invocation, the process in the unit's cgroup), so
 * the handle describes the process systemd started. Any doubt stops the unit
 * by name and throws.
 */
export async function launchHostedSender(
	command: string,
	args: readonly string[],
	deps: SenderHostDeps = defaultSenderHostDeps,
): Promise<HostedLaunch> {
	const unit = `${SENDER_UNIT_PREFIX}${deps.unitId()}.service`;
	if (!isSenderUnit(unit)) throw new HostedLaunchError("unit_name", unit);
	await deps.mkdir(SENDER_OUTPUT_DIR);
	await deps.run("systemd-run", [
		`--unit=${unit}`,
		"--description=CeraLive SRTLA sender",
		"--service-type=exec",
		"--collect",
		"--quiet",
		"--property=Restart=no",
		"--property=KillMode=control-group",
		"--property=StandardOutput=journal",
		`--property=StandardError=truncate:${senderStderrFile(unit)}`,
		"--setenv=NO_COLOR=1",
		"--",
		command,
		...args,
	]);
	let pin: ProcessPin | null = null;
	try {
		const before = await readUnitFacts(unit, "system", deps.show);
		if (before?.activeState !== "active" || before.mainPid <= 0)
			throw new HostedLaunchError("unit_not_running", unit);
		pin = await deps.pin(before.mainPid);
		if (!pin?.pidfd || pin.alive() !== true)
			throw new HostedLaunchError("pin_unavailable", unit);
		const fields = statFields(await deps.readStat(before.mainPid));
		const startTime = fields[19] ?? "";
		const cgroup = await deps.readCgroup(before.mainPid);
		const after = await readUnitFacts(unit, "system", deps.show);
		if (
			!/^\d+$/.test(startTime) ||
			!after ||
			after.mainPid !== before.mainPid ||
			after.invocation !== before.invocation ||
			cgroup !== after.controlGroup ||
			pin.alive() !== true
		)
			throw new HostedLaunchError("identity_unconfirmed", unit);
		const sender = hostedSenderHandle(before.mainPid, startTime, unit, pin);
		pin = null;
		return { sender, followers: deps.follow(unit, "start") };
	} catch (error) {
		pin?.close();
		await stopSenderUnit(unit, deps).catch(() => undefined);
		throw error instanceof HostedLaunchError
			? error
			: new HostedLaunchError("unreadable", unit);
	}
}

export type UnitStopOutcome = "stopped" | "absent" | "timed_out" | "failed";

/**
 * Stop a sender unit by name and wait until systemd reports it inactive or
 * gone. Never addresses a PID. Refuses any unit without our prefix.
 */
export async function stopSenderUnit(
	unit: string,
	deps: Pick<
		SenderHostDeps,
		"run" | "show" | "wait" | "now"
	> = defaultSenderHostDeps,
	timeoutMs = SENDER_UNIT_STOP_TIMEOUT_MS,
): Promise<UnitStopOutcome> {
	if (!isSenderUnit(unit)) return "failed";
	const initial = await readUnitFacts(unit, "system", deps.show);
	if (initial === null || isInactive(initial)) return "absent";
	try {
		await deps.run("systemctl", ["stop", "--no-block", "--", unit]);
	} catch {
		return "failed";
	}
	const deadline = deps.now() + timeoutMs;
	for (;;) {
		const facts = await readUnitFacts(unit, "system", deps.show);
		if (facts === null || isInactive(facts)) return "stopped";
		if (deps.now() >= deadline) return "timed_out";
		await deps.wait(100);
	}
}

function isInactive(facts: UnitFacts): boolean {
	return (
		facts.activeState === "inactive" ||
		facts.activeState === "failed" ||
		facts.mainPid === 0
	);
}

/** Every loaded sender unit, or null when systemd cannot be asked. */
export async function listSenderUnits(
	deps: Pick<SenderHostDeps, "run"> = defaultSenderHostDeps,
): Promise<string[] | null> {
	let out: string;
	try {
		out = await deps.run("systemctl", [
			"list-units",
			"--all",
			"--plain",
			"--no-legend",
			"--type=service",
			"--",
			`${SENDER_UNIT_PREFIX}*`,
		]);
	} catch {
		return null;
	}
	return out
		.split("\n")
		.map((line) => line.trim().split(/\s+/)[0] ?? "")
		.filter(isSenderUnit);
}

/**
 * Follow a hosted sender's output with two children of the backend: the
 * journal for stdout and the stderr file. They die with the backend; the
 * sender never notices. `now` reads only lines written from here on.
 */
export function followSenderOutput(
	unit: string,
	from: "start" | "now",
): OutputFollowers | null {
	if (!isSenderUnit(unit)) return null;
	const abort = new AbortController();
	try {
		const journal = spawnWatcher(
			[
				"journalctl",
				"--follow",
				"--quiet",
				"--output=cat",
				from === "now" ? "--lines=0" : "--lines=all",
				`--unit=${unit}`,
			],
			{ signal: abort.signal },
		);
		const stderr = spawnWatcher(
			[
				"tail",
				"--follow=name",
				"--retry",
				from === "now" ? "--lines=0" : "--lines=+1",
				senderStderrFile(unit),
			],
			{ signal: abort.signal },
		);
		const stdoutPipe = journal.proc.stdout;
		const stderrPipe = stderr.proc.stdout;
		if (
			!(stdoutPipe instanceof ReadableStream) ||
			!(stderrPipe instanceof ReadableStream)
		) {
			abort.abort();
			return null;
		}
		return {
			stdout: stdoutPipe,
			stderr: stderrPipe,
			stop: () => abort.abort(),
		};
	} catch (error) {
		abort.abort();
		logger.warn("hosted sender: output followers unavailable", {
			unit,
			error,
		});
		return null;
	}
}
