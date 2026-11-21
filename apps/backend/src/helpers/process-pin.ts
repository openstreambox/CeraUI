/*
 * Kernel names for one process and for the peer of a Unix socket, through
 * libc.
 *
 * A pidfd refers to one process for as long as it is held, whatever its number
 * later comes to mean. A `/proc/<pid>` read made after opening a pidfd and
 * before finding that pidfd still alive therefore describes the pinned process:
 * a process that is alive at the end of the read was alive throughout it, and
 * no other process can hold a live process's number.
 *
 * SO_PEERCRED gives the PID that called listen(2) on the socket a connection
 * reached (the credentials are taken at listen(2) and copied at connect(2)).
 * The number alone can outlive that process, so where the kernel offers
 * SO_PEERPIDFD (Linux 6.5) the peer is also named by a pidfd, which says
 * whether that exact process is still alive. Neither says who accepts or
 * answers: a listener whose descriptor was shared or passed on is still
 * reported as the process that listened.
 *
 * Every call fails soft: no libc, an old kernel or a refused call reads as
 * unknown or unavailable, never as a positive answer.
 */

import { readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";

const SOL_SOCKET = 1;
const SO_PEERCRED = 17;
const SO_PEERPIDFD = 77;
const ESRCH = 3;
const SYS_PIDFD_SEND_SIGNAL = 424;
const SYS_PIDFD_OPEN = 434;

type Libc = {
	pidfdOpen(pid: number): number;
	pidfdSendSignal(pidfd: number, signal: number): number;
	getsockopt(
		fd: number,
		level: number,
		name: number,
		value: Uint8Array,
		length: Uint32Array,
	): number;
	close(fd: number): number;
	errno(): number;
};

async function loadLibc(): Promise<Libc | null> {
	if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
		return null;
	try {
		const ffi = await import("bun:ffi");
		const t = ffi.FFIType;
		const base = {
			getsockopt: { args: [t.i32, t.i32, t.i32, t.ptr, t.ptr], returns: t.i32 },
			close: { args: [t.i32], returns: t.i32 },
			__errno_location: { args: [], returns: t.ptr },
		} as const;
		const errnoOf = (location: () => unknown) => () => {
			const at = location();
			return at ? ffi.read.i32(at as Parameters<typeof ffi.read.i32>[0], 0) : 0;
		};
		try {
			// glibc 2.36 and later carry wrappers for both calls.
			const lib = ffi.dlopen("libc.so.6", {
				...base,
				pidfd_open: { args: [t.i32, t.u32], returns: t.i32 },
				pidfd_send_signal: {
					args: [t.i32, t.i32, t.ptr, t.u32],
					returns: t.i32,
				},
			});
			const c = lib.symbols;
			return {
				pidfdOpen: (pid) => c.pidfd_open(pid, 0),
				pidfdSendSignal: (pidfd, signal) =>
					c.pidfd_send_signal(pidfd, signal, null, 0),
				getsockopt: (fd, level, name, value, length) =>
					c.getsockopt(fd, level, name, ffi.ptr(value), ffi.ptr(length)),
				close: (fd) => c.close(fd),
				errno: errnoOf(() => c.__errno_location()),
			};
		} catch {
			// An older glibc: the raw system calls, numbered alike on x64 and arm64.
			const lib = ffi.dlopen("libc.so.6", {
				...base,
				syscall: { args: [t.i64, t.i64, t.i64, t.i64, t.i64], returns: t.i64 },
			});
			const c = lib.symbols;
			return {
				pidfdOpen: (pid) => Number(c.syscall(SYS_PIDFD_OPEN, pid, 0, 0, 0)),
				pidfdSendSignal: (pidfd, signal) =>
					Number(c.syscall(SYS_PIDFD_SEND_SIGNAL, pidfd, signal, 0, 0)),
				getsockopt: (fd, level, name, value, length) =>
					c.getsockopt(fd, level, name, ffi.ptr(value), ffi.ptr(length)),
				close: (fd) => c.close(fd),
				errno: errnoOf(() => c.__errno_location()),
			};
		}
	} catch {
		return null;
	}
}

let libc: Promise<Libc | null> | undefined;
function runtime(): Promise<Libc | null> {
	libc ??= loadLibc();
	return libc;
}

/**
 * Alive (true), exited (false) or unknown (null) for one pidfd. Signal 0 sends
 * nothing. Success means the task exists (a zombie included; callers read its
 * state). EPERM is unknown: it can come from a syscall filter as well as from
 * the kernel's permission check on a live task.
 */
function pidfdAlive(c: Libc, pidfd: number): boolean | null {
	if (c.pidfdSendSignal(pidfd, 0) === 0) return true;
	return c.errno() === ESRCH ? false : null;
}

export type ProcessPin = {
	/** True when a pidfd holds the process; false when no pidfd could be had. */
	readonly pidfd: boolean;
	/**
	 * Whether the pinned process is still alive: true only when its pidfd
	 * says so, false when it has exited, null when that cannot be known (no
	 * pidfd, or the kernel gave an unexpected answer). A zombie still counts
	 * as alive here; callers read its state from `/proc`.
	 */
	alive(): boolean | null;
	/**
	 * Send `signal` to the pinned process through its pidfd: true when sent,
	 * false when the process has exited (ESRCH), null when it cannot be known
	 * (no pidfd, closed, or another error). A PID the kernel has since given
	 * to another process is never reached.
	 */
	signal(signal: NodeJS.Signals | number): boolean | null;
	close(): void;
};

const UNPINNED: ProcessPin = {
	pidfd: false,
	alive: () => null,
	signal: () => null,
	close: () => {
		/* Nothing held. */
	},
};

/**
 * Pin `pid`. Null when the process does not exist (ESRCH); an unpinned
 * handle, whose liveness is always unknown, when no pidfd could be had.
 */
export async function pinProcess(pid: number): Promise<ProcessPin | null> {
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	const c = await runtime();
	if (!c) return UNPINNED;
	const fd = c.pidfdOpen(pid);
	if (fd < 0) return c.errno() === ESRCH ? null : UNPINNED;
	let closed = false;
	return {
		pidfd: true,
		alive: () => (closed ? null : pidfdAlive(c, fd)),
		signal: (signal) => {
			if (closed) return null;
			const number =
				typeof signal === "number" ? signal : osConstants.signals[signal];
			if (!Number.isSafeInteger(number) || number < 0) return null;
			if (c.pidfdSendSignal(fd, number) === 0) return true;
			return c.errno() === ESRCH ? false : null;
		},
		close: () => {
			if (closed) return;
			closed = true;
			c.close(fd);
		},
	};
}

/**
 * What SO_PEERPIDFD says about the listener: alive under `pid`, exited,
 * not offered by this kernel (ENOPROTOOPT), or failed for another reason (a
 * descriptor limit, an unreadable fdinfo, an unexpected errno). Only
 * `unsupported` may fall back to the PID number alone.
 */
export type PeerPidfd =
	| { readonly state: "alive"; readonly pid: number }
	| { readonly state: "exited" }
	| { readonly state: "unsupported" }
	| { readonly state: "failed" };

export type PeerIdentity = {
	/** The PID that called listen(2) on the socket this connection reached. */
	readonly pid: number;
	readonly uid: number;
	readonly gid: number;
	readonly pidfd: PeerPidfd;
};

const ENOPROTOOPT = 92;

function fdinfoPid(fd: number): number | null {
	try {
		const line = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8")
			.split("\n")
			.find((entry) => entry.startsWith("Pid:"));
		if (!line) return null;
		const value = Number(line.slice(4).trim());
		return Number.isSafeInteger(value) ? value : null;
	} catch {
		return null;
	}
}

function peerPidfd(c: Libc, fd: number): PeerPidfd {
	const value = new Uint8Array(4);
	const length = new Uint32Array([value.length]);
	if (c.getsockopt(fd, SOL_SOCKET, SO_PEERPIDFD, value, length) !== 0)
		return c.errno() === ENOPROTOOPT
			? { state: "unsupported" }
			: { state: "failed" };
	if (length[0] !== value.length) return { state: "failed" };
	const pidfd = new DataView(value.buffer).getInt32(0, true);
	if (pidfd < 0) return { state: "failed" };
	try {
		const alive = pidfdAlive(c, pidfd);
		if (alive === false) return { state: "exited" };
		if (alive === null) return { state: "failed" };
		const pid = fdinfoPid(pidfd);
		if (pid === null || pid <= 0) return { state: "failed" };
		return { state: "alive", pid };
	} finally {
		c.close(pidfd);
	}
}

/** The credentials of the peer of connected socket `fd`, or null. */
export async function readPeerIdentity(
	fd: number,
): Promise<PeerIdentity | null> {
	if (!Number.isSafeInteger(fd) || fd < 0) return null;
	const c = await runtime();
	if (!c) return null;
	const cred = new Uint8Array(12);
	const length = new Uint32Array([cred.length]);
	if (c.getsockopt(fd, SOL_SOCKET, SO_PEERCRED, cred, length) !== 0)
		return null;
	if (length[0] !== cred.length) return null;
	const view = new DataView(cred.buffer);
	const pid = view.getInt32(0, true);
	if (pid <= 0) return null;
	return {
		pid,
		uid: view.getUint32(4, true),
		gid: view.getUint32(8, true),
		pidfd: peerPidfd(c, fd),
	};
}
