import { closeSync, constants, fstatSync, fsyncSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { openStoredStateDirectory } from "../modules/system/update-orchestrator/stored-state-file.ts";

let libc:
	| Promise<{ symbols: { flock(fd: number, operation: number): number } }>
	| undefined;
function kernelLocks() {
	if (process.platform !== "linux")
		throw new Error("Private state locking requires Linux");
	libc ??= import("bun:ffi").then(({ dlopen, FFIType }) => {
		const library = dlopen("libc.so.6", {
			flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		});
		return library;
	});
	return libc;
}
/** A kernel lease on an anchored private file. No PID timeout, stale-lock
 * deletion, or unlink/recreate race; process death releases the descriptor.
 */
export async function acquirePrivateStateLease(
	store: { readonly dir: string },
	key: string,
): Promise<{ release(): void } | undefined> {
	if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid private lease key");
	const locks = await kernelLocks();
	await mkdir(store.dir, { recursive: true, mode: 0o700 });
	const parent = openStoredStateDirectory(store.dir, true);
	let fd: number | undefined;
	try {
		const directory = fstatSync(parent);
		if (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0)
			throw new Error("Unsafe private lease directory");
		fd = openSync(
			`/proc/self/fd/${parent}/${key}.lock`,
			constants.O_RDWR |
				constants.O_CREAT |
				constants.O_NOFOLLOW |
				constants.O_NONBLOCK,
			0o600,
		);
		const info = fstatSync(fd);
		if (
			!info.isFile() ||
			info.nlink !== 1 ||
			info.size !== 0 ||
			info.uid !== process.getuid?.() ||
			(info.mode & 0o077) !== 0
		)
			throw new Error("Unsafe private lease file");
		if (locks.symbols.flock(fd, 2 | 4) !== 0) {
			closeSync(fd);
			fd = undefined;
			return undefined;
		}
		fsyncSync(fd);
		fsyncSync(parent);
		const held = fd;
		fd = undefined;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				try {
					locks.symbols.flock(held, 8);
				} finally {
					closeSync(held);
				}
			},
		};
	} finally {
		if (fd !== undefined) closeSync(fd);
		closeSync(parent);
	}
}
