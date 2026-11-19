/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
 * Helper actions for Network › Devices.
 *
 * The helper role is a local authenticated session. The details disclosure
 * is not a role, and the app has no second role flag. A cloud socket
 * (remoteAddress "control-channel") or any relay sender id is refused
 * even when that socket is already authenticated.
 *
 * "Retry this port" starts ceralive-typec-recheck.service. That oneshot
 * runs ceralive-typec-policy in recheck mode, which owns the rebind and
 * the /run/ceralive-typec/rearm counter (k/3). This module only reads the
 * counter. It never writes it, so a click cannot reset the budget.
 *
 * "Put this modem on USB 2" starts ceralive-modem-usbspeed@<kernel>.service.
 * The USB 2 oneshot inhibits ModemManager itself (mmcli --inhibit-device)
 * and waits until that inhibit is granted. The lease taken here is only
 * the in-process streaming interlock. It does not call mmcli, so it cannot
 * hold a second inhibit and deadlock the unit.
 *
 * The lease is taken before any tree or unit I/O, and it is held until
 * systemd reports the unit idle. A backend restart re-acquires it when
 * the journaled unit is still active.
 *
 * USB 2 starts only when a fresh walk still shows the same enumeration
 * the server last published. Topology alone is not that identity.
 *
 * Confirmation does not override a stream, the budget, a missing unit,
 * or a remote caller.
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readdir,
	realpath,
	rename,
	rm,
} from "node:fs/promises";
import { dirname, join, sep } from "node:path";

import { logger } from "../../helpers/logger.ts";
import { modemStableKeyForIfname } from "../modems/mutation-identity.ts";
import { tryAcquireModemMutation } from "../streaming/lifecycle-admission.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import {
	helperUnitArgv,
	helperUnitIsActive,
	startHelperUnit,
} from "./usb-helper-start.ts";
import {
	boardFromIdentityText,
	readUsbTree,
	type UsbTreeNode,
} from "./usb-tree.ts";

export const HELPER_REARM_MAX = 3;
export const HELPER_ACTION_COOLDOWN_MS = 15_000;
export const TYPEC_UNIT = "ceralive-typec-recheck.service";
export const TYPEC_SUBJECT = "rock-5b-plus:typec:port0";
/** USB-C socket on the ROCK 5B+ port map. Retry and a modem on that socket share it. */
export const TYPEC_SCOPE = "socket:C";
/** Taken before any await so a stream cannot start during planning. */
export const HELPER_GATE_KEY = "devices-helper";

const KERNEL_PORT = /^[0-9]+-[0-9]+(?:\.[0-9]+)*$/;
const UNIT_TEMPLATE = "ceralive-modem-usbspeed@.service";
const ENTRY_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_NAME = /^socket:[A-Za-z0-9][A-Za-z0-9.>-]{0,64}$/;
const LEASE_NAME = /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,159}$/;
const JOURNAL_CAP = 32;
const JOURNAL_BYTES = 4096;
const UNIT_WAIT_MS = 360_000;
const POLL_MS = 1_000;

const UNIT_DIRS = [
	"etc/systemd/system",
	"run/systemd/system",
	"usr/lib/systemd/system",
	"lib/systemd/system",
] as const;

export const HELPER_ACTION_REFUSALS = [
	"not_helper",
	"remote_channel",
	"streaming_active",
	"unit_absent",
	"budget_exhausted",
	"action_in_progress",
	"cooldown",
	"identity_unresolved",
	"not_this_board",
	"not_confirmed",
	"start_failed",
] as const;

export type HelperActionRefusal = (typeof HELPER_ACTION_REFUSALS)[number];

export type HelperActionResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly refusal: HelperActionRefusal };

export type HelperActionOffer = {
	readonly ok: true;
	readonly retryPort: boolean;
	readonly rearmExhausted: boolean;
	readonly usb2: boolean;
};

export type HelperCaller = {
	readonly authenticated: boolean;
	readonly senderId?: string;
	readonly remoteAddress?: string;
};

