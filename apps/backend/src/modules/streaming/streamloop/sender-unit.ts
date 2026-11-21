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
 * - **Leftovers.** A backend that starts and finds the unit running did not
 *   start that sender. Nothing adopts it yet, so it is stopped and the launch
 *   state is removed before anything else streams.
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
};

/** Parse `systemctl show --property=...` output; null when it is not one. */
export function parseUnitShow(stdout: string): UnitShow | null {
	const rows = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		const at = line.indexOf("=");
		if (at > 0) rows.set(line.slice(0, at), line.slice(at + 1).trim());
	}
	if (!rows.has("LoadState") || !rows.has("ActiveState")) return null;
	const int = (key: string): number | null => {
		const value = rows.get(key);
		return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
	};
	return {
		loadState: rows.get("LoadState") ?? "",
		activeState: rows.get("ActiveState") ?? "",
		subState: rows.get("SubState") ?? "",
		mainPid: int("MainPID") ?? 0,
		invocation: rows.get("InvocationID") ?? "",
		controlGroup: rows.get("ControlGroup") ?? "",
		result: rows.get("Result") ?? "",
		execMainCode: int("ExecMainCode"),
		execMainStatus: int("ExecMainStatus"),
		restarts: int("NRestarts") ?? 0,
	};
}

/** Neither running, starting, waiting to restart nor stopping. */
function isDown(show: UnitShow): boolean {
	return show.activeState === "inactive" || show.activeState === "failed";
}

function isRunning(show: UnitShow): boolean {
	return (
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
	| "unit_unreadable";

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
	): Promise<boolean>;
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
		probeControl: async (socketPath, accept) => {
			const client = await createControlClient({
				socketPath,
				timeoutMs: 1_000,
				verifyPeer: async (fd) => {
					const peer = await readPeerCredentials(fd);
					return peer !== null && accept(peer);
				},
			});
			if (!client) return false;
			try {
				// A pre-capability sender answers "method not found", which is
				// still an answer from the verified peer.
				await client.getCapabilities();
				return true;
			} catch {
				return false;
			} finally {
				client.close();
			}
		},
		tryUpdateLock: () => tryExclusiveLock(SOFTWARE_UPDATE_LOCK),
		signal: (pid, signal) => {
			process.kill(pid, signal);
		},
		now: () => Date.now(),
		sleep: (ms) => Bun.sleep(ms),
		schedule: (fn, ms) => {
			const timer = setTimeout(fn, ms);
			return () => clearTimeout(timer);
		},
	};
}

// ---------------------------------------------------------------------------
// Mode: decided once at startup
// ---------------------------------------------------------------------------

export type SenderHostMode = "child" | "unit";

let hostMode: SenderHostMode = "child";
let hostIo: SenderUnitIo | null = null;

export function senderHostMode(): SenderHostMode {
	return hostMode;
}

/** The private paths of the unit host, or null in child mode. */
export function senderUnitHostPaths(): SenderUnitPaths | null {
	return hostMode === "unit" && hostIo ? hostIo.paths : null;
}

/** The I/O of the active unit host; only valid in unit mode. */
function unitIo(): SenderUnitIo {
	if (!hostIo) throw new Error("sender unit host is not active");
	return hostIo;
}

