/*
  IPV4 TRANSLATION FOR IPV6-ONLY CELLULAR LINKS, AS THE IMAGE PROVIDES IT.

  Some carriers (T-Mobile US among them) give a modem IPv6 only. The image's
  `ceralive-clat.service` owns translation for such a link end to end: one tayga
  translator, a `clat<ifindex>` TUN with an IPv4 /32 in 10.254.0.0/19, its source
  rules, routes and NAT. CeraUI never creates, repairs or removes any of that,
  never starts a translator and never restores forwarding.

  It reads the service's v2 snapshot, `/run/ceralive/clat/<ifindex>.json`
  (contract: the image's `docs/cellular-clat.md`), on its own poll, and lets the
  TUN carry stream traffic for its modem only while every check holds. Every
  check fails closed:

  - a bounded, root-owned regular file in a root-owned directory;
  - schema version 2 with all 15 fields well-formed (anything else, including
    v1, is unavailable);
  - `boot_id` is this boot, `state` is `up`, and on CLOCK_BOOTTIME
    `0 <= observed_at <= now < expires_at` with `expires_at - observed_at == 30`.
    `updated_at` is diagnostic only. The lease is checked again each time the
    bond reads it, so reading never renews it and an expired lease drops out
    without waiting for the next poll;
  - the unit is active and running with a live MainPID, and its InvocationID is
    the snapshot's `invocation_id`;
  - the file index, the snapshot `ifindex` and the modem interface's current
    kernel ifindex agree, and that interface is a known modem;
  - the TUN is administratively up with exactly the snapshot's `tun_ifindex`
    (the bond also requires the snapshot IPv4 on it).

  The generation includes boot, invocation, the producer token, both ifindices,
  the parent, IPv4 and physical modem identity. A change withdraws the link for
  one poll before it is offered again, so the sender's reload path sees a withdrawal, never a swap.

  The TUN's IPv4 is the sender's bind source and the TUN its bind device; the
  modem interface itself has no IPv4 address.
*/

import { readFileSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { isIPv4, isIPv6 } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { run } from "../../helpers/run.ts";
import { isSafeIfname } from "./safe-ifname.ts";

export const CLAT_SNAPSHOT_DIR = "/run/ceralive/clat";
export const CLAT_LEASE_SECONDS = 30;
export const CLAT_POLL_INTERVAL_MS = 2_000;
const CLAT_SNAPSHOT_MAX_BYTES = 4096;
const CLAT_UNIT = "ceralive-clat.service";
const IFF_UP = 0x1;
/** Use the upper end of `/proc/uptime`'s 10 ms step for conservative expiry. */
const UPTIME_RESOLUTION_S = 0.01;

export type ClatState = "starting" | "up" | "unavailable" | "down" | "error";
export interface ClatSnapshot {
	readonly interface: string;
	readonly ifindex: number;
	readonly tun: string;
	readonly tunIfindex: number | null;
	readonly prefix: string | null;
	readonly ipv4: string;
	readonly state: ClatState;
	readonly bootId: string;
	readonly invocationId: string;
	readonly generation: string;
	readonly observedAt: number;
	readonly expiresAt: number;
}

const TUN_RE = /^clat(\d{1,10})$/;
const HEX32 = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PREFIX_LENGTHS = new Set([32, 40, 48, 56, 64, 96]);
const STATES = new Set<ClatState>([
	"starting",
	"up",
	"unavailable",
	"down",
	"error",
]);

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

const positiveInt = (v: unknown): v is number =>
	typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const finite = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v);

const REQUIRED = [
	"interface",
	"ifindex",
	"tun",
	"tun_ifindex",
	"prefix",
	"ipv4",
	"state",
	"last_error",
	"boot_id",
	"invocation_id",
	"generation",
	"updated_at",
	"observed_at",
	"expires_at",
] as const;

