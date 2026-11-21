/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Process file descriptors through libc (glibc 2.36 wrappers, Linux 5.3+).
 *
 * A pidfd names one process for as long as it is held: a signal sent through
 * it reaches that process or fails with ESRCH, never a later process that
 * reuses the number. Every call fails soft; no libc or an old kernel reads as
 * unavailable (null or false), never as a delivered signal.
 */

import { constants } from "node:os";

type PidfdLib = {
	open(pid: number): number;
	sendSignal(fd: number, signal: number): number;
	/** poll(2) for POLLIN with a zero timeout: 1 readable, 0 not, -1 error. */
	pollIn(fd: number): number;
	close(fd: number): number;
};

const POLLIN = 0x001;

let lib: PidfdLib | null | undefined;

function load(): PidfdLib | null {
	if (lib !== undefined) return lib;
	lib = null;
	if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
		return lib;
	try {
		const ffi = require("bun:ffi") as typeof import("bun:ffi");
		const t = ffi.FFIType;
		const { symbols } = ffi.dlopen("libc.so.6", {
			pidfd_open: { args: [t.i32, t.u32], returns: t.i32 },
			pidfd_send_signal: { args: [t.i32, t.i32, t.ptr, t.u32], returns: t.i32 },
			poll: { args: [t.ptr, t.u64, t.i32], returns: t.i32 },
			close: { args: [t.i32], returns: t.i32 },
		});
		// struct pollfd { int fd; short events; short revents; }
		const pollfd = new DataView(new ArrayBuffer(8));
		const pollfdPtr = ffi.ptr(pollfd);
		lib = {
			open: (pid) => symbols.pidfd_open(pid, 0),
			sendSignal: (fd, signal) =>
				symbols.pidfd_send_signal(fd, signal, null, 0),
			pollIn: (fd) => {
				pollfd.setInt32(0, fd, true);
				pollfd.setInt16(4, POLLIN, true);
				pollfd.setInt16(6, 0, true);
				const ready = symbols.poll(pollfdPtr, 1n, 0);
				if (ready < 0) return -1;
				return ready > 0 && (pollfd.getInt16(6, true) & POLLIN) !== 0 ? 1 : 0;
			},
			close: (fd) => symbols.close(fd),
		};
	} catch {
		lib = null;
	}
	return lib;
}

/** A pidfd for `pid`, or null when it cannot be opened (gone, no support). */
export function pidfdOpen(pid: number): number | null {
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	const c = load();
	if (!c) return null;
	const fd = c.open(pid);
	return fd >= 0 ? fd : null;
}

/** Signal the process `fd` names; false when it has exited or the call failed. */
export function pidfdSignal(fd: number, signal: NodeJS.Signals): boolean {
	const c = load();
	const number = constants.signals[signal];
	if (!c || number === undefined) return false;
	return c.sendSignal(fd, number) === 0;
}

/**
 * Whether the process `fd` names has not exited. A pidfd becomes readable when
 * its process exits, before the parent reaps it; signal 0 would still succeed
 * on such a zombie. Unknown (no libc, poll error) reads as not alive.
 */
export function pidfdAlive(fd: number): boolean {
	const c = load();
	return c !== null && c.pollIn(fd) === 0;
}

export function pidfdClose(fd: number): void {
	load()?.close(fd);
}