export function resetSenderHostModeForTest(): void {
	hostMode = "child";
	hostIo = null;
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
 * Decide, once, whether this backend runs the sender through its unit.
 *
 * Flag off (the default): child mode, without reading anything. Flag on: unit
 * mode only when the unit is installed, the launcher's directory is root-only
 * and the sender executable is the one the launcher runs; otherwise a warning
 * and child mode. In unit mode the IP list and bind map move into the private
 * directory here, before anything writes them, so writer and readers agree.
 */
export async function resolveSenderHostMode(
	setup: SenderSetup,
	senderExec: string,
	io: SenderUnitIo = productionSenderUnitIo(),
): Promise<SenderHostMode> {
	hostMode = "child";
	hostIo = null;
	if (setup.srtla_send_unit !== true) return hostMode;
	const refuse = (why: string): SenderHostMode => {
		logger.warn(
			`srtla_send_unit is set, but ${why}; the sender runs as a child of the backend`,
		);
		return hostMode;
	};
	if (senderExec !== SENDER_UNIT_EXEC)
		return refuse(
			`the sender is ${senderExec}, and the unit runs only ${SENDER_UNIT_EXEC}`,
		);
	let show: UnitShow | null = null;
	try {
		show = parseUnitShow(await showUnit(io));
	} catch {
		show = null;
	}
	if (show?.loadState !== "loaded")
		return refuse(`${io.unit} is not installed`);
	if (!(await directoryIsPrivate(io)))
		return refuse(`${io.paths.dir} is missing or not private to root`);
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
	hostIo = io;
	logger.info(`srtla_send runs through ${io.unit}`, { dir: io.paths.dir });
	return hostMode;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

let transitions: Promise<unknown> = Promise.resolve();

/** Run `step` after every earlier publication, start or stop has finished. */
function serialized<T>(step: () => Promise<T>): Promise<T> {
	const next = transitions.then(step, step);
	transitions = next.catch(() => undefined);
	return next;
}

function showUnit(io: SenderUnitIo): Promise<string> {
	return io.systemctl(
		["show", io.unit, `--property=${SHOW_PROPERTIES.join(",")}`],
		SYSTEMCTL_TIMEOUT_MS,
	);
}

async function readShow(io: SenderUnitIo): Promise<UnitShow> {
	let show: UnitShow | null = null;
	try {
		show = parseUnitShow(await showUnit(io));
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
		throw error;
	}
}

/** Files only a sender of this unit writes; stale once the unit is down. */
async function removeLaunchState(io: SenderUnitIo): Promise<void> {
	for (const path of [
		io.paths.argv,
		io.paths.statsFile,
		io.paths.controlSocket,
	])
		await io
			.remove(path)
			.catch((error) => logger.warn(`could not remove ${path}`, { error }));
}

type Ready = { pid: number; invocation: string; controlGroup: string };

/**
 * Wait until the unit's sender answers on its control socket.
 *
 * Ready means: the unit is active and running; its MainPID is `srtla_send`
 * (the launcher has replaced itself) inside the unit's cgroup; a fresh control
 * RPC succeeded on a connection whose SO_PEERCRED PID is that MainPID and UID
 * the owner; and InvocationID and MainPID read after the RPC are the ones read
 * before it. A unit that goes down meanwhile fails at once with its exit.
 */
async function awaitReady(
	io: SenderUnitIo,
	timeoutMs = READY_TIMEOUT_MS,
): Promise<Ready> {
	const deadline = io.now() + timeoutMs;
	for (;;) {
		const before = await readShow(io);
		if (isDown(before)) throw downError(io, before);
		if (isRunning(before)) {
			const pid = before.mainPid;
			if (
				io.readComm(pid) === "srtla_send" &&
				io.readCgroup(pid) === before.controlGroup &&
				(await io.probeControl(
					io.paths.controlSocket,
					(peer) => peer.pid === pid && peer.uid === io.ownerUid,
				))
			) {
				const after = await readShow(io);
				if (
					isRunning(after) &&
					after.invocation === before.invocation &&
					after.mainPid === pid
				)
					return {
						pid,
						invocation: before.invocation,
						controlGroup: before.controlGroup,
					};
			}
		}
		if (io.now() >= deadline)
			throw new SenderUnitError(
				"not_ready",
				`${io.unit} did not answer on ${io.paths.controlSocket} within ${timeoutMs} ms`,
			);
		await io.sleep(READY_POLL_MS);
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

/** Stop the unit and see it down; removes launch state only once it is. */
async function stopUnit(io: SenderUnitIo): Promise<UnitShow | null> {
	try {
		await io.systemctl(["stop", io.unit], STOP_TIMEOUT_MS);
	} catch (error) {
		logger.warn(`systemctl stop ${io.unit} failed`, { error });
	}
	let show: UnitShow | null = null;
	try {
		show = await readShow(io);
	} catch (error) {
		logger.warn(`${io.unit} unreadable after stop`, { error });
		return null;
	}
	if (!isDown(show) || show.mainPid !== 0) {
		logger.error(
			`${io.unit} is still ${show.activeState} after stop; launch state kept`,
		);
		return null;
	}
	await removeLaunchState(io);
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
 * is ready. Any failure stops the unit again (so a refused start leaves
 * nothing running) and rejects with a {@link SenderUnitError}.
 */
export function startSenderUnit(
	args: readonly string[],
	hooks: SenderUnitHooks = {},
): Promise<SenderUnitProcess> {
	const io = unitIo();
	return serialized(async () => {
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
			if (!isDown(current))
				throw new SenderUnitError(
					"unit_busy",
					`${io.unit} is already ${current.activeState}; refusing a second sender`,
				);
			if (!(await directoryIsPrivate(io)))
				throw new SenderUnitError(
					"unsafe_directory",
					`${io.paths.dir} is missing or not private to root`,
				);
			// The unit is down, so no sender owns these; a new one must not read
			// an old stats file or find an old socket.
			await removeLaunchState(io);
			await publishArgv(io, payload);
			let started = false;
			try {
				await io.systemctl(["start", io.unit], SYSTEMCTL_TIMEOUT_MS);
				started = true;
			} catch (error) {
				const show = await readShow(io).catch(() => null);
				// A start that timed out may still be coming up: never leave it.
				if (!show || !isDown(show)) await stopUnit(io);
				if (
					show &&
					isDown(show) &&
					show.execMainCode !== null &&
					show.invocation !== current.invocation
				)
					throw downError(io, show);
				throw new SenderUnitError(
					"start_refused",
					`systemctl start ${io.unit} failed: ${(error as Error).message}`,
				);
			} finally {
				if (!started) await removeLaunchState(io);
			}
			try {
				const ready = await awaitReady(io);
				return new SenderUnitProcess(io, ready, hooks);
			} catch (error) {
				await stopUnit(io);
				throw error;
			}
		} finally {
			lock.release();
		}
	});
}

/**
 * At backend startup: a sender unit that is running was started by an
 * earlier backend. This build does not adopt it (the adoption verdict belongs
 * here once it exists), so it is stopped and seen down, and stale launch state
 * is removed. Child mode does nothing.
 */
export function retireLeftoverSenderUnit(): Promise<
	"none" | "stopped" | "unknown"
> {
	if (hostMode !== "unit") return Promise.resolve("none");
	const io = unitIo();
	return serialized(async () => {
		let show: UnitShow;
		try {
			show = await readShow(io);
		} catch (error) {
			logger.warn("cannot read the sender unit at startup", { error });
			return "unknown";
		}
		if (isDown(show)) {
			await removeLaunchState(io);
			return "none";
		}
		logger.warn(
			`${io.unit} is ${show.activeState} from an earlier backend; this build does not adopt it, stopping it`,
			{ invocation: show.invocation, mainPid: show.mainPid },
		);
		return (await stopUnit(io)) ? "stopped" : "unknown";
	});
}

// ---------------------------------------------------------------------------
// The handle
// ---------------------------------------------------------------------------

/**
 * A process handle over the sender unit. It follows the unit's main process
 * across systemd restarts and reports a final exit only when the unit is
 * down: stopped by this handle, or given up by systemd (a refused argument
 * file, a usage error, the start limit).
 */
export class SenderUnitProcess implements SupervisedProc {
	private current: Ready;
	private ready = true;
	private restarting = false;
	private stopping: Promise<void> | null = null;
	private finished = false;
	private resolveExit: (code: number) => void = () => undefined;
	private cancelScheduled: (() => void) | null = null;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly exited: Promise<number>;

	constructor(
		private readonly io: SenderUnitIo,
		ready: Ready,
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

	get isReady(): boolean {
		return this.ready && !this.finished;
	}

	owns(pid: number, procRoot: string): boolean {
		return (
			this.isReady &&
			pid === this.current.pid &&
			this.io.readCgroup(pid, procRoot) === this.current.controlGroup
		);
	}

	kill(signal: NodeJS.Signals | number = "SIGTERM"): void {
		if (this.finished) return;
		if (signal === "SIGHUP" || signal === 1) {
			this.reload();
			return;
		}
		void this.stop();
		if (signal === "SIGKILL" || signal === 9)
			void this.io
				.systemctl(
					["kill", "--signal=SIGKILL", this.io.unit],
					SYSTEMCTL_TIMEOUT_MS,
				)
				.catch((error) =>
					logger.warn(`SIGKILL to ${this.io.unit} failed`, { error }),
				);
	}

	/** SIGHUP to the sender itself, only while it is ready and still ours. */
	private reload(): void {
		const pid = this.current.pid;
		if (
			!this.isReady ||
			this.io.readComm(pid) !== "srtla_send" ||
			this.io.readCgroup(pid) !== this.current.controlGroup
		) {
			logger.warn(
				`${this.io.unit}: reload not delivered, the sender is not ready`,
			);
			return;
		}
		this.io.signal(pid, "SIGHUP");
	}

	/** Stop the unit (final: systemd does not restart it) and end the handle. */
	stop(): Promise<void> {
		this.stopping ??= serialized(async () => {
			this.cancelTimer();
			if (this.finished) return;
			const show = await stopUnit(this.io);
			// Stopped on request: an exit systemd did not keep reads as SIGTERM.
			this.finish(show, { exitCode: null, signalCode: "SIGTERM" });
		});
		return this.stopping;
	}

	private finish(
		show: UnitShow | null,
		unknown?: { exitCode: number | null; signalCode: NodeJS.Signals | null },
	): void {
		if (this.finished) return;
		this.finished = true;
		this.ready = false;
		this.cancelTimer();
		// No readable unit after a stop: the sender's end is not confirmed.
		const exit = show
			? mainExit(show, unknown)
			: { exitCode: null, signalCode: "SIGKILL" as const };
		this.exitCode = exit.exitCode;
		this.signalCode = exit.signalCode;
		this.resolveExit(
			exit.exitCode ??
				128 + (osConstants.signals[exit.signalCode ?? "SIGKILL"] ?? 9),
		);
	}

	private schedule(): void {
		if (this.finished || this.stopping) return;
		this.cancelScheduled = this.io.schedule(() => {
			this.cancelScheduled = null;
			void this.tick().finally(() => this.schedule());
		}, MONITOR_INTERVAL_MS);
	}

	private cancelTimer(): void {
		this.cancelScheduled?.();
		this.cancelScheduled = null;
	}

	/** One look at the unit; public for tests that drive time themselves. */
	async tick(): Promise<void> {
		if (this.finished || this.stopping) return;
		let show: UnitShow;
		try {
			show = await readShow(this.io);
		} catch (error) {
			logger.warn(`${this.io.unit}: cannot read the unit`, { error });
			return;
		}
		if (this.finished || this.stopping) return;
		if (isDown(show)) {
			const { exitCode, signalCode } = mainExit(show);
			logger.warn(
				`${this.io.unit} is ${show.activeState}; systemd will not restart it`,
				{
					result: show.result,
					exitCode,
					signal: signalCode,
				},
			);
			// Down for good: nothing of this sender's launch state is current.
			await removeLaunchState(this.io);
			this.finish(show);
			return;
		}
		const same =
			show.invocation === this.current.invocation &&
			show.mainPid === this.current.pid;
		if (same && !this.restarting) return;
		if (!this.restarting) {
			this.restarting = true;
			this.ready = false;
			const { exitCode, signalCode } = mainExit(show);
			logger.warn(`${this.io.unit}: the sender exited; systemd restarts it`, {
				exitCode,
				signal: signalCode,
				restarts: show.restarts,
			});
			this.hooks.onRestarting?.(show);
		}
		if (!isRunning(show)) return;
		try {
			const ready = await awaitReady(this.io);
			if (this.finished || this.stopping) return;
			this.current = ready;
			this.ready = true;
			this.restarting = false;
			logger.info(`${this.io.unit}: the restarted sender is ready`, {
				pid: ready.pid,
				invocation: ready.invocation,
			});
			this.hooks.onRestarted?.(this);
		} catch (error) {
			if (error instanceof SenderUnitError && error.reason !== "not_ready")
				return;
			logger.warn(`${this.io.unit}: the restarted sender is not ready yet`, {
				error,
			});
		}
	}
}
