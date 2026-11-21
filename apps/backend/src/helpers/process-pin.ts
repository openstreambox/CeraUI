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
 * SO_PEERCRED gives the PID that created the listening socket a connection
 * reached (the credentials are taken at listen(2) and copied at connect(2)).
 * The number alone can outlive that process, so where the kernel offers
 * SO_PEERPIDFD (Linux 6.5) the peer is also named by a pidfd, which says
 * whether that exact process is still alive.
 *
 * Every call fails soft: no libc, an old kernel or a refused call reads as
 * "unavailable", never as a positive answer.
 */

import { readFileSync } from "node:fs";

const SOL_SOCKET = 1;
const SO_PEERCRED = 17;
const SO_PEERPIDFD = 77;
const ESRCH = 3;
const EPERM = 1;
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
 * nothing; EPERM still means the process exists.
 */
function pidfdAlive(c: Libc, pidfd: number): boolean | null {
	if (c.pidfdSendSignal(pidfd, 0) === 0) return true;
	const errno = c.errno();
	if (errno === ESRCH) return false;
	if (errno === EPERM) return true;
	return null;
}

export type ProcessPin = {
	/** True when a pidfd holds the process; false when no pidfd could be had. */
	readonly pidfd: boolean;
	/**
	 * Whether the pinned process is still alive. Without a pidfd this is
	 * always true: there is no evidence either way, and the caller's start
	 * time comparison remains the only guard.
	 */
	alive(): boolean;
	close(): void;
};

const UNPINNED: ProcessPin = {
	pidfd: false,
	alive: () => true,
	close: () => {
		/* Nothing held. */
	},
};

/**
 * Pin `pid`. Null when the process does not exist (ESRCH); an unpinned
 * handle when the system offers no pidfd.
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
		alive: () => !closed && pidfdAlive(c, fd) !== false,
		close: () => {
			if (closed) return;
			closed = true;
			c.close(fd);
		},
	};
}

export type PeerIdentity = {
	/** The PID that listened on the socket this connection reached. */
	readonly pid: number;
	readonly uid: number;
	readonly gid: number;
	/**
	 * The peer's PID as its pidfd sees it now: the number while that process
	 * lives, -1 once it has exited, null when the kernel has no SO_PEERPIDFD.
	 */
	readonly pidfdPid: number | null;
};

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
	let pidfdPid: number | null = null;
	const peerFd = new Uint8Array(4);
	const peerLength = new Uint32Array([peerFd.length]);
	if (
		c.getsockopt(fd, SOL_SOCKET, SO_PEERPIDFD, peerFd, peerLength) === 0 &&
		peerLength[0] === peerFd.length
	) {
		const pidfd = new DataView(peerFd.buffer).getInt32(0, true);
		if (pidfd >= 0) {
			try {
				const alive = pidfdAlive(c, pidfd);
				const number = fdinfoPid(pidfd);
				pidfdPid = alive === false ? -1 : alive === null ? null : number;
			} finally {
				c.close(pidfd);
			}
		}
	}
	return {
		pid,
		uid: view.getUint32(4, true),
		gid: view.getUint32(8, true),
		pidfdPid,
	};
}
