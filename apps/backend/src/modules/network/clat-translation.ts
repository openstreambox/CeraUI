/*
  IPV4 TRANSLATION FOR IPV6-ONLY CELLULAR LINKS, AS THE IMAGE PROVIDES IT.

  Some carriers (T-Mobile US among them) give a modem IPv6 only. The image's
  `ceralive-clat.service` owns translation for such a link end to end: one tayga
  translator, a `clat<ifindex>` TUN with an IPv4 /32 in 10.254.0.0/19, its source
  rules, routes and NAT. CeraUI never creates, repairs or removes any of that,
  and never starts a translator.

  It reads the service's snapshot, `/run/ceralive/clat/<ifindex>.json`, and lets
  the TUN carry stream traffic for its modem only while every check below holds.
  The snapshot is advisory, not an activation lease, so each check fails closed:

  - a bounded, root-owned regular file in a root-owned directory;
  - schema version 1, every field well-formed: `state` one of the documented
    values, `ipv4` inside 10.254.0.0/19, `prefix` an RFC 6052 length;
  - `state` is `up` (a `last_error` alone does not reject it: the service keeps a
    path up through its first two failed DNS refreshes);
  - `updated_at` within 30 s, at most 5 s in the future, and never older than
    30 s of our own monotonic time since we first saw that value: reading
    never renews freshness;
  - `expires_at`, when the producer adds one, not passed;
  - the file index is the modem interface's current kernel ifindex, and that
    interface is a known modem;
  - the TUN exists, is administratively up, and keeps one kernel ifindex;
  - the unit is active and running with a live MainPID.

  A translation's generation is the unit's InvocationID, the TUN's ifindex, the
  modem's ifindex and the producer's `activation` token when present. When it
  changes, the link is withdrawn for one scan before it is offered again, so the
  sender's reload path sees a withdrawal rather than a silent swap.

  The TUN's IPv4 is the sender's bind source and the TUN its bind device, as the
  image contract says; the modem interface itself has no IPv4 address.
*/

import { lstat, readdir, readFile } from "node:fs/promises";
import { isIPv4, isIPv6 } from "node:net";
import { join } from "node:path";
import { run } from "../../helpers/run.ts";
import { modemStableKeyForIfname } from "../modems/mutation-identity.ts";
import { isSafeIfname } from "./safe-ifname.ts";

export const CLAT_SNAPSHOT_DIR = "/run/ceralive/clat";
export const CLAT_SNAPSHOT_MAX_AGE_MS = 30_000;
export const CLAT_SNAPSHOT_FUTURE_SKEW_MS = 5_000;
const CLAT_SNAPSHOT_MAX_BYTES = 4096;
const CLAT_UNIT = "ceralive-clat.service";
const IFF_UP = 0x1;

export interface ClatSnapshot {
	readonly interface: string;
	readonly tun: string;
	readonly prefix: string | null;
	readonly ipv4: string;
	readonly state: "starting" | "up" | "down" | "error";
	readonly updatedAt: number;
	readonly expiresAt?: number;
	readonly activation?: string;
}

const TUN_RE = /^clat(\d{1,4})$/;
const PREFIX_LENGTHS = new Set([32, 40, 48, 56, 64, 96]);

/** 10.254.0.0/19: the only space the image service assigns. */
function inServiceSpace(ip: string): boolean {
	if (!isIPv4(ip)) return false;
	const [a, b, c, d] = ip.split(".").map(Number);
	return a === 10 && b === 254 && c !== undefined && c < 32 && d !== 0;
}

/** An RFC 6052 NAT64 prefix of a supported length. */
export function isSupportedNat64Prefix(prefix: string): boolean {
	const match = /^([0-9A-Fa-f:]+)\/(\d{2})$/.exec(prefix);
	return (
		match?.[1] !== undefined &&
		isIPv6(match[1]) &&
		PREFIX_LENGTHS.has(Number(match[2]))
	);
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
	if (
		prefix !== null &&
		(typeof prefix !== "string" || !isSupportedNat64Prefix(prefix))
	)
		return undefined;
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
	const lastError = value.last_error;
	if (
		lastError !== undefined &&
		lastError !== null &&
		typeof lastError !== "string"
	)
		return undefined;
	// Optional producer fields: honoured when present, never required.
	const { expires_at, activation } = value;
	if (
		expires_at !== undefined &&
		(typeof expires_at !== "number" || !Number.isFinite(expires_at))
	)
		return undefined;
	if (
		activation !== undefined &&
		(typeof activation !== "string" ||
			!/^[A-Za-z0-9._:-]{1,128}$/.test(activation))
	)
		return undefined;
	return {
		interface: parent,
		tun,
		prefix,
		ipv4,
		state,
		updatedAt: updated_at * 1000,
		...(expires_at !== undefined ? { expiresAt: expires_at * 1000 } : {}),
		...(activation !== undefined ? { activation } : {}),
	};
}