export type HelperActionRequest =
	| { readonly action: "retry-port"; readonly confirmed: boolean }
	| {
			readonly action: "usb2";
			readonly confirmed: boolean;
			readonly key: string;
	  };

/** Identity captured when the device list was published. */
export type Usb2Identity = {
	readonly devnum: string;
	readonly stableKey: string;
	readonly scope: string;
	readonly kernelName: string;
};

export type Usb2Bound = {
	readonly unit: string;
	readonly leaseKey: string;
	readonly scope: string;
};

type Admission =
	| { readonly ok: true; readonly release: () => void }
	| { readonly ok: false; readonly refusal: string };

type LogFields = {
	readonly module: "devices";
	readonly action?: "retry-port" | "usb2";
	readonly ok?: boolean;
	readonly reason?: string;
};

type Deps = {
	readonly root: string;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly publish: () => Promise<void>;
	readonly admit: (key: string) => Promise<Admission> | Admission;
	readonly liveStream: () => boolean | Promise<boolean>;
	readonly beforeLease?: () => Promise<void>;
	readonly startUnit: (unit: string) => Promise<void>;
	readonly unitActive: (unit: string) => Promise<boolean>;
	readonly unitWaitMs: number;
	readonly pollMs: number;
	readonly watch: boolean;
	readonly stableKey: (ifname: string) => string | undefined;
	readonly resolveUsb2?: (key: string) => Promise<Usb2Bound | null>;
	readonly log: (message: string, fields: LogFields) => void;
};

type JournalEntry = {
	id: string;
	action: "retry-port" | "usb2";
	unit: string;
	scope: string;
	leaseKey: string;
	phase: "started" | "finished" | "failed";
	process: string;
	at: number;
	cooldownUntil?: number;
	detail?: string;
};

type Plan =
	| { readonly ok: false; readonly refusal: HelperActionRefusal }
	| {
			readonly ok: true;
			readonly unit: string;
			readonly leaseKey: string;
			readonly scope: string;
	  };

const processToken = randomUUID();
const inFlight = new Set<string>();
const cooldownUntil = new Map<string, number>();
const seen = new Map<string, Usb2Identity>();
const retained = new Map<string, () => void>();
let journalChain: Promise<void> = Promise.resolve();
let watching = false;

const defaultDeps: Deps = {
	root: "/",
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	startUnit: startHelperUnit,
	publish: async () => {
		const { publishUsbDevices } = await import("./usb-devices-wire.ts");
		await publishUsbDevices();
	},
	admit: (key) => {
		const admission = tryAcquireModemMutation(key);
		if (!admission.admitted) {
			return { ok: false, refusal: admission.refusal };
		}
		return { ok: true, release: admission.lease.release };
	},
	liveStream: () => getIsStreaming(),
	unitActive: helperUnitIsActive,
	unitWaitMs: UNIT_WAIT_MS,
	pollMs: POLL_MS,
	watch: true,
	stableKey: (ifname) => modemStableKeyForIfname(ifname),
	log: (message, fields) => {
		logger.info(message, fields);
	},
};

let override: Partial<Deps> | null = null;

function currentDeps(): Deps {
	return { ...defaultDeps, ...override };
}

function refuse(refusal: HelperActionRefusal): HelperActionResult {
	return { ok: false, refusal };
}

/**
 * Local authenticated session, or a refusal.
 * Remote is decided first: a cloud socket is authenticated and must still
 * be refused as a remote channel, not as a missing login.
 */
export function helperCallerRefusal(
	caller: HelperCaller,
): "not_helper" | "remote_channel" | null {
	const remote =
		(caller.senderId !== undefined && caller.senderId !== "") ||
		caller.remoteAddress === "control-channel";
	if (remote) return "remote_channel";
	if (!caller.authenticated) return "not_helper";
	return null;
}

export function usb2UnitName(port: string): string | null {
	if (!KERNEL_PORT.test(port)) return null;
	return `ceralive-modem-usbspeed@${port}.service`;
}

