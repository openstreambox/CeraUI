/**
 * Provenance for owned clones: the UUID of every profile the coordinator
 * cloned, with the radio and source profile it was cloned for. A clone is
 * recorded right after `nmcli connection clone` names it and stays recorded
 * until the boot sweep deletes it: nothing deletes a clone at runtime, and a
 * radio reuses its clone of a source profile for every later join.
 *
 * Deletion is only ever authorized by this record, never by a profile's name:
 * CeraUI names saved station profiles after their SSID, so a name proves
 * nothing. CeraUI's own Wi-Fi code keeps owned clones out of its saved-network
 * list (`isOwnedClone`), so nothing but the coordinator activates one.
 *
 * The production record lives in /run, like the clones themselves: they are
 * temporary NetworkManager profiles, so neither survives a reboot, and both
 * survive a CeraUI restart.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type CloneEntry = Readonly<{
	uuid: string;
	/** Radio identity and source profile, `<id>|<source uuid>`; "" unknown. */
	key: string;
}>;

export type CloneRegistry = Readonly<{
	has(uuid: string): Promise<boolean>;
	/** The recorded clone for a radio and source profile. */
	find(key: string): Promise<string | undefined>;
	add(uuid: string, key?: string): Promise<void>;
	remove(uuid: string): Promise<void>;
	list(): Promise<readonly string[]>;
}>;

export function memoryCloneRegistry(
	initial: Iterable<string | CloneEntry> = [],
): CloneRegistry {
	const map = new Map<string, string>();
	for (const e of initial)
		typeof e === "string" ? map.set(e, "") : map.set(e.uuid, e.key);
	return {
		has: async (uuid) => map.has(uuid),
		find: async (key) =>
			key ? [...map].find(([, k]) => k === key)?.[0] : undefined,
		add: async (uuid, key = "") => {
			map.set(uuid, key);
		},
		remove: async (uuid) => {
			map.delete(uuid);
		},
		list: async () => [...map.keys()],
	};
}

export const CLONE_REGISTRY_PATH = "/run/ceralive/wifi-roaming/clones.json";

async function loadEntries(path: string): Promise<Map<string, string>> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		const map = new Map<string, string>();
		if (!Array.isArray(parsed)) return map;
		for (const e of parsed) {
			if (typeof e === "string") map.set(e, "");
			else if (
				e &&
				typeof e === "object" &&
				typeof (e as CloneEntry).uuid === "string"
			)
				map.set(
					(e as CloneEntry).uuid,
					typeof (e as CloneEntry).key === "string"
						? (e as CloneEntry).key
						: "",
				);
		}
		return map;
	} catch {
		return new Map();
	}
}

/** A JSON array of entries, replaced atomically; writes are serialized. */
export function fileCloneRegistry(path = CLONE_REGISTRY_PATH): CloneRegistry {
	let queue: Promise<unknown> = Promise.resolve();
	const save = async (map: Map<string, string>) => {
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		await writeFile(
			tmp,
			JSON.stringify([...map].map(([uuid, key]) => ({ uuid, key }))),
			{ mode: 0o600 },
		);
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
		has: (uuid) => serial(async () => (await loadEntries(path)).has(uuid)),
		find: (key) =>
			serial(async () =>
				key
					? [...(await loadEntries(path))].find(([, k]) => k === key)?.[0]
					: undefined,
			),
		add: (uuid, key = "") =>
			serial(async () => {
				ownedInProcess.add(uuid);
				const map = await loadEntries(path);
				map.set(uuid, key);
				await save(map);
			}),
		remove: (uuid) =>
			serial(async () => {
				const map = await loadEntries(path);
				if (map.delete(uuid)) await save(map);
				ownedInProcess.delete(uuid);
			}),
		list: () => serial(async () => [...(await loadEntries(path)).keys()]),
	};
}

/**
 * Clone creation in progress in this process. Between `nmcli connection
 * clone` and the record naming the new UUID, a clone exists that the record
 * does not know yet; CeraUI's saved-network refresh does not commit a listing
 * taken while that can be the case.
 */
let creating = 0;
let creationEpoch = 0;

/** Mark a clone creation; call the result once the clone is recorded or gone. */
export function beginCloneCreation(): () => void {
	creating++;
	creationEpoch++;
	let ended = false;
	return () => {
		if (ended) return;
		ended = true;
		creating--;
		creationEpoch++;
	};
}

/** Changes whenever a creation starts or ends; `null` while one is running. */
export function cloneCreationEpoch(): number | null {
	return creating > 0 ? null : creationEpoch;
}

/**
 * The owned clones this process knows of: every clone it recorded, plus what
 * the boot sweep left recorded. CeraUI's own Wi-Fi code asks this, without
 * I/O, to keep owned clones out of everything it lists and activates.
 */
const ownedInProcess = new Set<string>();

/** Whether `uuid` is one of the roaming coordinator's clones. */
export function isOwnedClone(uuid: string): boolean {
	return ownedInProcess.has(uuid);
}

/** Boot: the clones still recorded after the sweep stay hidden too. */
export function rememberOwnedClones(uuids: Iterable<string>): void {
	for (const uuid of uuids) ownedInProcess.add(uuid);
}