export interface ClatTranslation {
	readonly parent: string;
	readonly tun: string;
	readonly ipv4: string;
	readonly generation: string;
}

export interface ClatUnitState {
	readonly invocation: string;
	readonly mainPid: number;
}

export interface ClatFileInfo {
	readonly regular: boolean;
	readonly uid: number;
	readonly size: number;
	readonly directory: boolean;
}

export interface ClatReadDeps {
	readonly dir: string;
	readonly list: (dir: string) => Promise<readonly string[]>;
	readonly stat: (path: string) => Promise<ClatFileInfo | undefined>;
	readonly read: (path: string) => Promise<string>;
	/** A sysfs attribute, trimmed; `undefined` when absent or unreadable. */
	readonly sysfs: (path: string) => Promise<string | undefined>;
	readonly unit: () => Promise<ClatUnitState | undefined>;
	readonly isModem: (ifname: string) => boolean;
	readonly now: () => number;
	readonly monotonic: () => number;
}

async function statInfo(path: string): Promise<ClatFileInfo | undefined> {
	try {
		const info = await lstat(path);
		return {
			regular: info.isFile(),
			directory: info.isDirectory(),
			uid: info.uid,
			size: info.size,
		};
	} catch {
		return undefined;
	}
}

export function parseUnitShow(stdout: string): ClatUnitState | undefined {
	const rows = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		const at = line.indexOf("=");
		if (at > 0) rows.set(line.slice(0, at), line.slice(at + 1).trim());
	}
	const pid = Number(rows.get("MainPID"));
	const invocation = rows.get("InvocationID") ?? "";
	if (
		rows.get("ActiveState") !== "active" ||
		rows.get("SubState") !== "running" ||
		!Number.isSafeInteger(pid) ||
		pid <= 0 ||
		!/^[0-9a-f]{32}$/.test(invocation)
	)
		return undefined;
	return { invocation, mainPid: pid };
}

async function readUnit(): Promise<ClatUnitState | undefined> {
	try {
		const state = parseUnitShow(
			await run(
				"systemctl",
				[
					"show",
					CLAT_UNIT,
					"--property=ActiveState,SubState,MainPID,InvocationID",
				],
				{ timeout: 3_000, maxBuffer: 4096 },
			),
		);
		if (!state) return undefined;
		// A MainPID that is gone is not a running translator controller.
		return (await statInfo(`/proc/${state.mainPid}`))?.directory
			? state
			: undefined;
	} catch {
		return undefined;
	}
}

export const defaultClatReadDeps: ClatReadDeps = {
	dir: CLAT_SNAPSHOT_DIR,
	list: async (dir) => {
		try {
			return await readdir(dir);
		} catch {
			return [];
		}
	},
	stat: statInfo,
	read: (path) => readFile(path, "utf8"),
	sysfs: async (path) => {
		try {
			return (await readFile(path, "utf8")).trim();
		} catch {
			return undefined;
		}
	},
	unit: readUnit,
	isModem: (ifname) => modemStableKeyForIfname(ifname) !== undefined,
	now: Date.now,
	monotonic: () => performance.now(),
};

/** Per TUN: the `updated_at` value seen and our monotonic time when first seen. */
const firstSeen = new Map<string, { updatedAt: number; at: number }>();

export function resetClatTranslationStateForTest(): void {
	firstSeen.clear();
	lastGeneration.clear();
	current = new Map();
}

