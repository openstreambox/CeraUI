/**
 * Provenance for owned clones: the UUID of every profile the coordinator
 * cloned, written when the clone is created and removed when it is deleted.
 * Deletion is only ever authorized by this record, never by a profile's name:
 * CeraUI names saved station profiles after their SSID, so a name proves
 * nothing.
 *
 * The production record lives in /run, like the clones themselves: they are
 * temporary NetworkManager profiles, so neither survives a reboot, and both
 * survive a CeraUI restart.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type CloneRegistry = Readonly<{
	has(uuid: string): Promise<boolean>;
	add(uuid: string): Promise<void>;
	remove(uuid: string): Promise<void>;
	list(): Promise<readonly string[]>;
}>;

export function memoryCloneRegistry(
	initial: Iterable<string> = [],
): CloneRegistry {
	const set = new Set(initial);
	return {
		has: async (uuid) => set.has(uuid),
		add: async (uuid) => {
			set.add(uuid);
		},
		remove: async (uuid) => {
			set.delete(uuid);
		},
		list: async () => [...set],
	};
}

export const CLONE_REGISTRY_PATH = "/run/ceralive/wifi-roaming/clones.json";

/** A JSON array of UUIDs, replaced atomically; writes are serialized. */
export function fileCloneRegistry(path = CLONE_REGISTRY_PATH): CloneRegistry {
	let queue: Promise<unknown> = Promise.resolve();
	const load = async (): Promise<Set<string>> => {
		try {
			const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
			return new Set(
				Array.isArray(parsed)
					? parsed.filter((u): u is string => typeof u === "string")
					: [],
			);
		} catch {
			return new Set();
		}
	};
	const save = async (set: Set<string>) => {
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify([...set]), { mode: 0o600 });
		await rename(tmp, path);
	};
	const serial = <T>(fn: () => Promise<T>): Promise<T> => {
		const next = queue.then(fn);
		queue = next.catch(() => {
			// The caller sees the failure; the queue only keeps the order.
		});
		return next;
	};
	return {
		has: (uuid) => serial(async () => (await load()).has(uuid)),
		add: (uuid) =>
			serial(async () => {
				const set = await load();
				set.add(uuid);
				await save(set);
			}),
		remove: (uuid) =>
			serial(async () => {
				const set = await load();
				if (set.delete(uuid)) await save(set);
			}),
		list: () => serial(async () => [...(await load())]),
	};
}
