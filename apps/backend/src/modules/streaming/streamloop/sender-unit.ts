/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * The SRTLA sender run by its own systemd unit, `srtla-send.service`.
 *
 * Opt-in through `setup.json` `"srtla_send_unit": true`; without it the
 * backend spawns `srtla_send` as its own child exactly as before. The image
 * ships the unit dormant, with a launcher that reads the sender's arguments
 * from `/run/srtla-send/argv` (root, 0700). The contract is the image's
 * `docs/srtla-send-unit.md`; this module is the caller half:
 *
 * - **Paths.** Every file the sender uses (IP list, bind map, stats file,
 *   control socket, argv) lives in `/run/srtla-send`, the writer and the
 *   readers moved together, all absolute.
 * - **Publication.** A fresh 0600 file renamed over `argv` in the same
 *   directory, so the launcher never sees a partial write.
 * - **Serialization.** Publication, start and stop run one at a time, and a
 *   start holds the update lock (`/run/lock/ceralive-update.lock`) so it can
 *   never overlap the manual `ceralive-update`.
 * - **Readiness.** `Type=exec` reports the unit started before the launcher
 *   has checked anything. A start counts only after a fresh control RPC on a
 *   connection whose SO_PEERCRED PID is the unit's MainPID, with the same
 *   InvocationID and MainPID read before and after it.
 * - **Restarts.** systemd alone restarts the sender (ADR-0005). The handle
 *   notices a new invocation, reports the exit, waits for the new process to
 *   be ready and then follows it. Only a final stop of the unit ends the
 *   handle.
 * - **A sender left by an earlier backend is held, not stopped.** A backend
 *   that starts and finds the unit running (or starting, restarting or
 *   stopping) did not start that sender. It keeps running: nothing signals it,
 *   no file is removed, no second sender starts beside it and the session stays
 *   unconfirmed. The operator's Stop stops it; the hold also ends when systemd
 *   reports the unit down on its own. Graceful shutdown leaves an owned sender
 *   running for the next backend to hold. Adoption would replace the hold.
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fsyncSync,
	openSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { lstat, rename, rm } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { isAbsolute } from "node:path";
import { createControlClient } from "@ceraui/srtla-send";
import { logger } from "../../../helpers/logger.ts";
import { readPeerCredentials } from "../../../helpers/peer-credentials.ts";
import {
	pidfdAlive,
	pidfdClose,
	pidfdOpen,
	pidfdSignal,
} from "../../../helpers/pidfd.ts";
import { run } from "../../../helpers/run.ts";
import { SOFTWARE_UPDATE_LOCK } from "../../system/software-update-service-contract.ts";
import type { SupervisedProc } from "./process-runner.ts";

export const SENDER_UNIT = "srtla-send.service";
export const SENDER_UNIT_DIR = "/run/srtla-send";
/** The only executable the launcher runs. */
export const SENDER_UNIT_EXEC = "/usr/bin/srtla_send";
/** Payload limit of the launcher, NUL bytes included. */
export const SENDER_ARGV_MAX_BYTES = 8192;
/** Launcher refusal; the sender's own usage error is 2. Neither is retried. */
export const LAUNCHER_REFUSED_EXIT = 78;

const READY_TIMEOUT_MS = 5_000;
const READY_POLL_MS = 100;
const MONITOR_INTERVAL_MS = 1_000;
const SYSTEMCTL_TIMEOUT_MS = 15_000;
// TimeoutStopSec=5s plus the SIGKILL that follows it, with room to spare.
const STOP_TIMEOUT_MS = 20_000;

const SHOW_PROPERTIES = [
	"LoadState",
	"ActiveState",
	"SubState",
	"MainPID",
	"InvocationID",
	"ControlGroup",
	"Result",
	"ExecMainCode",
	"ExecMainStatus",
	"NRestarts",
	"Job",
] as const;

export type SenderUnitPaths = {
	readonly dir: string;
	readonly argv: string;
	readonly ips: string;
	readonly bindMap: string;
	readonly statsFile: string;
	readonly controlSocket: string;
};

export function senderUnitPaths(dir = SENDER_UNIT_DIR): SenderUnitPaths {
	return {
		dir,
		argv: `${dir}/argv`,
		ips: `${dir}/ips`,
		bindMap: `${dir}/ips.bindmap.json`,
		statsFile: `${dir}/stats.json`,
		controlSocket: `${dir}/control.sock`,
	};
}

export type UnitShow = {
	readonly loadState: string;
	readonly activeState: string;
	readonly subState: string;
	readonly mainPid: number;
	readonly invocation: string;
	readonly controlGroup: string;
	readonly result: string;
	readonly execMainCode: number | null;
	readonly execMainStatus: number | null;
	readonly restarts: number;
	/**
	 * The queued or running job's id; empty when no job is pending, null when
	 * the reply had no `Job=` row (unknown, never "no job").
	 */
	readonly job: string | null;
};

/** Parse `systemctl show --property=...` output; null when it is not one. */
export function parseUnitShow(stdout: string): UnitShow | null {
	const rows = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		const at = line.indexOf("=");
		if (at > 0) rows.set(line.slice(0, at), line.slice(at + 1).trim());
	}
	const int = (key: string): number | null => {
		const value = rows.get(key);
		return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
	};
	// A truncated or malformed reply is unreadable, never "no process".
	const mainPid = int("MainPID");
	if (!rows.has("LoadState") || !rows.has("ActiveState") || mainPid === null)
		return null;
	return {
		loadState: rows.get("LoadState") ?? "",
		activeState: rows.get("ActiveState") ?? "",
		subState: rows.get("SubState") ?? "",
		mainPid,
		invocation: rows.get("InvocationID") ?? "",
		controlGroup: rows.get("ControlGroup") ?? "",
		result: rows.get("Result") ?? "",
		execMainCode: int("ExecMainCode"),
		execMainStatus: int("ExecMainStatus"),
		restarts: int("NRestarts") ?? 0,
		job: rows.get("Job") ?? null,
	};
}

/** Neither running, starting, waiting to restart nor stopping. */
function isDown(show: UnitShow): boolean {
	return show.activeState === "inactive" || show.activeState === "failed";
}

/**
 * Down with proof: inactive or failed, no main process and an explicit empty
 * `Job=` row (a start job can sit behind an inactive state, and a reply
 * without the row proves nothing). The one
 * predicate for stop confirmation, start admission, retirement and a final
 * exit.
 */
function confirmedDown(show: UnitShow): boolean {
	return isDown(show) && show.mainPid === 0 && show.job === "";
}

function isRunning(show: UnitShow): boolean {
	return (
		show.loadState === "loaded" &&
		show.controlGroup !== "" &&
		show.activeState === "active" &&
		show.subState === "running" &&
		show.mainPid > 0 &&
		show.invocation !== ""
	);
}