/** Strict parse of one v2 snapshot; `undefined` for anything unexpected. */
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
	const v = raw as Record<string, unknown>;
	if (v.schema_version !== 2) return undefined;
	if (
		REQUIRED.some((key) => !(key in v)) ||
		Object.keys(v).length !== REQUIRED.length + 1
	)
		return undefined;
	const parent = v.interface;
	if (typeof parent !== "string" || !isSafeIfname(parent)) return undefined;
	if (!positiveInt(v.ifindex) || String(v.ifindex) !== fileIndex)
		return undefined;
	if (typeof v.tun !== "string" || TUN_RE.exec(v.tun)?.[1] !== fileIndex)
		return undefined;
	if (v.tun_ifindex !== null && !positiveInt(v.tun_ifindex)) return undefined;
	if (
		v.prefix !== null &&
		(typeof v.prefix !== "string" || !isSupportedNat64Prefix(v.prefix))
	)
		return undefined;
	if (typeof v.ipv4 !== "string" || !inServiceSpace(v.ipv4)) return undefined;
	if (typeof v.state !== "string" || !STATES.has(v.state as ClatState))
		return undefined;
	if (v.last_error !== null && typeof v.last_error !== "string")
		return undefined;
	if (typeof v.boot_id !== "string" || !UUID.test(v.boot_id)) return undefined;
	if (typeof v.invocation_id !== "string" || !HEX32.test(v.invocation_id))
		return undefined;
	if (typeof v.generation !== "string" || !HEX32.test(v.generation))
		return undefined;
	if (!positiveInt(v.updated_at)) return undefined;
	if (!finite(v.observed_at) || !finite(v.expires_at)) return undefined;
	if (v.state !== "up" && v.expires_at !== v.observed_at) return undefined;
	return {
		interface: parent,
		ifindex: v.ifindex,
		tun: v.tun,
		tunIfindex: v.tun_ifindex as number | null,
		prefix: v.prefix as string | null,
		ipv4: v.ipv4,
		state: v.state as ClatState,
		bootId: v.boot_id,
		invocationId: v.invocation_id,
		generation: v.generation,
		observedAt: v.observed_at,
		expiresAt: v.expires_at,
	};
}

/** The lease rule for `up`: `0 <= observed_at <= now < expires_at`, 30 s long. */
export function leaseLive(
	snapshot: Pick<ClatSnapshot, "state" | "observedAt" | "expiresAt">,
	now: number,
): boolean {
	return (
		snapshot.state === "up" &&
		snapshot.observedAt >= 0 &&
		snapshot.observedAt <= now &&
		now + UPTIME_RESOLUTION_S < snapshot.expiresAt &&
		Math.abs(snapshot.expiresAt - snapshot.observedAt - CLAT_LEASE_SECONDS) <
			1e-6
	);
}

export interface ClatTranslation {
	readonly parent: string;
	readonly tun: string;
	readonly ipv4: string;
	readonly generation: string;
	/** CLOCK_BOOTTIME seconds; the bond re-checks it at every read. */
	readonly expiresAt: number;
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
	readonly ipv4: (tun: string, ip: string) => Promise<boolean>;
	readonly isModem: (ifname: string) => Promise<boolean>;
	readonly modemKey?: (ifname: string) => Promise<string | undefined>;
	readonly bootId: () => string | undefined;
	/** CLOCK_BOOTTIME seconds (suspend included). */
	readonly boottime: () => number | undefined;
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
		!HEX32.test(invocation)
	)
		return undefined;
	return { invocation, mainPid: pid };
}

export async function readUnit(
	show: () => Promise<string> = () =>
		run(
			"systemctl",
			[
				"show",
				CLAT_UNIT,
				"--property=ActiveState,SubState,MainPID,InvocationID",
			],
			{ timeout: 3_000, maxBuffer: 4096 },
		),
	stat: typeof statInfo = statInfo,
): Promise<ClatUnitState | undefined> {
	try {
		const state = parseUnitShow(await show());
		if (!state) return undefined;
		// A MainPID that is gone is not a running translator controller.
		return (await stat(`/proc/${state.mainPid}`))?.directory
			? state
			: undefined;
	} catch {
		return undefined;
	}
}