/**
 * Bind a USB 2 start to the enumeration the operator was shown.
 * A missing identity refuses. A different devnum, stable key, socket
 * or kernel name refuses. The row key is not an identity.
 */
export function bindUsb2Target(
	seenIdentity: Usb2Identity | undefined,
	fresh: {
		readonly devnum: string | null;
		readonly stableKey: string | null;
		readonly scope: string | null;
		readonly kernelName: string | null;
	} | null,
): Usb2Bound | null {
	if (seenIdentity === undefined || fresh === null) return null;
	if (
		fresh.devnum === null ||
		fresh.stableKey === null ||
		fresh.scope === null ||
		fresh.kernelName === null
	) {
		return null;
	}
	if (fresh.devnum !== seenIdentity.devnum) return null;
	if (fresh.stableKey !== seenIdentity.stableKey) return null;
	if (fresh.scope !== seenIdentity.scope) return null;
	if (fresh.kernelName !== seenIdentity.kernelName) return null;
	if (!SCOPE_NAME.test(fresh.scope) || !LEASE_NAME.test(fresh.stableKey)) {
		return null;
	}
	const unit = usb2UnitName(fresh.kernelName);
	if (unit === null || helperUnitArgv(unit) === null) return null;
	return { unit, leaseKey: fresh.stableKey, scope: fresh.scope };
}

/** Remember the enumeration just published. The names stay off the wire. */
export async function captureHelperSeen(
	roots: readonly UsbTreeNode[],
	sysfsRoot = "/",
): Promise<void> {
	const next = new Map<string, Usb2Identity>();
	const walk = async (nodes: readonly UsbTreeNode[]): Promise<void> => {
		for (const node of nodes) {
			if (node.kind === "modem") {
				const identity = await readIdentity(sysfsRoot, node);
				if (identity !== null) next.set(node.key, identity);
			}
			await walk(node.children);
		}
	};
	try {
		await walk(roots);
	} catch {
		currentDeps().log("helper identity was not captured", {
			module: "devices",
			reason: "capture-failed",
		});
		return;
	}
	seen.clear();
	for (const [key, identity] of next) seen.set(key, identity);
}

/** @deprecated The action no longer trusts a cached kernel port. */
export function rememberHelperPorts(roots: readonly UsbTreeNode[]): void {
	void captureHelperSeen(roots, currentDeps().root);
}

export function setHelperActionDepsForTest(next: Partial<Deps> | null): void {
	override = next;
	if (next === null) resetHelperActionGuardForTest();
}

export function resetHelperActionGuardForTest(): void {
	for (const release of retained.values()) release();
	retained.clear();
	inFlight.clear();
	cooldownUntil.clear();
	seen.clear();
	override = null;
	watching = false;
}

function journalDir(root: string): string {
	return join(root, "run/ceralive/devices-actions");
}

function entryPath(root: string, id: string): string | null {
	if (!ENTRY_ID.test(id)) return null;
	return join(journalDir(root), `${id}.json`);
}

async function withJournal<T>(fn: () => Promise<T>): Promise<T> {
	const run = journalChain.then(fn, fn);
	journalChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

async function readRegular(path: string, max: number): Promise<string | null> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const st = await handle.stat();
		if (!st.isFile() || st.size > max) return null;
		return await handle.readFile({ encoding: "utf8" });
	} catch {
		return null;
	} finally {
		await handle?.close();
	}
}

function isEntry(raw: unknown): raw is JournalEntry {
	if (typeof raw !== "object" || raw === null) return false;
	const entry = raw as Record<string, unknown>;
	return (
		typeof entry.id === "string" &&
		ENTRY_ID.test(entry.id) &&
		(entry.action === "retry-port" || entry.action === "usb2") &&
		typeof entry.unit === "string" &&
		helperUnitArgv(entry.unit) !== null &&
		typeof entry.scope === "string" &&
		SCOPE_NAME.test(entry.scope) &&
		typeof entry.leaseKey === "string" &&
		LEASE_NAME.test(entry.leaseKey) &&
		(entry.phase === "started" ||
			entry.phase === "finished" ||
			entry.phase === "failed") &&
		typeof entry.process === "string" &&
		entry.process.length > 0 &&
		entry.process.length <= 80 &&
		typeof entry.at === "number" &&
		(entry.cooldownUntil === undefined ||
			typeof entry.cooldownUntil === "number") &&
		(entry.detail === undefined ||
			entry.detail === "interrupted" ||
			entry.detail === "start-failed" ||
			entry.detail === "identity-changed")
	);
}

