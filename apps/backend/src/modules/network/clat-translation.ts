/*
  IPV4 TRANSLATION FOR IPV6-ONLY CELLULAR LINKS, AS THE IMAGE PROVIDES IT.

  Some carriers (T-Mobile US among them) give a modem IPv6 only. The image's
  `ceralive-clat.service` owns translation for such a link end to end: one tayga
  translator, a `clat<ifindex>` TUN with an IPv4 /32 in 10.254.0.0/19, its source
  rules, routes and NAT. CeraUI never creates, changes or removes any of that.

  It reads the service's read-only snapshot, `/run/ceralive/clat/<ifindex>.json`,
  and lets the TUN carry stream traffic for its modem only while all of this
  holds; anything else means "unavailable", and the TUN is withdrawn:

  - schema version 1, every field well-formed, `state` is `up`;
  - the file name, the TUN name and the modem interface agree;
  - the snapshot is fresh (the service rewrites it at least every ten seconds
    while healthy; older than 30 s is stale);
  - the TUN and the modem interface both exist, and the service unit is running.

  The TUN's IPv4 is the sender's bind source and the TUN its bind device, as the
  image contract says; the modem interface itself has no IPv4 address.
*/

import { access, readdir, readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { join } from "node:path";
import { isSafeIfname } from "./safe-ifname.ts";

export const CLAT_SNAPSHOT_DIR = "/run/ceralive/clat";
export const CLAT_SNAPSHOT_MAX_AGE_MS = 30_000;
const CLAT_UNIT_MARKER = "/run/systemd/units/invocation:ceralive-clat.service";

export interface ClatSnapshot {
	readonly interface: string;
	readonly tun: string;
	readonly prefix: string | null;
	readonly ipv4: string;
	readonly state: "starting" | "up" | "down" | "error";
	readonly updatedAt: number;
}

const TUN_RE = /^clat(\d{1,4})$/;

/** 10.254.0.0/19: the only space the image service assigns. */
function inServiceSpace(ip: string): boolean {
	if (!isIPv4(ip)) return false;
	const [a, b, c] = ip.split(".").map(Number);
	return a === 10 && b === 254 && c !== undefined && c < 32;
}

/** Strict parse of one snapshot; `undefined` for anything unexpected. */
export function parseClatSnapshot(
	text: string,
	fileIndex: string,
): ClatSnapshot | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	if (value.schema_version !== 1) return undefined;
	const { interface: parent, tun, prefix, ipv4, state, updated_at } = value;
	if (typeof parent !== "string" || !isSafeIfname(parent)) return undefined;
	if (typeof tun !== "string") return undefined;
	const index = TUN_RE.exec(tun)?.[1];
	if (index === undefined || index !== fileIndex) return undefined;
	if (prefix !== null && typeof prefix !== "string") return undefined;
	if (typeof ipv4 !== "string" || !inServiceSpace(ipv4)) return undefined;
	if (
		state !== "starting" &&
		state !== "up" &&
		state !== "down" &&
		state !== "error"
	)
		return undefined;
	if (typeof updated_at !== "number" || !Number.isFinite(updated_at))
		return undefined;
	return {
		interface: parent,
		tun,
		prefix,
		ipv4,
		state,
		updatedAt: updated_at * 1000,
	};
}

export interface ClatTranslation {
	readonly parent: string;
	readonly tun: string;
	readonly ipv4: string;
}

export interface ClatReadDeps {
	readonly dir: string;
	readonly list: (dir: string) => Promise<readonly string[]>;
	readonly read: (path: string) => Promise<string>;
	readonly exists: (path: string) => Promise<boolean>;
	readonly now: () => number;
}
const exists = async (path: string) => {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
};
export const defaultClatReadDeps: ClatReadDeps = {
	dir: CLAT_SNAPSHOT_DIR,
	list: async (dir) => {
		try {
			return await readdir(dir);
		} catch {
			return [];
		}
	},
	read: (path) => readFile(path, "utf8"),
	exists,
	now: Date.now,
};

/** The translations that may carry stream traffic right now, keyed by TUN. */
export async function readClatTranslations(
	deps: ClatReadDeps = defaultClatReadDeps,
): Promise<ReadonlyMap<string, ClatTranslation>> {
	const usable = new Map<string, ClatTranslation>();
	const names = await deps.list(deps.dir);
	if (names.length === 0 || !(await deps.exists(CLAT_UNIT_MARKER)))
		return usable;
	for (const name of names.slice(0, 64)) {
		const index = /^(\d{1,4})\.json$/.exec(name)?.[1];
		if (index === undefined) continue;
		let snapshot: ClatSnapshot | undefined;
		try {
			snapshot = parseClatSnapshot(
				await deps.read(join(deps.dir, name)),
				index,
			);
		} catch {
			continue;
		}
		if (!snapshot || snapshot.state !== "up" || snapshot.prefix === null)
			continue;
		const age = deps.now() - snapshot.updatedAt;
		if (age > CLAT_SNAPSHOT_MAX_AGE_MS || age < -CLAT_SNAPSHOT_MAX_AGE_MS)
			continue;
		if (
			!(await deps.exists(`/sys/class/net/${snapshot.tun}`)) ||
			!(await deps.exists(`/sys/class/net/${snapshot.interface}`))
		)
			continue;
		usable.set(snapshot.tun, {
			parent: snapshot.interface,
			tun: snapshot.tun,
			ipv4: snapshot.ipv4,
		});
	}
	return usable;
}

let current: ReadonlyMap<string, ClatTranslation> = new Map();

/** Refresh the cached view; called once per interface scan. */
export async function refreshClatTranslations(
	deps: ClatReadDeps = defaultClatReadDeps,
): Promise<void> {
	try {
		current = await readClatTranslations(deps);
	} catch {
		current = new Map();
	}
}

export function setClatTranslationsForTest(
	value: ReadonlyMap<string, ClatTranslation>,
): void {
	current = value;
}

/** A name the image service mints for its translator TUN. */
export function isClatTunName(name: string): boolean {
	return TUN_RE.test(name);
}

/** The usable translation behind this TUN, if its address matches. */
export function clatTranslationFor(
	name: string,
	ip: string | undefined,
): ClatTranslation | undefined {
	const translation = current.get(name);
	return translation && ip === translation.ipv4 ? translation : undefined;
}
