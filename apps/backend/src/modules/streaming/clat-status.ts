import { constants } from "node:fs";
import { access, type FileHandle, open } from "node:fs/promises";
import { run } from "../../helpers/run.ts";
import {
	FAMILY_REFRESH_MS,
	type LinkPath,
	validateClatSnapshot,
} from "./link-family.ts";

export type ClatStatusDeps = {
	now: () => number;
	read: (path: string) => Promise<string>;
	active: () => Promise<boolean>;
	tunExists: (path: string) => Promise<boolean>;
};
const REFRESH_SKIP_MS = FAMILY_REFRESH_MS;
// Allow the next two-second tick and a scheduling margin before withdrawing.
const READ_EXPIRY_MS = 2 * REFRESH_SKIP_MS + 500;
const FILE_READ_TIMEOUT_MS = 500;

/** Reject special files and bound open, metadata and read as one operation. */
export async function readClatStatusFile(
	path: string,
	timeoutMs = FILE_READ_TIMEOUT_MS,
): Promise<string> {
	let handle: FileHandle | undefined;
	let expired = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const operation = (async () => {
		const opened = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
		if (expired) {
			await opened.close();
			throw new Error("CLAT status read timeout");
		}
		handle = opened;
		if (!(await opened.stat()).isFile())
			throw new Error("CLAT status must be a regular file");
		if (expired) throw new Error("CLAT status read timeout");
		return opened.readFile("utf8");
	})();
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					expired = true;
					reject(new Error("CLAT status read timeout"));
				}, timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
		// Do not let a stalled close hold the refresh slot either.
		void handle?.close().catch(() => {
			/* A failed close cannot make an unavailable snapshot usable. */
		});
	}
}
/** One asynchronous, coalesced liveness probe per refresh, never per interface. */
export function createClatStatusReader(deps: ClatStatusDeps) {
	let checkedAt = -Infinity;
	let pending: Promise<void> | undefined;
	let names = new Set<string>();
	let cache = new Map<
		string,
		{ value: unknown; index: number; tun: boolean; active: boolean }
	>();
	return {
		refresh(ifaces: readonly string[]): Promise<void> {
			if (pending) return pending.then(() => this.refresh(ifaces));
			if (
				deps.now() - checkedAt < REFRESH_SKIP_MS &&
				ifaces.every((name) => names.has(name))
			)
				return Promise.resolve();
			pending = (async () => {
				const next = new Map<
					string,
					{ value: unknown; index: number; tun: boolean; active: boolean }
				>();
				const valid = ifaces.filter(
					(name) => /^[a-zA-Z0-9_.-]+$/.test(name) && !/^clat\d+$/.test(name),
				);
				// Avoid a service query when this image supplies no CLAT snapshots.
				await Promise.all(
					valid.map(async (name) => {
						try {
							const index = Number(
								(await deps.read(`/sys/class/net/${name}/ifindex`)).trim(),
							);
							if (!Number.isInteger(index) || index < 1 || index > 8191) return;
							const value: unknown = JSON.parse(
								await deps.read(`/run/ceralive/clat/${index}.json`),
							);
							const tun = await deps.tunExists(
								`/sys/class/net/clat${index}/tun_flags`,
							);
							next.set(name, { value, index, tun, active: false });
						} catch {
							/* Missing or malformed image support is unavailable. */
						}
					}),
				);
				const active = next.size
					? await deps.active().catch(() => false)
					: false;
				for (const entry of next.values()) entry.active = active;
				cache = next;
				names = new Set(ifaces);
				checkedAt = deps.now();
			})().finally(() => {
				pending = undefined;
			});
			return pending;
		},
		read(iface: string): LinkPath | undefined {
			const entry = cache.get(iface);
			// Never prolong liveness when a caller stops refreshing the cache.
			if (!entry || deps.now() - checkedAt > READ_EXPIRY_MS) return undefined;
			return validateClatSnapshot(
				entry.value,
				iface,
				entry.index,
				deps.now() / 1000,
				entry.active,
				entry.tun,
			);
		},
	};
}
const reader = createClatStatusReader({
	now: Date.now,
	read: readClatStatusFile,
	active: async () =>
		(
			await run("systemctl", ["is-active", "ceralive-clat.service"], {
				timeout: 500,
			})
		).trim() === "active",
	tunExists: async (path) => {
		try {
			await access(path);
			return true;
		} catch {
			return false;
		}
	},
});
export const refreshClatStatus = (ifaces: readonly string[]) =>
	reader.refresh(ifaces);
/** Synchronous consumers inspect memory only; refresh owns all I/O. */
export const readClatPath = (iface: string) => reader.read(iface);