/** `/proc/uptime`'s first field is CLOCK_BOOTTIME, which includes suspend. */
export function readBoottime(): number | undefined {
	try {
		const value = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
		return Number.isFinite(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function readBootId(): string | undefined {
	try {
		const value = readFileSync(
			"/proc/sys/kernel/random/boot_id",
			"utf8",
		).trim();
		return UUID.test(value) ? value : undefined;
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
	unit: () => readUnit(),
	ipv4: async (tun, ip) =>
		networkInterfaces()[tun]?.some(
			(address) => address.family === "IPv4" && address.address === ip,
		) ?? false,
	modemKey: async (ifname) =>
		(await import("../modems/mutation-identity.ts")).modemStableKeyForIfname(
			ifname,
		),
	// Loaded on use: the modem modules import this layer, not the other way.
	isModem: async (ifname) =>
		(await import("../modems/mutation-identity.ts")).modemStableKeyForIfname(
			ifname,
		) !== undefined,
	bootId: readBootId,
	boottime: readBoottime,
};

/** The translations that may carry stream traffic right now, keyed by TUN. */
export async function readClatTranslations(
	deps: ClatReadDeps = defaultClatReadDeps,
): Promise<ReadonlyMap<string, ClatTranslation>> {
	const usable = new Map<string, ClatTranslation>();
	const names = (await deps.list(deps.dir)).filter((name) =>
		/^\d{1,10}\.json$/.test(name),
	);
	if (names.length === 0) return usable;
	const directory = await deps.stat(deps.dir);
	if (!directory?.directory || directory.uid !== 0) return usable;
	const boot = deps.bootId();
	if (boot === undefined) return usable;
	const unit = await deps.unit();
	if (!unit) return usable;
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
		if (
			!snapshot ||
			snapshot.prefix === null ||
			snapshot.tunIfindex === null ||
			snapshot.bootId !== boot ||
			snapshot.invocationId !== unit.invocation
		)
			continue;
		const now = deps.boottime();
		if (now === undefined || !leaseLive(snapshot, now)) continue;
		if (
			(await deps.sysfs(`/sys/class/net/${snapshot.interface}/ifindex`)) !==
				String(snapshot.ifindex) ||
			!(await deps.isModem(snapshot.interface))
		)
			continue;
		const flags = await deps.sysfs(`/sys/class/net/${snapshot.tun}/flags`);
		if (
			flags === undefined ||
			!/^0x[0-9a-f]+$/i.test(flags) ||
			(Number.parseInt(flags, 16) & IFF_UP) === 0 ||
			(await deps.sysfs(`/sys/class/net/${snapshot.tun}/ifindex`)) !==
				String(snapshot.tunIfindex)
		)
			continue;
		const modemKey = await deps.modemKey?.(snapshot.interface);
		if (deps.modemKey && !modemKey) continue;
		if (!(await deps.ipv4(snapshot.tun, snapshot.ipv4))) continue;
		usable.set(snapshot.tun, {
			parent: snapshot.interface,
			tun: snapshot.tun,
			ipv4: snapshot.ipv4,
			generation: [
				snapshot.bootId,
				snapshot.invocationId,
				snapshot.generation,
				snapshot.ifindex,
				snapshot.tunIfindex,
				snapshot.interface,
				snapshot.ipv4,
				...(modemKey ? [modemKey] : []),
			].join(":"),
			expiresAt: snapshot.expiresAt,
		});
	}
	return usable;
}

let current: ReadonlyMap<string, ClatTranslation> = new Map();
/** Per TUN: the generation last seen. */
const lastGeneration = new Map<string, string>();
let boottime: () => number | undefined = readBoottime;

export function resetClatTranslationStateForTest(): void {
	lastGeneration.clear();
	current = new Map();
	boottime = readBoottime;
}

/**
 * Refresh the cached view. Returns whether the set offered to the bond changed,
 * so the caller can republish.
 */
export async function refreshClatTranslations(
	deps: ClatReadDeps = defaultClatReadDeps,
): Promise<boolean> {
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
		// A new generation is withdrawn for this poll and offered on the next.
		if (previous !== undefined && previous !== translation.generation) continue;
		admitted.set(tun, translation);
	}
	for (const tun of [...lastGeneration.keys()])
		if (!next.has(tun)) lastGeneration.delete(tun);
	const key = (m: ReadonlyMap<string, ClatTranslation>) =>
		JSON.stringify([...m].map(([t, v]) => [t, v.generation, v.ipv4]).sort());
	const changed = key(admitted) !== key(current);
	current = admitted;
	boottime = deps.boottime;
	return changed;
}

export function setClatTranslationsForTest(
	value: ReadonlyMap<
		string,
		Omit<ClatTranslation, "generation" | "expiresAt"> & {
			generation?: string;
			expiresAt?: number;
		}
	>,
	clock: () => number | undefined = () => 0,
): void {
	current = new Map(
		[...value].map(([tun, t]) => [
			tun,
			{ generation: "test", expiresAt: Number.POSITIVE_INFINITY, ...t },
		]),
	);
	boottime = clock;
}

/** A name the image service mints for its translator TUN. */
export function isClatTunName(name: string): boolean {
	return TUN_RE.test(name);
}

/** The usable translation behind this TUN, if its address and lease still hold. */
export function clatTranslationFor(
	name: string,
	ip: string | undefined,
): ClatTranslation | undefined {
	const translation = current.get(name);
	if (!translation || ip !== translation.ipv4) return undefined;
	const now = boottime();
	return now !== undefined && now + UPTIME_RESOLUTION_S < translation.expiresAt
		? translation
		: undefined;
}

/** Own polling independently of interface events; a refresh error withdraws. */
export function startClatTranslationPolling(
	onChange: () => void,
	deps: ClatReadDeps = defaultClatReadDeps,
	schedule: typeof setInterval = setInterval,
): () => void {
	let running = false;
	const poll = async () => {
		if (running) return;
		running = true;
		try {
			if (await refreshClatTranslations(deps)) onChange();
		} finally {
			running = false;
		}
	};
	void poll();
	const timer = schedule(() => {
		void poll();
	}, CLAT_POLL_INTERVAL_MS);
	return () => clearInterval(timer);
}

/** Resolve the current parent for identity-only consumers. */
export function clatTranslationForTun(
	name: string,
): ClatTranslation | undefined {
	return clatTranslationFor(name, current.get(name)?.ipv4);
}

/** The TUN of the usable translation for this modem interface, if any. */
export function clatTunForParent(parent: string): string | undefined {
	for (const [tun, translation] of current)
		if (translation.parent === parent && clatTranslationForTun(tun)) return tun;
	return undefined;
}
