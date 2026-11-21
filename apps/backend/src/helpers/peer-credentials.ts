/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * The credentials of the peer of a connected Unix socket, read with
 * SO_PEERCRED through libc.
 *
 * The kernel records the PID, UID and GID of the process that called listen(2)
 * and copies them to every connection the listener accepts. The PID says who
 * created the listener, not who answers: a listener whose descriptor was
 * shared or passed on is still reported as the process that listened.
 *
 * Every failure (no libc, another platform, a refused call, a short answer)
 * reads as null, never as a positive answer.
 */

const SOL_SOCKET = 1;
const SO_PEERCRED = 17;

export type PeerCredentials = {
	readonly pid: number;
	readonly uid: number;
	readonly gid: number;
};

type Getsockopt = (
	fd: number,
	level: number,
	name: number,
	value: Uint8Array,
	length: Uint32Array,
) => number;

let libc: Promise<Getsockopt | null> | undefined;

async function loadGetsockopt(): Promise<Getsockopt | null> {
	if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
		return null;
	try {
		const ffi = await import("bun:ffi");
		const t = ffi.FFIType;
		const lib = ffi.dlopen("libc.so.6", {
			getsockopt: { args: [t.i32, t.i32, t.i32, t.ptr, t.ptr], returns: t.i32 },
		});
		return (fd, level, name, value, length) =>
			lib.symbols.getsockopt(fd, level, name, ffi.ptr(value), ffi.ptr(length));
	} catch {
		return null;
	}
}

/** SO_PEERCRED of connected socket `fd`, or null when it cannot be read. */
export async function readPeerCredentials(
	fd: number,
): Promise<PeerCredentials | null> {
	if (!Number.isSafeInteger(fd) || fd < 0) return null;
	libc ??= loadGetsockopt();
	const getsockopt = await libc;
	if (!getsockopt) return null;
	const cred = new Uint8Array(12);
	const length = new Uint32Array([cred.length]);
	if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, cred, length) !== 0) return null;
	if (length[0] !== cred.length) return null;
	const view = new DataView(cred.buffer);
	const pid = view.getInt32(0, true);
	if (pid <= 0) return null;
	return { pid, uid: view.getUint32(4, true), gid: view.getUint32(8, true) };
}
