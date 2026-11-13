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

/** Optional integration with an existing recovery owner. No retry or barrier is
 * created here; callers choose one shared revision for all files in a store. */
export interface PrivateStateStore {
	readonly dir: string;
	readonly change?: <T>(operation: () => Promise<T>) => Promise<T>;
	readonly readFault?: () => void;
}
async function readObserved<T>(
	store: PrivateStateStore,
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		store.readFault?.();
		throw error;
	}
}
function changeObserved<T>(
	store: PrivateStateStore,
	operation: () => Promise<T>,
): Promise<T> {
	return store.change ? store.change(operation) : operation();
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
async function readPrivateStateFile(
	store: PrivateStateStore,
	key: string,
	extension: "json" | "conf",
): Promise<string | undefined> {
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
				`/proc/self/fd/${parent}/${key}.${extension}`,
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
			return decodeAuthorityUtf8(readStoredStateDescriptor(fd, 4096));
		} finally {
			closeSync(fd);
		}
	} finally {
		closeSync(parent);
	}
}

export async function readPrivateJson(
	store: PrivateStateStore,
	key: string,
): Promise<unknown> {
	return readObserved(store, async () => {
		const text = await readPrivateStateFile(store, key, "json");
		return text === undefined ? undefined : parseAuthorityJson(text);
	});
}
/** A stored schema/identity failure is the same read fault as malformed JSON.
 * Live owners and recovery inventories must raise the same existing barrier.
 */
export async function readParsedPrivateJson<T>(
	store: PrivateStateStore,
	key: string,
	parse: (raw: unknown) => T,
): Promise<T | undefined> {
	const raw = await readPrivateJson(store, key);
	if (raw === undefined) return undefined;
	try {
		return parse(raw);
	} catch (error) {
		store.readFault?.();
		throw error;
	}
}
/** Inventory hints only; each record is subsequently opened and slot-validated.
 * Enumeration is anchored and finite. Uncommitted temporaries and kernel lease
 * files are preserved, never promoted to authority or deleted by this reader.
 */
async function inventoryPrivateState(
	store: PrivateStateStore,
	textAllowed: boolean,
): Promise<{ json: string[]; text: string[] }> {
	let parent: number;
	try {
		parent = privateDirectory(store.dir);
	} catch (error) {
		if (absent(error)) return { json: [], text: [] };
		throw error;
	}
	try {
		const directory = await opendir(`/proc/self/fd/${parent}`),
			json: string[] = [],
			text: string[] = [];
		let count = 0;
		for await (const entry of directory) {
			if (++count > 4096)
				throw new Error("Private authority inventory exceeds limit");
			if (/^[a-f0-9]{64}\.(?:lock|[a-f0-9-]{36}\.tmp)$/.test(entry.name))
				continue;
			if (/^[a-f0-9]{64}\.json$/.test(entry.name))
				json.push(entry.name.slice(0, -5));
			else if (textAllowed && /^[a-f0-9]{64}\.conf$/.test(entry.name))
				text.push(entry.name.slice(0, -5));
			else throw new Error("Unknown private authority inventory entry");
		}
		return { json: json.sort(), text: text.sort() };
	} finally {
		closeSync(parent);
	}
}
export function listPrivateJsonKeys(
	store: PrivateStateStore,
): Promise<string[]> {
	return readObserved(
		store,
		async () => (await inventoryPrivateState(store, false)).json,
	);
}
/** Closed JSON/configuration inventory; neither extension may hide an unknown
 * auxiliary file. Opening and plan/slot binding remain the caller's duty. */
export function listPrivateStateKeys(
	store: PrivateStateStore,
): Promise<{ json: string[]; text: string[] }> {
	return readObserved(store, () => inventoryPrivateState(store, true));
}
export function readPrivateText(
	store: PrivateStateStore,
	key: string,
): Promise<string | undefined> {
	return readObserved(store, () => readPrivateStateFile(store, key, "conf"));
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
async function writePrivateStateFile(
	store: PrivateStateStore,
	key: string,
	extension: "json" | "conf",
	bytes: string | undefined,
): Promise<void> {
	validateKey(key);
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
	const path = `/proc/self/fd/${parent}/${key}.${extension}`;
	const temporary = `/proc/self/fd/${parent}/${key}.${randomUUID()}.tmp`;
	try {
		if (bytes === undefined) {
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

export function writePrivateJson(
	store: PrivateStateStore,
	key: string,
	value: unknown,
): Promise<void> {
	return changeObserved(store, () =>
		writePrivateStateFile(
			store,
			key,
			"json",
			value === undefined ? undefined : `${JSON.stringify(value)}\n`,
		),
	);
}
/** Same anchored private ownership and durability as JSON authority. Intended
 * only for generated translator configuration, never arbitrary profile text.
 */
export function writePrivateText(
	store: PrivateStateStore,
	key: string,
	value: string | undefined,
): Promise<void> {
	if (
		value !== undefined &&
		(typeof value !== "string" || value.includes("\0"))
	)
		return Promise.reject(new Error("Invalid private configuration text"));
	return changeObserved(store, () =>
		writePrivateStateFile(store, key, "conf", value),
	);
}
