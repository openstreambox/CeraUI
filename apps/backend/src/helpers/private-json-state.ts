import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync } from "node:fs";
import { mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	openStoredStateDirectory,
	readStoredStateDescriptor,
} from "../modules/system/update-orchestrator/stored-state-file.ts";
import {
	decodeAuthorityUtf8,
	parseAuthorityJson,
} from "../modules/system/update-orchestrator/strict-authority-json.ts";

/** Shared store shape for retained inverse adapters. The writer stays the
 * existing fd-anchored implementation; owners wrap slot revision tracking. */
export interface PrivateStateStore {
	readonly dir: string;
	readonly change?: <T>(operation: () => Promise<T>) => Promise<T>;
	readonly readFault?: () => void;
}

function validateKey(key: string) {
	if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid private state key");
}
function privateDirectory(dir: string): number {
	const fd = openStoredStateDirectory(dir, true);
	const info = fstatSync(fd);
	if (info.uid !== (process.getuid?.() ?? 0) || (info.mode & 0o077) !== 0) {
		closeSync(fd);
		throw new Error("Unsafe private state directory");
	}
	return fd;
}
function absent(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export async function readPrivateJson(
	store: { readonly dir: string },
	key: string,
): Promise<unknown> {
	validateKey(key);
	let parent: number;
	try {
		parent = privateDirectory(store.dir);
	} catch (error) {
		if (absent(error)) return undefined;
		throw error;
	}
	try {
		let fd: number;
		try {
			fd = openSync(
				`/proc/self/fd/${parent}/${key}.json`,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
		} catch (error) {
			if (absent(error)) return undefined;
			throw error;
		}
		try {
			const info = fstatSync(fd);
			if (
				info.uid !== (process.getuid?.() ?? 0) ||
				(info.mode & 0o077) !== 0 ||
				info.nlink !== 1
			)
				throw new Error("Unsafe private state file");
			return parseAuthorityJson(
				decodeAuthorityUtf8(readStoredStateDescriptor(fd, 4096)),
			);
		} finally {
			closeSync(fd);
		}
	} finally {
		closeSync(parent);
	}
}

/** Inventory hints only; each record is subsequently opened and slot-validated.
 * Enumeration is anchored and finite. Uncommitted temporaries and kernel lease
 * files are preserved, never promoted to authority or deleted by this reader.
 */
export async function listPrivateJsonKeys(store: {
	readonly dir: string;
}): Promise<string[]> {
	let parent: number;
	try {
		parent = privateDirectory(store.dir);
	} catch (error) {
		if (absent(error)) return [];
		throw error;
	}
	try {
		const directory = await opendir(`/proc/self/fd/${parent}`),
			keys: string[] = [];
		let count = 0;
		for await (const entry of directory) {
			if (++count > 4096)
				throw new Error("Private authority inventory exceeds limit");
			if (/^[a-f0-9]{64}\.(?:lock|[a-f0-9-]{36}\.tmp)$/.test(entry.name))
				continue;
			if (!/^[a-f0-9]{64}\.json$/.test(entry.name))
				throw new Error("Unknown private authority inventory entry");
			keys.push(entry.name.slice(0, -5));
		}
		return keys.sort();
	} finally {
		closeSync(parent);
	}
}
const durableDirectories = new Set<string>();
function syncDirectoryAncestry(directory: string, parent: number): void {
	const info = fstatSync(parent);
	const identity = `${resolve(directory)}:${info.dev}:${info.ino}`;
	if (durableDirectories.has(identity)) return;
	// fsync of the leaf alone does not persist a newly-created directory's link.
	// Complete the chain before any hardware effect can rely on a state record.
	let path = dirname(resolve(directory));
	for (;;) {
		const fd = openStoredStateDirectory(path, true);
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		const next = dirname(path);
		if (next === path) break;
		path = next;
	}
	durableDirectories.add(identity);
}
export async function writePrivateJson(
	store: { readonly dir: string },
	key: string,
	value: unknown,
): Promise<void> {
	validateKey(key);
	const bytes = value === undefined ? undefined : `${JSON.stringify(value)}\n`;
	if (bytes !== undefined && Buffer.byteLength(bytes) > 4096)
		throw new Error("Private state exceeds limit");
	await mkdir(store.dir, { recursive: true, mode: 0o700 });
	const parent = privateDirectory(store.dir);
	try {
		syncDirectoryAncestry(store.dir, parent);
	} catch (error) {
		closeSync(parent);
		throw error;
	}
	const path = `/proc/self/fd/${parent}/${key}.json`;
	const temporary = `/proc/self/fd/${parent}/${key}.${randomUUID()}.tmp`;
	try {
		if (value === undefined) {
			try {
				await unlink(path);
			} catch (error) {
				if (!absent(error)) throw error;
			}
			fsyncSync(parent);
			return;
		}
		const handle = await open(
			temporary,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await handle.writeFile(bytes ?? "", "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
		fsyncSync(parent);
	} finally {
		// A failed transaction may leave a private, uncommitted temporary. Preserve
		// the original persistence error; this path never names authoritative state.
		await unlink(temporary).catch(() => undefined);
		closeSync(parent);
	}
}