async function loadJournal(root: string): Promise<JournalEntry[] | null> {
	const dir = journalDir(root);
	let names: string[];
	try {
		const st = await lstat(dir);
		if (!st.isDirectory()) return null;
		names = await readdir(dir);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return [];
		return null;
	}
	const entries: JournalEntry[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const id = name.slice(0, -".json".length);
		const path = entryPath(root, id);
		if (path === null) return null;
		const text = await readRegular(path, JOURNAL_BYTES);
		if (text === null) return null;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return null;
		}
		if (!isEntry(parsed) || parsed.id !== id) return null;
		entries.push(parsed);
	}
	return entries;
}

async function saveEntry(root: string, entry: JournalEntry): Promise<boolean> {
	const path = entryPath(root, entry.id);
	if (path === null) return false;
	const dir = dirname(path);
	const tmp = join(dir, `.${entry.id}.${randomUUID()}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		handle = await open(
			tmp,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
			0o600,
		);
		await handle.writeFile(JSON.stringify(entry));
		await handle.close();
		handle = undefined;
		await rename(tmp, path);
		await trimJournal(root);
		return true;
	} catch {
		currentDeps().log("helper action journal was not saved", {
			module: "devices",
			reason: "journal-failed",
		});
		await rm(tmp, { force: true }).catch(() => undefined);
		return false;
	} finally {
		await handle?.close();
	}
}

async function trimJournal(root: string): Promise<void> {
	const entries = await loadJournal(root);
	if (entries === null || entries.length <= JOURNAL_CAP) return;
	const finished = entries
		.filter((entry) => entry.phase !== "started")
		.sort((a, b) => a.at - b.at);
	const room = Math.max(0, JOURNAL_CAP - (entries.length - finished.length));
	const drop = finished.slice(0, Math.max(0, finished.length - room));
	for (const entry of drop) {
		const path = entryPath(root, entry.id);
		if (path !== null) await rm(path, { force: true });
	}
}

function rememberCooldown(entries: readonly JournalEntry[], now: number): void {
	for (const entry of entries) {
		if (entry.cooldownUntil === undefined || entry.cooldownUntil <= now) {
			continue;
		}
		const prev = cooldownUntil.get(entry.scope) ?? 0;
		if (entry.cooldownUntil > prev) {
			cooldownUntil.set(entry.scope, entry.cooldownUntil);
		}
	}
}

/**
 * A start that has no matching end belongs to a process that is gone.
 * If systemd still has the job, take the lease again and keep the scope
 * busy. Otherwise mark the record failed. Do not start the unit again.
 */
export async function restoreHelperInterlock(): Promise<boolean> {
	return withJournal(async () => {
		const deps = currentDeps();
		const entries = await loadJournal(deps.root);
		if (entries === null) return false;
		rememberCooldown(entries, deps.now());
		for (const entry of entries) {
			if (entry.phase !== "started" || entry.process === processToken) {
				continue;
			}
			const active = await deps.unitActive(entry.unit).catch(() => true);
			if (!active) {
				entry.phase = "failed";
				entry.detail = "interrupted";
				entry.at = deps.now();
				if (!(await saveEntry(deps.root, entry))) return false;
				continue;
			}
			inFlight.add(entry.scope);
			if (retained.has(entry.scope)) continue;
			const admission = await deps.admit(entry.leaseKey);
			if (admission.ok) retained.set(entry.scope, admission.release);
		}
		if (deps.watch) ensureWatch();
		return true;
	});
}

async function appendJournal(entry: JournalEntry): Promise<boolean> {
	return withJournal(async () => {
		const root = currentDeps().root;
		const entries = await loadJournal(root);
		if (entries === null) return false;
		if (entries.some((item) => item.id === entry.id)) return false;
		return saveEntry(root, entry);
	});
}

async function updateJournal(
	id: string,
	phase: "finished" | "failed",
	detail?: JournalEntry["detail"],
	cooldownAt?: number,
): Promise<boolean> {
	return withJournal(async () => {
		const root = currentDeps().root;
		const entries = await loadJournal(root);
		if (entries === null) return false;
		const entry = entries.find((item) => item.id === id);
		if (entry === undefined) return false;
		entry.phase = phase;
		entry.at = currentDeps().now();
		if (detail !== undefined) entry.detail = detail;
		if (cooldownAt !== undefined) entry.cooldownUntil = cooldownAt;
		return saveEntry(root, entry);
	});
}

async function pathKind(path: string): Promise<"absent" | "file" | "other"> {
	try {
		const st = await lstat(path);
		if (st.isSymbolicLink()) return "other";
		if (st.isFile()) return "file";
		return "other";
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return "absent";
		return "other";
	}
}

async function oneshotFile(path: string): Promise<boolean> {
	let real: string;
	try {
		real = await realpath(path);
		const st = await lstat(real);
		if (!st.isFile()) return false;
	} catch {
		return false;
	}
	const text = await readRegular(real, 65_536);
	if (text === null) return false;
	return /^Type=oneshot$/m.test(text);
}

async function dropInPresent(root: string, unit: string): Promise<boolean> {
	for (const dir of UNIT_DIRS) {
		if ((await pathKind(join(root, dir, `${unit}.d`))) !== "absent") {
			return true;
		}
	}
	return false;
}

async function firstUnitFile(
	root: string,
	unit: string,
): Promise<"absent" | "ready" | "rejected"> {
	for (const dir of UNIT_DIRS) {
		const path = join(root, dir, unit);
		const kind = await pathKind(path);
		if (kind === "absent") continue;
		if (kind !== "file") return "rejected";
		return (await oneshotFile(path)) ? "ready" : "rejected";
	}
	return "absent";
}

/**
 * The unit systemd would start. The name is allowlisted first, so a
 * client string never becomes an argument. A mask, a symlink, a drop-in,
 * or a file that is not a regular Type=oneshot refuses. An instance with
 * no concrete file uses the template only when that template is a regular
 * oneshot and nothing higher priority masks the instance.
 */
export async function helperUnitReady(
	root: string,
	unit: string,
): Promise<boolean> {
	if (helperUnitArgv(unit) === null) return false;
	if (await dropInPresent(root, unit)) return false;
	const concrete = await firstUnitFile(root, unit);
	if (concrete === "rejected") return false;
	if (concrete === "ready") return true;
	if (!unit.startsWith("ceralive-modem-usbspeed@")) return false;
	if (await dropInPresent(root, UNIT_TEMPLATE)) return false;
	return (await firstUnitFile(root, UNIT_TEMPLATE)) === "ready";
}

/**
 * The image writes an integer. Missing means none used yet.
 * Any other stat or read failure is fail-closed.
 */
async function rearmCount(root: string): Promise<number | null> {
	const path = join(root, "run/ceralive-typec/rearm");
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return 0;
		return null;
	}
	try {
		const st = await handle.stat();
		if (!st.isFile() || st.size > 64) return null;
		const value = (await handle.readFile({ encoding: "utf8" })).trim();
		if (!/^[0-9]+$/.test(value)) return null;
		const count = Number(value);
		if (!Number.isSafeInteger(count)) return null;
		return count;
	} catch {
		return null;
	} finally {
		await handle.close();
	}
}

async function readMaybe(path: string): Promise<string | null> {
	return readRegular(path, 4096);
}

async function rockBoard(root: string): Promise<boolean> {
	const text = await readMaybe(join(root, "proc/device-tree/compatible"));
	return boardFromIdentityText(text) === "rock-5b-plus";
}

function findNode(
	nodes: readonly UsbTreeNode[],
	key: string,
): UsbTreeNode | null {
	for (const node of nodes) {
		if (node.key === key) return node;
		const child = findNode(node.children, key);
		if (child !== null) return child;
	}
	return null;
}

async function containedPath(
	root: string,
	kernelName: string,
): Promise<string | null> {
	if (!KERNEL_PORT.test(kernelName)) return null;
	try {
		const rootReal = await realpath(root);
		const device = await realpath(
			join(root, "sys/bus/usb/devices", kernelName),
		);
		const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
		if (device !== rootReal && !device.startsWith(prefix)) return null;
		return device;
	} catch {
		return null;
	}
}

async function netIfnames(
	devicePath: string,
	kernelName: string,
): Promise<string[]> {
	let names: string[];
	try {
		names = await readdir(devicePath);
	} catch {
		return [];
	}
	const found: string[] = [];
	for (const name of names) {
		if (!name.startsWith(`${kernelName}:`)) continue;
		const netDir = join(devicePath, name, "net");
		let nets: string[];
		try {
			const st = await lstat(netDir);
			if (!st.isDirectory()) continue;
			nets = await readdir(netDir);
		} catch {
			continue;
		}
		for (const net of nets) {
			if (/^[A-Za-z][A-Za-z0-9._-]{0,15}$/.test(net)) found.push(net);
		}
	}
	return found;
}

async function readIdentity(
	root: string,
	node: UsbTreeNode,
): Promise<Usb2Identity | null> {
	if (node.kind !== "modem") return null;
	const device = await containedPath(root, node.kernelName);
	if (device === null) return null;
	const devnumText = await readRegular(join(device, "devnum"), 32);
	const devnum = devnumText?.trim() ?? null;
	if (devnum === null || !/^[0-9]+$/.test(devnum)) return null;
	const scope = `socket:${node.socketKey}`;
	if (!SCOPE_NAME.test(scope)) return null;
	let stableKey: string | null = null;
	for (const ifname of await netIfnames(device, node.kernelName)) {
		const key = currentDeps().stableKey(ifname);
		if (key === undefined) continue;
		if (stableKey !== null && stableKey !== key) return null;
		stableKey = key;
	}
	if (stableKey === null || !LEASE_NAME.test(stableKey)) return null;
	if (!KERNEL_PORT.test(node.kernelName)) return null;
	return {
		devnum,
		stableKey,
		scope,
		kernelName: node.kernelName,
	};
}

async function resolveUsb2(key: string): Promise<Usb2Bound | null> {
	const deps = currentDeps();
	if (deps.resolveUsb2 !== undefined) return deps.resolveUsb2(key);
	let tree: Awaited<ReturnType<typeof readUsbTree>>;
	try {
		tree = await readUsbTree({ sysfsRoot: deps.root });
	} catch {
		return null;
	}
	const node = findNode(tree.roots, key);
	if (node === null) return null;
	const fresh = await readIdentity(deps.root, node);
	return bindUsb2Target(
		seen.get(key),
		fresh === null
			? null
			: {
					devnum: fresh.devnum,
					stableKey: fresh.stableKey,
					scope: fresh.scope,
					kernelName: fresh.kernelName,
				},
	);
}

async function usb2TemplateReady(root: string): Promise<boolean> {
	for (const dir of UNIT_DIRS) {
		if ((await pathKind(join(root, dir, `${UNIT_TEMPLATE}.d`))) !== "absent") {
			return false;
		}
	}
	for (const dir of UNIT_DIRS) {
		const path = join(root, dir, UNIT_TEMPLATE);
		const kind = await pathKind(path);
		if (kind === "absent") continue;
		if (kind !== "file") return false;
		return oneshotFile(path);
	}
	return false;
}

async function plan(request: HelperActionRequest, deps: Deps): Promise<Plan> {
	if (!(await rockBoard(deps.root))) {
		return { ok: false, refusal: "not_this_board" };
	}
	if (request.action === "retry-port") {
		if (!(await helperUnitReady(deps.root, TYPEC_UNIT))) {
			return { ok: false, refusal: "unit_absent" };
		}
		const count = await rearmCount(deps.root);
		if (count === null || count >= HELPER_REARM_MAX) {
			return { ok: false, refusal: "budget_exhausted" };
		}
		return {
			ok: true,
			unit: TYPEC_UNIT,
			leaseKey: TYPEC_SUBJECT,
			scope: TYPEC_SCOPE,
		};
	}
	if (!(await usb2TemplateReady(deps.root))) {
		return { ok: false, refusal: "unit_absent" };
	}
	const bound = await resolveUsb2(request.key);
	if (bound === null) return { ok: false, refusal: "identity_unresolved" };
	if (!(await helperUnitReady(deps.root, bound.unit))) {
		return { ok: false, refusal: "unit_absent" };
	}
	return {
		ok: true,
		unit: bound.unit,
		leaseKey: bound.leaseKey,
		scope: bound.scope,
	};
}

function mapAdmit(refusal: string): HelperActionResult {
	if (refusal === "streaming_active") return refuse("streaming_active");
	if (refusal === "mutation_in_progress") return refuse("action_in_progress");
	return refuse("start_failed");
}

async function waitUntilIdle(unit: string, deps: Deps): Promise<boolean> {
	const deadline = deps.now() + deps.unitWaitMs;
	for (;;) {
		const active = await deps.unitActive(unit).catch(() => true);
		if (!active) return true;
		if (deps.now() >= deadline) return false;
		await deps.sleep(deps.pollMs);
	}
}

function ensureWatch(): void {
	if (watching) return;
	watching = true;
	void (async () => {
		while (retained.size > 0) {
			const deps = currentDeps();
			await deps.sleep(deps.pollMs);
			await pollHelperInterlock();
		}
		watching = false;
	})();
}

/** Drop leases whose units have reached a terminal state. */
export async function pollHelperInterlock(): Promise<void> {
	const deps = currentDeps();
	for (const [scope, release] of [...retained.entries()]) {
		const entries = await loadJournal(deps.root);
		const entry = entries?.find(
			(item) => item.scope === scope && item.phase === "started",
		);
		const active =
			entry === undefined
				? false
				: await deps.unitActive(entry.unit).catch(() => true);
		if (active) continue;
		release();
		retained.delete(scope);
		inFlight.delete(scope);
		if (entry !== undefined) {
			const until = deps.now() + HELPER_ACTION_COOLDOWN_MS;
			cooldownUntil.set(scope, until);
			await updateJournal(entry.id, "failed", "interrupted", until);
		}
	}
}

export async function readHelperActionOffer(
	caller: HelperCaller,
): Promise<
	| HelperActionOffer
	| { readonly ok: false; readonly refusal: HelperActionRefusal }
> {
	const callerRefusal = helperCallerRefusal(caller);
	if (callerRefusal !== null) {
		return { ok: false, refusal: callerRefusal };
	}
	await restoreHelperInterlock();
	const deps = currentDeps();
	const rock = await rockBoard(deps.root);
	const typec = await helperUnitReady(deps.root, TYPEC_UNIT);
	const count = await rearmCount(deps.root);
	const exhausted =
		rock && typec && (count === null || count >= HELPER_REARM_MAX);
	const retry = rock && typec && count !== null && count < HELPER_REARM_MAX;
	const usb2 = rock && (await usb2TemplateReady(deps.root));
	return {
		ok: true,
		retryPort: retry,
		rearmExhausted: exhausted,
		usb2,
	};
}

export async function runHelperAction(
	request: HelperActionRequest,
	caller: HelperCaller,
): Promise<HelperActionResult> {
	const callerRefusal = helperCallerRefusal(caller);
	if (callerRefusal !== null) return refuse(callerRefusal);
	if (!request.confirmed) return refuse("not_confirmed");

	const deps = currentDeps();
	// Test seam for the window that used to sit before the lease.
	// Production leaves it unset, so the admit below is the first await.
	if (deps.beforeLease !== undefined) await deps.beforeLease();

	const gate = await deps.admit(HELPER_GATE_KEY);
	if (!gate.ok) return mapAdmit(gate.refusal);
	const releases: Array<() => void> = [gate.release];
	let claimed: string | undefined;
	let retain = false;
	try {
		if (!(await restoreHelperInterlock())) return refuse("start_failed");

		const planned = await plan(request, deps);
		if (!planned.ok) return planned;
		if (inFlight.has(planned.scope)) return refuse("action_in_progress");
		if (deps.now() < (cooldownUntil.get(planned.scope) ?? 0)) {
			return refuse("cooldown");
		}
		inFlight.add(planned.scope);
		claimed = planned.scope;

		if (planned.leaseKey !== HELPER_GATE_KEY) {
			const specific = await deps.admit(planned.leaseKey);
			if (!specific.ok) return mapAdmit(specific.refusal);
			releases.push(specific.release);
		}
		// The mutation lease is held, including across the planning awaits.
		// A stream that finished its own admission in that window is refused
		// here, before the unit starts.
		if (await deps.liveStream()) return refuse("streaming_active");

		if (request.action === "usb2") {
			const again = await resolveUsb2(request.key);
			if (
				again === null ||
				again.unit !== planned.unit ||
				again.leaseKey !== planned.leaseKey ||
				again.scope !== planned.scope
			) {
				return refuse("identity_unresolved");
			}
		}

		const id = randomUUID();
		const started: JournalEntry = {
			id,
			action: request.action,
			unit: planned.unit,
			scope: planned.scope,
			leaseKey: planned.leaseKey,
			phase: "started",
			process: processToken,
			at: deps.now(),
		};
		if (!(await appendJournal(started))) return refuse("start_failed");
		deps.log("helper port action started", {
			module: "devices",
			action: request.action,
		});

		if (request.action === "usb2") {
			const again = await resolveUsb2(request.key);
			if (again === null || again.unit !== planned.unit) {
				await updateJournal(id, "failed", "identity-changed");
				return refuse("identity_unresolved");
			}
		}

		let clientOk = true;
		try {
			await deps.startUnit(planned.unit);
		} catch {
			clientOk = false;
		}
		const idle = await waitUntilIdle(planned.unit, deps);
		if (!idle) {
			retain = true;
			await updateJournal(id, "failed", "start-failed");
			deps.log("helper port action finished", {
				module: "devices",
				action: request.action,
				ok: false,
				reason: "start-failed",
			});
			if (deps.watch) ensureWatch();
			return refuse("start_failed");
		}
		if (!clientOk) {
			const until = deps.now() + HELPER_ACTION_COOLDOWN_MS;
			await updateJournal(id, "failed", "start-failed", until);
			cooldownUntil.set(planned.scope, until);
			deps.log("helper port action finished", {
				module: "devices",
				action: request.action,
				ok: false,
				reason: "start-failed",
			});
			return refuse("start_failed");
		}
		const until = deps.now() + HELPER_ACTION_COOLDOWN_MS;
		if (!(await updateJournal(id, "finished", undefined, until))) {
			return refuse("start_failed");
		}
		cooldownUntil.set(planned.scope, until);
		deps.log("helper port action finished", {
			module: "devices",
			action: request.action,
			ok: true,
		});
		try {
			await deps.publish();
		} catch {
			deps.log("helper port action did not republish devices", {
				module: "devices",
				reason: "republish-failed",
			});
		}
		return { ok: true };
	} finally {
		const releaseAll = (): void => {
			for (const release of releases) release();
			releases.length = 0;
		};
		if (retain && claimed !== undefined) {
			retained.set(claimed, releaseAll);
		} else {
			releaseAll();
			if (claimed !== undefined) inFlight.delete(claimed);
		}
	}
}