/**
 * How the last main process ended, in Bun's exitCode/signalCode terms. systemd
 * does not always keep the exit (a stop after a restart reads ExecMainCode=0);
 * then `unknown` stands in, so a handle never looks alive after its end.
 */
export function mainExit(
	show: UnitShow,
	unknown: { exitCode: number | null; signalCode: NodeJS.Signals | null } = {
		exitCode: 1,
		signalCode: null,
	},
): {
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
} {
	const { execMainCode: code, execMainStatus: status } = show;
	if (code === 1 && status !== null)
		return { exitCode: status, signalCode: null };
	if ((code === 2 || code === 3) && status !== null) {
		const name = Object.entries(osConstants.signals).find(
			([, value]) => value === status,
		)?.[0];
		if (name) return { exitCode: null, signalCode: name as NodeJS.Signals };
	}
	return unknown;
}

export type SenderUnitFailureReason =
	/** The update lock is held: a manual update is running. */
	| "update_in_progress"
	/** The unit is running, starting or stopping: never start a second sender. */
	| "unit_busy"
	/** `/run/srtla-send` is missing or not root-only. */
	| "unsafe_directory"
	/** An argument cannot be published (relative path, NUL, too long). */
	| "invalid_arguments"
	/** The launcher refused the argument file (exit 78). */
	| "launcher_refused"
	/** The sender rejected its arguments (exit 2). */
	| "sender_usage"
	/** systemd refused the start (start limit, missing unit, ...). */
	| "start_refused"
	/** The unit started but the sender never became ready in time. */
	| "not_ready"
	/** The unit could not be read. */
	| "unit_unreadable"
	/** A stop was not confirmed: a sender may still run untracked. */
	| "stop_unconfirmed"
	/** The unit's state is unresolved since startup: no sender may start. */
	| "unit_unresolved"
	/** A sender started by an earlier backend is still running. */
	| "unit_held";

export class SenderUnitError extends Error {
	override readonly name = "SenderUnitError";
	constructor(
		readonly reason: SenderUnitFailureReason,
		message: string,
	) {
		super(message);
	}
}

export type FileStat = {
	isDirectory(): boolean;
	isFile(): boolean;
	isSocket(): boolean;
	readonly uid: number;
	readonly mode: number;
};

export interface SenderUnitIo {
	readonly unit: string;
	readonly paths: SenderUnitPaths;
	/** The owner the launcher expects for the directory and argv (root). */
	readonly ownerUid: number;
	/** Run `systemctl <args>`; resolves on exit 0, rejects otherwise. */
	systemctl(args: readonly string[], timeoutMs: number): Promise<string>;
	lstat(path: string): Promise<FileStat>;
	/** `comm` of a process, or null when it cannot be read. */
	readComm(pid: number, procRoot?: string): string | null;
	/** The unified (cgroup v2) path of a process, or null. */
	readCgroup(pid: number, procRoot?: string): string | null;
	/** Write `data` as a fresh 0600 file at `path` (O_EXCL, fsynced). */
	writeExclusive(path: string, data: Uint8Array): void;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
	/**
	 * A fresh control RPC to the sender on a connection whose peer `accept`
	 * approves. Resolves true when the sender answered, false when the socket
	 * is not reachable yet or the peer was refused.
	 */
	probeControl(
		socketPath: string,
		accept: (peer: { pid: number; uid: number }) => boolean,
		timeoutMs: number,
	): Promise<boolean>;
	/** A pidfd for `pid`, or null (gone, or no pidfd support). */
	pidfdOpen(pid: number): number | null;
	/** Signal through a pidfd; false when the process has exited. */
	pidfdSignal(fd: number, signal: NodeJS.Signals): boolean;
	/** Whether the process a pidfd names has not exited (pidfd not readable). */
	pidfdAlive(fd: number): boolean;
	pidfdClose(fd: number): void;
	/** Take the update lock without waiting; null when someone else holds it. */
	tryUpdateLock(): Promise<{ release(): void } | null>;
	signal(pid: number, signal: NodeJS.Signals): void;
	now(): number;
	sleep(ms: number): Promise<void>;
	/** Run `fn` once after `ms`; returns a cancel function. */
	schedule(fn: () => void, ms: number): () => void;
}

