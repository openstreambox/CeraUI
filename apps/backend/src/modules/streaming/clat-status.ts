import { access, readFile } from "node:fs/promises";
import { run } from "../../helpers/run.ts";
import { type LinkPath, validateClatSnapshot } from "./link-family.ts";

export type ClatStatusDeps = {
	now: () => number;
	read: (path: string) => Promise<string>;
	active: () => Promise<boolean>;
	tunExists: (path: string) => Promise<boolean>;
};
const CACHE_MS = 2_000;
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
				deps.now() - checkedAt < CACHE_MS &&
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
			if (!entry || deps.now() - checkedAt > CACHE_MS) return undefined;
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
	read: (path) => readFile(path, "utf8"),
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