/** The translations that may carry stream traffic right now, keyed by TUN. */
export async function readClatTranslations(
	deps: ClatReadDeps = defaultClatReadDeps,
): Promise<ReadonlyMap<string, ClatTranslation>> {
	const usable = new Map<string, ClatTranslation>();
	const names = (await deps.list(deps.dir)).filter((name) =>
		/^\d{1,4}\.json$/.test(name),
	);
	if (names.length === 0) {
		firstSeen.clear();
		return usable;
	}
	const directory = await deps.stat(deps.dir);
	if (!directory?.directory || directory.uid !== 0) return usable;
	const unit = await deps.unit();
	if (!unit) return usable;
	const seen = new Set<string>();
	for (const name of names.slice(0, 64)) {
		const index = name.slice(0, -5);
		const path = join(deps.dir, name);
		const info = await deps.stat(path);
		if (
			!info?.regular ||
			info.uid !== 0 ||
			info.size <= 0 ||
			info.size > CLAT_SNAPSHOT_MAX_BYTES
		)
			continue;
		let snapshot: ClatSnapshot | undefined;
		try {
			snapshot = parseClatSnapshot(await deps.read(path), index);
		} catch {
			continue;
		}
		if (!snapshot) continue;
		seen.add(snapshot.tun);
		if (snapshot.state !== "up" || snapshot.prefix === null) continue;
		const now = deps.now();
		const age = now - snapshot.updatedAt;
		if (age > CLAT_SNAPSHOT_MAX_AGE_MS || age < -CLAT_SNAPSHOT_FUTURE_SKEW_MS)
			continue;
		if (snapshot.expiresAt !== undefined && now >= snapshot.expiresAt) continue;
		// Rereading an unchanged snapshot never renews it.
		const mono = deps.monotonic();
		const previous = firstSeen.get(snapshot.tun);
		if (previous?.updatedAt !== snapshot.updatedAt)
			firstSeen.set(snapshot.tun, { updatedAt: snapshot.updatedAt, at: mono });
		else if (mono - previous.at > CLAT_SNAPSHOT_MAX_AGE_MS) continue;
		if (
			(await deps.sysfs(`/sys/class/net/${snapshot.interface}/ifindex`)) !==
				index ||
			!deps.isModem(snapshot.interface)
		)
			continue;
		const flags = await deps.sysfs(`/sys/class/net/${snapshot.tun}/flags`);
		const tunIndex = await deps.sysfs(`/sys/class/net/${snapshot.tun}/ifindex`);
		if (
			flags === undefined ||
			!/^0x[0-9a-f]+$/i.test(flags) ||
			(Number.parseInt(flags, 16) & IFF_UP) === 0 ||
			tunIndex === undefined ||
			!/^\d+$/.test(tunIndex)
		)
			continue;
		usable.set(snapshot.tun, {
			parent: snapshot.interface,
			tun: snapshot.tun,
			ipv4: snapshot.ipv4,
			generation: [
				unit.invocation,
				tunIndex,
				index,
				snapshot.activation ?? "",
			].join(":"),
		});
	}
	for (const tun of [...firstSeen.keys()])
		if (!seen.has(tun)) firstSeen.delete(tun);
	return usable;
}

let current: ReadonlyMap<string, ClatTranslation> = new Map();
/** Per TUN: the generation last offered to the bond. */
const lastGeneration = new Map<string, string>();

/** Refresh the cached view; called once per interface scan. */
export async function refreshClatTranslations(
	deps: ClatReadDeps = defaultClatReadDeps,
): Promise<void> {
	let next: ReadonlyMap<string, ClatTranslation>;
	try {
		next = await readClatTranslations(deps);
	} catch {
		next = new Map();
	}
	const admitted = new Map<string, ClatTranslation>();
	for (const [tun, translation] of next) {
		const previous = lastGeneration.get(tun);
		lastGeneration.set(tun, translation.generation);
		// A new generation is withdrawn for this scan and offered on the next.
		if (previous !== undefined && previous !== translation.generation) continue;
		admitted.set(tun, translation);
	}
	for (const tun of [...lastGeneration.keys()])
		if (!next.has(tun)) lastGeneration.delete(tun);
	current = admitted;
}

export function setClatTranslationsForTest(
	value: ReadonlyMap<
		string,
		Omit<ClatTranslation, "generation"> & {
			generation?: string;
		}
	>,
): void {
	current = new Map(
		[...value].map(([tun, t]) => [tun, { generation: "test", ...t }]),
	);
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