function procRead(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

export function unifiedCgroup(content: string | null): string | null {
	if (content === null) return null;
	const line = content.split("\n").find((entry) => entry.startsWith("0::"));
	return line ? line.slice(3).trim() : null;
}

let flockLib:
	| Promise<{ flock(fd: number, operation: number): number } | null>
	| undefined;
function loadFlock() {
	flockLib ??= import("bun:ffi")
		.then(({ dlopen, FFIType }) => {
			const lib = dlopen("libc.so.6", {
				flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			});
			return { flock: (fd: number, op: number) => lib.symbols.flock(fd, op) };
		})
		.catch(() => null);
	return flockLib;
}

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

/** flock(LOCK_EX | LOCK_NB) on the update lock file, as `ceralive-update` takes it. */
export async function tryExclusiveLock(
	path: string,
): Promise<{ release(): void } | null> {
	const lib = await loadFlock();
	if (!lib) throw new Error("flock is unavailable");
	const fd = openSync(
		path,
		constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
		0o644,
	);
	if (lib.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
		closeSync(fd);
		return null;
	}
	let released = false;
	return {
		release: () => {
			if (released) return;
			released = true;
			try {
				lib.flock(fd, LOCK_UN);
			} finally {
				closeSync(fd);
			}
		},
	};
}

export function productionSenderUnitIo(): SenderUnitIo {
	return {
		unit: SENDER_UNIT,
		paths: senderUnitPaths(),
		ownerUid: 0,
		systemctl: (args, timeoutMs) =>
			run("systemctl", [...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 }),
		lstat: (path) => lstat(path),
		readComm: (pid, procRoot = "/proc") =>
			procRead(`${procRoot}/${pid}/comm`)?.trim() ?? null,
		readCgroup: (pid, procRoot = "/proc") =>
			unifiedCgroup(procRead(`${procRoot}/${pid}/cgroup`)),
		writeExclusive: (path, data) => {
			const fd = openSync(
				path,
				constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_EXCL |
					constants.O_NOFOLLOW,
				0o600,
			);
			try {
				let offset = 0;
				while (offset < data.length)
					offset += writeSync(fd, data, offset, data.length - offset);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		},
		rename: (from, to) => rename(from, to),
		remove: (path) => rm(path, { force: true }),
		probeControl: (socketPath, accept, timeoutMs) => {
			// One budget for connect, peer check and the call; a connection that
			// arrives after the budget is closed unused.
			let expired = false;
			const attempt = (async () => {
				const client = await createControlClient({
					socketPath,
					timeoutMs,
					verifyPeer: async (fd) => {
						const peer = await readPeerCredentials(fd);
						return peer !== null && accept(peer);
					},
				});
				if (!client) return false;
				if (expired) {
					client.close();
					return false;
				}
				try {
					// A pre-capability sender answers "method not found", which is
					// still an answer from the verified peer.
					await client.getCapabilities();
					return !expired;
				} catch {
					return false;
				} finally {
					client.close();
				}
			})();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const deadline = new Promise<boolean>((resolve) => {
				timer = setTimeout(() => {
					expired = true;
					resolve(false);
				}, timeoutMs);
			});
			return Promise.race([attempt, deadline]).finally(() =>
				clearTimeout(timer),
			);
		},
		pidfdOpen,
		pidfdSignal,
		pidfdAlive,
		pidfdClose,
		tryUpdateLock: () => tryExclusiveLock(SOFTWARE_UPDATE_LOCK),
		signal: (pid, signal) => {
			process.kill(pid, signal);
		},
		now: () => performance.now(),
		sleep: (ms) => Bun.sleep(ms),
		schedule: (fn, ms) => {
			const timer = setTimeout(fn, ms);
			return () => clearTimeout(timer);
		},
	};
}

// ---------------------------------------------------------------------------
// Mode: decided at startup
// ---------------------------------------------------------------------------

export type SenderHostMode = "child" | "unit";

let hostMode: SenderHostMode = "child";
/** Set whenever the flag is on, also in child fallback: the unit may exist. */
let hostIo: SenderUnitIo | null = null;
let hostSetup: SenderSetup | null = null;
let hostExec = SENDER_UNIT_EXEC;
/** Why no sender may start, or null. */
let blocked: string | null = null;
/**
 * What the block waits for, which decides how its retry settles it:
 * - `mode`: the unit could not be read at boot; decide the mode first;
 * - `unchecked`: the unit's state is not known yet (boot, or a failed read);
 * - `held`: a sender this backend did not start is running; keep it;
 * - `owed_stop`: this backend's own stop was not confirmed; stop again.
 */
type BlockKind = "mode" | "unchecked" | "held" | "owed_stop";
let blockKind: BlockKind | null = null;
/** The sender unit an earlier backend left running, while it is held. */
let held: HeldSenderUnit | null = null;
let onHoldChanged: ((change: HoldChange) => void) | null = null;
let cancelRetry: (() => void) | null = null;
/** Bumped by every start; cleanup of an older launch is skipped. */
let launchGeneration = 0;

const BOOT_SHOW_ATTEMPTS = 3;
const BOOT_SHOW_RETRY_MS = 500;
const UNRESOLVED_RETRY_MS = 5_000;

export function senderHostMode(): SenderHostMode {
	return hostMode;
}

/** Why no sender (child or unit) may start right now, or null. */
export function senderHostBlocked(): string | null {
	return blocked;
}

/** A sender unit started by an earlier backend and kept running. */
export type HeldSenderUnit = {
	readonly activeState: string;
	readonly subState: string;
	readonly invocation: string;
	readonly mainPid: number;
};

/**
 * True while a session may be carried by a sender whose unit state this
 * backend has not settled, or that it holds without having started it: then
 * only the operator may end it (automatic stops are refused).
 */
export function senderUnitKeepsSession(): boolean {
	return (
		blockKind === "held" || blockKind === "unchecked" || blockKind === "mode"
	);
}

/** The sender unit this backend holds without having started it, or null. */
export function heldSenderUnit(): HeldSenderUnit | null {
	return held;
}

/**
 * `held`: a unit from an earlier backend is now held. `released`: it was seen
 * down on its own, so the session can follow the engine again. `stopped`: the
 * stop path ended it (the stop itself settles the session).
 */
export type HoldChange = "held" | "released" | "stopped";

export function onSenderUnitHoldChanged(
	listener: ((change: HoldChange) => void) | null,
): void {
	onHoldChanged = listener;
}

function announceHold(change: HoldChange): void {
	try {
		onHoldChanged?.(change);
	} catch (error) {
		logger.warn("sender unit hold listener failed", { error });
	}
}

/** The private paths of the unit host, or null in child mode. */
export function senderUnitHostPaths(): SenderUnitPaths | null {
	return hostMode === "unit" && hostIo ? hostIo.paths : null;
}

/** The I/O of the active unit host; only valid in unit mode. */
function unitIo(): SenderUnitIo {
	if (hostMode !== "unit" || !hostIo)
		throw new Error("sender unit host is not active");
	return hostIo;
}

export function resetSenderHostModeForTest(): void {
	cancelRetry?.();
	cancelRetry = null;
	hostMode = "child";
	hostIo = null;
	hostSetup = null;
	blocked = null;
	blockKind = null;
	held = null;
	onHoldChanged = null;
	launchGeneration = 0;
	transitions = Promise.resolve();
}

type SenderSetup = {
	srtla_send_unit?: boolean | undefined;
	srtla_path?: string | undefined;
	ips_file?: string | undefined;
	bind_map_file?: string | undefined;
};

async function directoryIsPrivate(io: SenderUnitIo): Promise<boolean> {
	try {
		const info = await io.lstat(io.paths.dir);
		return (
			info.isDirectory() &&
			info.uid === io.ownerUid &&
			(info.mode & 0o077) === 0
		);
	} catch {
		return false;
	}
}

/**
 * Whether this backend can start the unit: its load state only. Whether a
 * sender runs is a separate question, answered by the runtime state in
 * {@link settleSenderUnit}: a unit whose fragment was removed (`not-found`)
 * or `masked` can still have a running main process.
 */
type UnitPresence =
	| { readonly kind: "loaded" }
	| { readonly kind: "unusable"; readonly loadState: string }
	| { readonly kind: "unknown" };

async function unitPresence(
	io: SenderUnitIo,
	attempts: number,
): Promise<UnitPresence> {
	for (let attempt = 1; ; attempt++) {
		try {
			const show = parseUnitShow(await showUnit(io, SYSTEMCTL_TIMEOUT_MS));
			if (show?.loadState === "loaded") return { kind: "loaded" };
			if (show && show.loadState !== "")
				return { kind: "unusable", loadState: show.loadState };
		} catch {
			// unreadable: retried below
		}
		if (attempt >= attempts) return { kind: "unknown" };
		await io.sleep(BOOT_SHOW_RETRY_MS);
	}
}

/**
 * Decide whether this backend runs the sender through its unit.
 *
 * Flag off (the default): child mode, without reading anything. Flag on: unit
 * mode when the unit is installed, the launcher's directory is root-only and
 * the sender executable is the one the launcher runs. A unit that is
 * positively absent gives child mode. A unit that is installed but unusable
 * gives child mode too, but the unit may still run a sender, so
 * {@link settleSenderUnit} must see it down (or hold it) before anything
 * starts. A unit that cannot be read leaves the backend blocked (no sender of
 * either kind) until a later read settles it. In unit mode the IP list and
 * bind map move into the private directory, so writer and readers agree.
 */
export async function resolveSenderHostMode(
	setup: SenderSetup,
	senderExec: string,
	io: SenderUnitIo = productionSenderUnitIo(),
): Promise<SenderHostMode> {
	if (!armSenderHostMode(setup, senderExec, io)) return hostMode;
	const reason = await decideMode(BOOT_SHOW_ATTEMPTS);
	if (reason) {
		blocked = reason;
		blockKind = "mode";
		logger.error(
			`srtla_send_unit is set, but ${reason}; no sender starts until it can be read`,
		);
	} else {
		// Until the startup check has seen the unit, nothing may start.
		blocked = `${io.unit}: not checked yet`;
		blockKind = "unchecked";
	}
	return hostMode;
}

/**
 * Synchronous first half of {@link resolveSenderHostMode}, for the earliest
 * point of startup: with the flag on, publish "not decided yet" before
 * anything (an RPC such as Stop, the census) can ask, so no window exists in
 * which a unit sender could look absent. No I/O. Returns whether the flag is on.
 */
export function armSenderHostMode(
	setup: SenderSetup,
	senderExec: string,
	io: SenderUnitIo = productionSenderUnitIo(),
): boolean {
	cancelRetry?.();
	cancelRetry = null;
	hostMode = "child";
	hostIo = null;
	hostSetup = null;
	blocked = null;
	blockKind = null;
	held = null;
	if (setup.srtla_send_unit !== true) return false;
	hostIo = io;
	hostSetup = setup;
	hostExec = senderExec;
	blocked = `${io.unit}: not decided yet`;
	blockKind = "mode";
	return true;
}

/** Decide the mode; returns why it cannot be decided, or null. */
async function decideMode(attempts: number): Promise<string | null> {
	const io = hostIo;
	const setup = hostSetup;
	if (!io || !setup) return null;
	const fallback = (why: string): void => {
		logger.warn(
			`srtla_send_unit is set, but ${why}; the sender runs as a child of the backend`,
		);
	};
	const presence = await unitPresence(io, attempts);
	if (presence.kind === "unknown") return `${io.unit} cannot be read`;
	if (presence.kind === "unusable") {
		// Starting is impossible; a sender it may still run is settled (held or
		// seen down) by the startup check like any other.
		fallback(`${io.unit} is ${presence.loadState}`);
		return null;
	}
	if (hostExec !== SENDER_UNIT_EXEC) {
		fallback(
			`the sender is ${hostExec}, and the unit runs only ${SENDER_UNIT_EXEC}`,
		);
		return null;
	}
	if (!(await directoryIsPrivate(io))) {
		fallback(`${io.paths.dir} is missing or not private to root`);
		return null;
	}
	// ips_file always has a value (the shared /tmp default); bind_map_file is
	// set only by an explicit override, which is worth a warning.
	if (
		setup.bind_map_file !== undefined &&
		setup.bind_map_file !== io.paths.bindMap
	)
		logger.warn(
			`setup.json bind_map_file is replaced by ${io.paths.bindMap} in unit mode`,
		);
	setup.ips_file = io.paths.ips;
	setup.bind_map_file = io.paths.bindMap;
	hostMode = "unit";
	logger.info(`srtla_send runs through ${io.unit}`, { dir: io.paths.dir });
	return null;
}

function blockUntilSettled(reason: string, kind: BlockKind): void {
	blocked = reason;
	blockKind = kind;
	if (cancelRetry || !hostIo) return;
	cancelRetry = hostIo.schedule(() => {
		cancelRetry = null;
		void settleSenderUnit();
	}, UNRESOLVED_RETRY_MS);
}

/** Lift the block; a hold that ends is announced as `change`. */
function releaseBlock(change: "released" | "stopped" = "released"): void {
	const wasHeld = held !== null;
	cancelRetry?.();
	cancelRetry = null;
	blocked = null;
	blockKind = null;
	held = null;
	if (wasHeld) announceHold(change);
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

let transitions: Promise<unknown> = Promise.resolve();

/** Run `step` after every earlier publication, start, stop or cleanup. */
function serialized<T>(step: () => Promise<T>): Promise<T> {
	const next = transitions.then(step, step);
	transitions = next.catch(() => undefined);
	return next;
}

function showUnit(io: SenderUnitIo, timeoutMs: number): Promise<string> {
	return io.systemctl(
		["show", io.unit, `--property=${SHOW_PROPERTIES.join(",")}`],
		timeoutMs,
	);
}

async function readShow(
	io: SenderUnitIo,
	timeoutMs = SYSTEMCTL_TIMEOUT_MS,
): Promise<UnitShow> {
	let show: UnitShow | null = null;
	try {
		show = parseUnitShow(await showUnit(io, timeoutMs));
	} catch (error) {
		throw new SenderUnitError(
			"unit_unreadable",
			`cannot read ${io.unit}: ${(error as Error).message}`,
		);
	}
	if (!show)
		throw new SenderUnitError("unit_unreadable", `cannot parse ${io.unit}`);
	return show;
}

/** Flag-argument pairs whose value is a path the sender opens. */
const PATH_FLAGS = new Set([
	"--stats-file",
	"--control-socket",
	"--bind-map",
	"--config",
]);

/** The NUL-terminated argv payload the launcher accepts. */
export function encodeSenderArgv(args: readonly string[]): Uint8Array {
	if (args.length < 4)
		throw new SenderUnitError(
			"invalid_arguments",
			"the sender needs four positionals",
		);
	const port = args[0] ?? "";
	// The launcher's own check: one to five ASCII digits, 1..65535.
	if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
		throw new SenderUnitError(
			"invalid_arguments",
			`listen port ${port} is not a port`,
		);
	for (const [index, arg] of args.entries()) {
		if (arg.includes("\0"))
			throw new SenderUnitError(
				"invalid_arguments",
				`argument ${index} holds a NUL byte`,
			);
		const isPath = index === 3 || PATH_FLAGS.has(args[index - 1] ?? "");
		if (isPath && !isAbsolute(arg))
			throw new SenderUnitError(
				"invalid_arguments",
				`path ${arg} is not absolute`,
			);
	}
	const bytes = new TextEncoder().encode(
		args.map((arg) => `${arg}\0`).join(""),
	);
	if (bytes.length > SENDER_ARGV_MAX_BYTES)
		throw new SenderUnitError(
			"invalid_arguments",
			`argument file would be ${bytes.length} bytes (at most ${SENDER_ARGV_MAX_BYTES})`,
		);
	return bytes;
}

async function publishArgv(
	io: SenderUnitIo,
	payload: Uint8Array,
): Promise<void> {
	const temp = `${io.paths.dir}/.argv-${randomBytes(8).toString("hex")}`;
	try {
		io.writeExclusive(temp, payload);
		await io.rename(temp, io.paths.argv);
	} catch (error) {
		await io.remove(temp).catch(() => undefined);
		throw new SenderUnitError(
			"start_refused",
			`cannot publish ${io.paths.argv}: ${(error as Error).message}`,
		);
	}
}

/** Files only a sender of this unit writes. True when all are gone. */
async function removeFiles(
	io: SenderUnitIo,
	paths: readonly string[],
): Promise<boolean> {
	let removed = true;
	for (const path of paths)
		await io.remove(path).catch((error) => {
			removed = false;
			logger.warn(`could not remove ${path}`, { error });
		});
	return removed;
}

function launchState(io: SenderUnitIo): string[] {
	return [io.paths.argv, io.paths.statsFile, io.paths.controlSocket];
}

/** Remove launch state, unless a newer start owns it by now. */
function removeLaunchStateOf(
	io: SenderUnitIo,
	generation: number,
): Promise<boolean> {
	if (generation !== launchGeneration) return Promise.resolve(true);
	return removeFiles(io, launchState(io));
}

type Ready = {
	pid: number;
	invocation: string;
	controlGroup: string;
	/** Pins the process the checks describe; null without pidfd support. */
	pidfd: number | null;
};

/**
 * Wait until the unit's sender answers on its control socket, within one
 * deadline for every read and call.
 *
 * Ready means: the unit is loaded, active and running; its MainPID is
 * `srtla_send` (the launcher has replaced itself) inside the unit's non-empty
 * ControlGroup; a fresh control RPC succeeded on a connection whose SO_PEERCRED
 * PID is that MainPID and UID the owner; and InvocationID, MainPID and
 * ControlGroup read after the RPC are the ones read before it, all inside the
 * deadline. A pidfd taken right after the first read pins the process the
 * checks describe. A unit that goes down meanwhile fails at once.
 */
async function awaitReady(
	io: SenderUnitIo,
	timeoutMs = READY_TIMEOUT_MS,
): Promise<Ready> {
	const deadline = io.now() + timeoutMs;
	const left = (): number => {
		const remaining = deadline - io.now();
		if (remaining <= 0)
			throw new SenderUnitError(
				"not_ready",
				`${io.unit} did not answer on ${io.paths.controlSocket} within ${timeoutMs} ms`,
			);
		return remaining;
	};
	for (;;) {
		const before = await readShow(io, Math.min(SYSTEMCTL_TIMEOUT_MS, left()));
		if (isDown(before)) throw downError(io, before);
		if (isRunning(before)) {
			const pid = before.mainPid;
			const pidfd = io.pidfdOpen(pid);
			let ready = false;
			try {
				if (
					io.readComm(pid) === "srtla_send" &&
					io.readCgroup(pid) === before.controlGroup &&
					(await io.probeControl(
						io.paths.controlSocket,
						(peer) => peer.pid === pid && peer.uid === io.ownerUid,
						Math.min(1_000, left()),
					))
				) {
					const after = await readShow(
						io,
						Math.min(SYSTEMCTL_TIMEOUT_MS, left()),
					);
					ready =
						isRunning(after) &&
						after.invocation === before.invocation &&
						after.mainPid === pid &&
						after.controlGroup === before.controlGroup &&
						io.now() < deadline;
				}
				if (ready)
					return {
						pid,
						invocation: before.invocation,
						controlGroup: before.controlGroup,
						pidfd,
					};
			} finally {
				if (!ready && pidfd !== null) io.pidfdClose(pidfd);
			}
		}
		left();
		await io.sleep(Math.min(READY_POLL_MS, left()));
	}
}

function downError(io: SenderUnitIo, show: UnitShow): SenderUnitError {
	const { exitCode, signalCode } = mainExit(show);
	const detail = `${io.unit} is ${show.activeState} (result ${show.result || "unknown"}, exit ${
		exitCode ?? signalCode
	})`;
	if (exitCode === LAUNCHER_REFUSED_EXIT)
		return new SenderUnitError("launcher_refused", detail);
	if (exitCode === 2) return new SenderUnitError("sender_usage", detail);
	return new SenderUnitError("start_refused", detail);
}

/**
 * Stop the unit and see it down. `systemctl stop` also cancels a start job
 * still queued. Launch state of `generation` is removed only once the unit is
 * confirmed down with no main process; otherwise null and everything is kept.
 */
async function stopUnit(
	io: SenderUnitIo,
	generation: number,
	deadline = io.now() + STOP_TIMEOUT_MS + SYSTEMCTL_TIMEOUT_MS,
): Promise<UnitShow | null> {
	const left = (cap: number): number =>
		Math.max(1, Math.min(cap, deadline - io.now()));
	try {
		await io.systemctl(["stop", io.unit], left(STOP_TIMEOUT_MS));
	} catch (error) {
		logger.warn(`systemctl stop ${io.unit} failed`, { error });
	}
	let show: UnitShow;
	try {
		show = await readShow(io, left(SYSTEMCTL_TIMEOUT_MS));
	} catch (error) {
		logger.warn(`${io.unit} unreadable after stop`, { error });
		return null;
	}
	if (!confirmedDown(show)) {
		logger.error(
			`${io.unit} is still ${show.activeState} after stop; launch state kept`,
		);
		return null;
	}
	await removeLaunchStateOf(io, generation);
	return show;
}

export type SenderUnitHooks = {
	/** systemd is restarting the sender: the previous process has exited. */
	onRestarting?(show: UnitShow): void;
	/** The restarted sender is ready; the handle now follows its process. */
	onRestarted?(handle: SenderUnitProcess): void;
};

/**
 * Publish the sender's arguments and start its unit; resolves once the sender
 * is ready. A failure stops the unit again and rejects with a
 * {@link SenderUnitError}; when that stop cannot be confirmed the launch state
 * is kept and no sender may start until the unit is seen down.
 */
export function startSenderUnit(
	args: readonly string[],
	hooks: SenderUnitHooks = {},
): Promise<SenderUnitProcess> {
	const io = unitIo();
	return serialized(async () => {
		if (blocked)
			throw new SenderUnitError(
				blockKind === "held" ? "unit_held" : "unit_unresolved",
				blocked,
			);
		const payload = encodeSenderArgv(args);
		const lock = await io.tryUpdateLock().catch((error) => {
			throw new SenderUnitError(
				"start_refused",
				`cannot take the update lock: ${(error as Error).message}`,
			);
		});
		if (!lock)
			throw new SenderUnitError(
				"update_in_progress",
				"an update holds the update lock",
			);
		try {
			const current = await readShow(io);
			if (current.loadState !== "loaded")
				throw new SenderUnitError(
					"start_refused",
					`${io.unit} is not installed`,
				);
			if (!confirmedDown(current))
				throw new SenderUnitError(
					"unit_busy",
					`${io.unit} is already ${current.activeState}; refusing a second sender`,
				);
			if (!(await directoryIsPrivate(io)))
				throw new SenderUnitError(
					"unsafe_directory",
					`${io.paths.dir} is missing or not private to root`,
				);
			const generation = ++launchGeneration;
			// The unit is down, so no sender owns these; a new one must not read
			// an old stats file or find an old socket.
			if (!(await removeFiles(io, launchState(io))))
				throw new SenderUnitError(
					"start_refused",
					"stale launch state could not be removed",
				);
			await publishArgv(io, payload);
			const fail = async (error: SenderUnitError): Promise<never> => {
				if (!(await stopUnit(io, generation))) {
					blockUntilSettled(
						`${io.unit} could not be confirmed stopped`,
						"owed_stop",
					);
					throw new SenderUnitError(
						"stop_unconfirmed",
						`${error.message}; and ${io.unit} could not be confirmed stopped`,
					);
				}
				throw error;
			};
			try {
				await io.systemctl(["start", io.unit], SYSTEMCTL_TIMEOUT_MS);
			} catch (error) {
				const show = await readShow(io).catch(() => null);
				return await fail(
					show &&
						isDown(show) &&
						show.execMainCode !== null &&
						show.invocation !== current.invocation
						? downError(io, show)
						: new SenderUnitError(
								"start_refused",
								`systemctl start ${io.unit} failed: ${(error as Error).message}`,
							),
				);
			}
			let ready: Ready;
			try {
				ready = await awaitReady(io);
			} catch (error) {
				return await fail(
					error instanceof SenderUnitError
						? error
						: new SenderUnitError("not_ready", (error as Error).message),
				);
			}
			return new SenderUnitProcess(io, ready, generation, hooks);
		} finally {
			lock.release();
		}
	});
}

/**
 * At backend startup, and again every 5 s while blocked: settle what the unit
 * is doing before anything may start a sender.
 *
 * - Not installed, or confirmed down: nothing runs. Stale launch state is
 *   removed (unit mode) and the block is lifted.
 * - Anything else (running, starting, waiting to restart, stopping): an
 *   earlier backend started that sender, or its stop is still finishing. It is
 *   **held**: nothing signals or stops it, no file is removed, and every start
 *   stays refused, so no second sender runs beside it. The census reads
 *   unknown meanwhile, so the session stays unconfirmed and protected. The
 *   operator's Stop ends it ({@link stopHeldSenderUnit}); otherwise the hold
 *   ends when systemd reports the unit down on its own.
 * - This backend's own unconfirmed stop (a failed start): stopped again.
 * - Unreadable: blocked, retried. A held unit stays held through a failed read.
 *
 * Runs whenever the flag is on, also when the backend fell back to child
 * mode, because an installed unit may still run a sender.
 */
export function settleSenderUnit(): Promise<
	"none" | "held" | "stopped" | "unknown"
> {
	const io = hostIo;
	if (!io) return Promise.resolve("none");
	return serialized(async () => {
		if (blocked === null) return "none";
		if (blockKind === "mode") {
			const reason = await decideMode(1);
			if (reason) {
				blockUntilSettled(reason, "mode");
				return "unknown";
			}
			blockKind = "unchecked";
		}
		let show: UnitShow;
		try {
			show = await readShow(io);
		} catch {
			if (held) {
				blockUntilSettled(blocked ?? "held", "held");
				return "held";
			}
			blockUntilSettled(
				`${io.unit} cannot be read`,
				blockKind === "owed_stop" ? "owed_stop" : "unchecked",
			);
			return "unknown";
		}
		if (show.job === null) {
			// No Job= row: whether a start or stop job is queued is unknown.
			blockUntilSettled(
				blocked ?? `${io.unit} cannot be read`,
				blockKind ?? "unchecked",
			);
			return held ? "held" : "unknown";
		}
		// Load state is never runtime evidence: a `not-found` or `masked` unit can
		// still run its main process. Only a confirmed down releases.
		if (confirmedDown(show)) {
			if (held)
				logger.info(
					`${io.unit} from an earlier backend is down; no longer held`,
					{ result: show.result },
				);
			// Down, so no sender owns these; nothing of ours can start while blocked.
			if (hostMode === "unit") await removeFiles(io, launchState(io));
			releaseBlock();
			return "none";
		}
		if (blockKind === "owed_stop") {
			if (!(await stopUnit(io, hostMode === "unit" ? launchGeneration : -1))) {
				blockUntilSettled(
					`${io.unit} could not be confirmed stopped`,
					"owed_stop",
				);
				return "unknown";
			}
			releaseBlock();
			return "stopped";
		}
		const newlyHeld = held === null;
		if (newlyHeld)
			logger.warn(
				`${io.unit} is ${show.activeState} from an earlier backend; keeping it running and starting no sender beside it until it is stopped`,
				{
					subState: show.subState,
					invocation: show.invocation,
					mainPid: show.mainPid,
					job: show.job,
				},
			);
		held = {
			activeState: show.activeState,
			subState: show.subState,
			invocation: show.invocation,
			mainPid: show.mainPid,
		};
		blockUntilSettled(
			`${io.unit} is ${show.activeState} from an earlier backend`,
			"held",
		);
		if (newlyHeld) announceHold("held");
		return "held";
	});
}

/**
 * The stop path for a sender this backend did not start, or whose unit state
 * it has not settled yet: one fresh look at the unit, then, unless it is
 * confirmed down, `systemctl stop` by name and a confirmed down, all within
 * `budgetMs` (counted from the call, so a wait behind the retry counts too).
 *
 * - Nothing blocked (an owned sender stops through its own handle): nothing.
 * - Unreadable, or no `Job=` row: {@link SenderUnitError} `unit_unresolved`;
 *   the block stays, so the stop fails rather than claim no sender runs.
 * - Not confirmed down after the stop: `stop_unconfirmed`; the block stays.
 * - Confirmed down: launch state removed (unit mode), the mode settled if it
 *   was not yet, the block lifted.
 */
export function stopHeldSenderUnit(
	budgetMs = STOP_TIMEOUT_MS + SYSTEMCTL_TIMEOUT_MS,
): Promise<"none" | "stopped"> {
	const io = hostIo;
	if (!io) return Promise.resolve("none");
	const deadline = io.now() + budgetMs;
	return serialized(async () => {
		if (blocked === null || blockKind === null) return "none";
		const kind = blockKind;
		const reason = blocked;
		const unresolved = (why: string): never => {
			blockUntilSettled(reason, kind);
			throw new SenderUnitError("unit_unresolved", why);
		};
		let show: UnitShow;
		try {
			show = await readShow(
				io,
				Math.max(1, Math.min(SYSTEMCTL_TIMEOUT_MS, deadline - io.now())),
			);
		} catch {
			return unresolved(`${io.unit} cannot be read; the stop is not confirmed`);
		}
		if (show.job === null)
			return unresolved(`${io.unit} answered without a job state`);
		if (!confirmedDown(show)) {
			logger.warn(`stopping ${io.unit}, which this backend did not start`, {
				activeState: show.activeState,
				invocation: show.invocation,
			});
			if (
				!(await stopUnit(
					io,
					hostMode === "unit" ? launchGeneration : -1,
					deadline,
				))
			) {
				blockUntilSettled(reason, kind);
				throw new SenderUnitError(
					"stop_unconfirmed",
					`${io.unit} could not be confirmed stopped`,
				);
			}
		} else if (hostMode === "unit") {
			await removeFiles(io, launchState(io));
		}
		if (kind === "mode") {
			// Down, but the backend has not decided its host yet: decide it now,
			// so lifting the block does not leave the mode undecided.
			const why = await decideMode(1);
			if (why) return unresolved(why);
		}
		// Stopped on request: the session settles through the stop itself.
		releaseBlock("stopped");
		return "stopped";
	});
}

// ---------------------------------------------------------------------------
// The handle
// ---------------------------------------------------------------------------

const RESTART_READY_LIMIT_MS = 15_000;
const STOP_RETRY_MS = 2_000;

/**
 * A process handle over the sender unit. It follows the unit's main process
 * across systemd restarts and reports a final exit only when the unit is
 * confirmed down: stopped by this handle, or given up by systemd (a refused
 * argument file, a usage error, the start limit). A stop that cannot be
 * confirmed is retried; the handle stays live (and the stream stays
 * protected) until it is.
 */
export class SenderUnitProcess implements SupervisedProc {
	private current: Ready;
	private ready = true;
	private restarting = false;
	/** The invocation whose stats file was last cleared for a restart. */
	private clearedFor: string | null = null;
	private notReadySince: number | null = null;
	private stopping: Promise<void> | null = null;
	private finished = false;
	/** Left running at backend shutdown: nothing may act on the unit any more. */
	private detached = false;
	private resolveExit: (code: number) => void = () => undefined;
	private cancelScheduled: (() => void) | null = null;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly exited: Promise<number>;

	constructor(
		private readonly io: SenderUnitIo,
		ready: Ready,
		private readonly generation: number,
		private readonly hooks: SenderUnitHooks,
	) {
		this.current = ready;
		this.exited = new Promise((resolve) => {
			this.resolveExit = resolve;
		});
		this.schedule();
	}

	get pid(): number {
		return this.current.pid;
	}

	get invocation(): string {
		return this.current.invocation;
	}

	/** Verified ready now: the census, reload and reconciliation rely on it. */
	get isReady(): boolean {
		return (
			this.ready && !this.finished && !this.detached && this.stopping === null
		);
	}

	/**
	 * Verified ready and the process still alive now: the pinned pidfd is not
	 * readable (a pidfd turns readable once its process has exited, also
	 * before it is reaped, where signal 0 would still succeed), or, without a
	 * pin, the PID is still `srtla_send` in the unit's cgroup. Reconciliation
	 * relies on this between monitor reads.
	 */
	isCurrent(): boolean {
		if (!this.isReady) return false;
		const { pid, pidfd, controlGroup } = this.current;
		if (pidfd !== null) return this.io.pidfdAlive(pidfd);
		return (
			this.io.readComm(pid) === "srtla_send" &&
			this.io.readCgroup(pid) === controlGroup
		);
	}

	owns(pid: number, procRoot: string): boolean {
		return (
			this.isReady &&
			pid === this.current.pid &&
			this.io.readCgroup(pid, procRoot) === this.current.controlGroup
		);
	}

	/**
	 * The backend is shutting down: leave the sender running in its unit for
	 * the next backend to hold, and stop following it. A stop already in
	 * flight is not abandoned (false), so shutdown waits for it as before.
	 */
	leaveRunningOnShutdown(): boolean {
		if (this.finished || this.stopping) return false;
		this.detached = true;
		this.cancelTimer();
		this.ready = false;
		logger.warn(
			`${this.io.unit}: leaving the sender running across the backend shutdown`,
			{ pid: this.current.pid, invocation: this.current.invocation },
		);
		return true;
	}

	kill(signal: NodeJS.Signals | number = "SIGTERM"): void {
		if (this.finished) return;
		if (signal === "SIGHUP" || signal === 1) {
			this.trySignal("SIGHUP");
			return;
		}
		void this.stop();
		if (signal === "SIGKILL" || signal === 9) this.escalate();
	}

	/**
	 * Deliver `signal` to the sender process itself, only while it is verified
	 * ready. True only when the kernel took the signal for that process.
	 */
	trySignal(signal: NodeJS.Signals): boolean {
		const { pid, pidfd, controlGroup } = this.current;
		if (!this.isReady) {
			logger.warn(
				`${this.io.unit}: ${signal} not delivered, the sender is not ready`,
			);
			return false;
		}
		if (pidfd !== null) return this.io.pidfdSignal(pidfd, signal);
		if (
			this.io.readComm(pid) !== "srtla_send" ||
			this.io.readCgroup(pid) !== controlGroup
		)
			return false;
		try {
			this.io.signal(pid, signal);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * SIGKILL to the process this handle pinned. Without a pin there is no
	 * escalation by unit name: systemd's own stop job sends SIGKILL after
	 * TimeoutStopSec.
	 */
	private escalate(): void {
		const { pidfd } = this.current;
		if (pidfd !== null) this.io.pidfdSignal(pidfd, "SIGKILL");
	}

	/** Stop the unit (final: systemd does not restart it) and end the handle. */
	stop(): Promise<void> {
		// Left running for the next backend: a late continuation must not stop it.
		if (this.detached) return Promise.resolve();
		this.stopping ??= this.runStop();
		return this.stopping;
	}

	private async runStop(): Promise<void> {
		this.cancelTimer();
		for (;;) {
			if (this.finished) return;
			const show = await serialized(async () =>
				// A newer start owns the unit: it only started once this
				// handle's unit was confirmed down, so there is nothing to stop.
				this.generation === launchGeneration
					? stopUnit(this.io, this.generation)
					: "superseded",
			);
			if (show === "superseded") {
				this.finishUnknown();
				return;
			}
			if (show) {
				// Stopped on request: an exit systemd did not keep reads as SIGTERM.
				this.finish(show, { exitCode: null, signalCode: "SIGTERM" });
				return;
			}
			logger.error(`${this.io.unit}: stop not confirmed; retrying`);
			await this.io.sleep(STOP_RETRY_MS);
		}
	}

	private finish(
		show: UnitShow,
		unknown?: { exitCode: number | null; signalCode: NodeJS.Signals | null },
	): void {
		if (this.finished) return;
		this.finished = true;
		this.ready = false;
		this.cancelTimer();
		if (this.current.pidfd !== null) this.io.pidfdClose(this.current.pidfd);
		const exit = mainExit(show, unknown);
		this.exitCode = exit.exitCode;
		this.signalCode = exit.signalCode;
		this.resolveExit(
			exit.exitCode ??
				128 + (osConstants.signals[exit.signalCode ?? "SIGKILL"] ?? 9),
		);
	}

	/** Ended without a readable exit: as if stopped on request. */
	private finishUnknown(): void {
		this.finish(
			{
				loadState: "",
				activeState: "inactive",
				subState: "",
				mainPid: 0,
				invocation: "",
				controlGroup: "",
				result: "",
				execMainCode: null,
				execMainStatus: null,
				restarts: 0,
				job: "",
			},
			{ exitCode: null, signalCode: "SIGTERM" },
		);
	}

	private schedule(): void {
		if (this.finished || this.stopping || this.detached) return;
		this.cancelScheduled = this.io.schedule(() => {
			this.cancelScheduled = null;
			void this.tick().finally(() => this.schedule());
		}, MONITOR_INTERVAL_MS);
	}

	private cancelTimer(): void {
		this.cancelScheduled?.();
		this.cancelScheduled = null;
	}

	private markNotReady(): void {
		this.ready = false;
		this.notReadySince ??= this.io.now();
	}

	/** One look at the unit; public for tests that drive time themselves. */
	/** Whether this handle may still act on what a monitor read found. */
	private get acting(): boolean {
		return !this.finished && this.stopping === null && !this.detached;
	}

	async tick(): Promise<void> {
		if (!this.acting) return;
		let show: UnitShow;
		try {
			show = await readShow(this.io);
		} catch (error) {
			// Unknown is not ready: nothing may rely on the sender until a
			// good read re-verifies it.
			if (!this.acting) return;
			this.markNotReady();
			logger.warn(`${this.io.unit}: cannot read the unit`, { error });
			return this.checkWedged();
		}
		if (!this.acting) return;
		if (confirmedDown(show)) {
			const { exitCode, signalCode } = mainExit(show);
			logger.warn(
				`${this.io.unit} is ${show.activeState}; systemd will not restart it`,
				{
					result: show.result,
					exitCode,
					signal: signalCode,
				},
			);
			this.finish(show);
			// Down for good; a newer start may already own the files.
			await serialized(() => removeLaunchStateOf(this.io, this.generation));
			return;
		}
		const same =
			show.invocation === this.current.invocation &&
			show.mainPid === this.current.pid &&
			show.controlGroup === this.current.controlGroup;
		if (same && isRunning(show) && this.ready) return;
		if (!same && !this.restarting) {
			if (!(await this.beginRestart(show))) return;
		}
		if (!isRunning(show)) {
			this.markNotReady();
			return this.checkWedged();
		}
		let ready: Ready;
		try {
			ready = await awaitReady(this.io);
		} catch (error) {
			if (!this.acting) return;
			if (!(error instanceof SenderUnitError) || error.reason === "not_ready")
				logger.warn(`${this.io.unit}: the sender is not ready`, { error });
			return this.checkWedged();
		}
		if (!this.acting) {
			if (ready.pidfd !== null) this.io.pidfdClose(ready.pidfd);
			return;
		}
		// Readiness may return a process other than the one last verified: a
		// restart during a re-probe of the same invocation, or a second crash
		// before the first restart was ready. Every identity change goes
		// through restart bookkeeping, and the stats file is cleared for the
		// invocation that is actually adopted, before readiness is published.
		const switched =
			ready.invocation !== this.current.invocation ||
			ready.pid !== this.current.pid ||
			ready.controlGroup !== this.current.controlGroup;
		if (switched && !this.restarting) {
			const replaced: UnitShow = {
				...show,
				invocation: ready.invocation,
				mainPid: ready.pid,
				controlGroup: ready.controlGroup,
			};
			if (!(await this.beginRestart(replaced))) {
				if (ready.pidfd !== null) this.io.pidfdClose(ready.pidfd);
				return;
			}
		} else if (this.restarting && this.clearedFor !== ready.invocation) {
			if (!(await this.clearStats(ready.invocation))) {
				if (ready.pidfd !== null) this.io.pidfdClose(ready.pidfd);
				return;
			}
		}
		// The cleanup above awaited: the process readiness found may have exited
		// since (and a successor may own the files). Publish only a live pin.
		const pinLive =
			ready.pidfd !== null
				? this.io.pidfdAlive(ready.pidfd)
				: this.io.readComm(ready.pid) === "srtla_send" &&
					this.io.readCgroup(ready.pid) === ready.controlGroup;
		if (!this.acting || !pinLive) {
			if (ready.pidfd !== null) this.io.pidfdClose(ready.pidfd);
			if (this.acting) this.markNotReady();
			return;
		}
		if (this.current.pidfd !== null) this.io.pidfdClose(this.current.pidfd);
		this.current = ready;
		this.ready = true;
		this.notReadySince = null;
		if (this.restarting) {
			this.restarting = false;
			logger.info(`${this.io.unit}: the restarted sender is ready`, {
				pid: ready.pid,
				invocation: ready.invocation,
			});
			this.hooks.onRestarted?.(this);
		}
	}

	/**
	 * The process this handle followed has exited and systemd is restarting
	 * it: report the exit and clear the dead sender's stats file. False when
	 * the file could not be removed; the sender is then stopped.
	 */
	private async beginRestart(show: UnitShow): Promise<boolean> {
		this.restarting = true;
		this.markNotReady();
		const { exitCode, signalCode } = mainExit(show);
		logger.warn(`${this.io.unit}: the sender exited; systemd restarts it`, {
			exitCode,
			signal: signalCode,
			restarts: show.restarts,
		});
		this.hooks.onRestarting?.(show);
		return this.clearStats(show.invocation);
	}

	/**
	 * Remove the stats file for invocation `invocation`, so an earlier
	 * sender's last stats never pass for this one's. If it cannot be removed,
	 * file telemetry could not be trusted: stop the sender rather than run blind.
	 */
	private async clearStats(invocation: string): Promise<boolean> {
		const cleared = await serialized(() =>
			this.generation === launchGeneration
				? removeFiles(this.io, [this.io.paths.statsFile])
				: Promise.resolve(true),
		);
		if (!cleared) {
			logger.error(
				`${this.io.unit}: the old stats file could not be removed; stopping the sender`,
			);
			void this.stop();
			return false;
		}
		this.clearedFor = invocation;
		return true;
	}

	/** A sender that stays unready this long is stopped: the stream ends. */
	private checkWedged(): void {
		if (!this.acting || this.notReadySince === null) return;
		if (this.io.now() - this.notReadySince < RESTART_READY_LIMIT_MS) return;
		logger.error(
			`${this.io.unit}: the sender has not been ready for ${RESTART_READY_LIMIT_MS} ms; stopping it`,
		);
		void this.stop();
	}
}
