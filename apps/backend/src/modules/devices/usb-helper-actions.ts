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
 * Confirmation does not override a stream, the budget, a missing unit,
 * or a remote caller.
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { logger } from "../../helpers/logger.ts";
import { tryAcquireModemMutation } from "../streaming/lifecycle-admission.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import { startHelperUnit } from "./usb-helper-start.ts";
import { boardFromIdentityText, type UsbTreeNode } from "./usb-tree.ts";

export const HELPER_REARM_MAX = 3;
export const HELPER_ACTION_COOLDOWN_MS = 15_000;
export const TYPEC_UNIT = "ceralive-typec-recheck.service";
export const TYPEC_SUBJECT = "rock-5b-plus:typec:port0";

const KERNEL_PORT = /^[0-9]+-[0-9]+(?:\.[0-9]+)*$/;
const JOURNAL_CAP = 32;

const TYPEC_UNIT_PATHS = [
	"etc/systemd/system/ceralive-typec-recheck.service",
	"usr/lib/systemd/system/ceralive-typec-recheck.service",
	"lib/systemd/system/ceralive-typec-recheck.service",
] as const;

const USB2_UNIT_PATHS = [
	"etc/systemd/system/ceralive-modem-usbspeed@.service",
	"usr/lib/systemd/system/ceralive-modem-usbspeed@.service",
	"lib/systemd/system/ceralive-modem-usbspeed@.service",
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

type Admission =
	| { readonly ok: true; readonly release: () => void }
	| { readonly ok: false; readonly refusal: string };

type Deps = {
	readonly root: string;
	readonly now: () => number;
	readonly startUnit: (unit: string) => Promise<void>;
	readonly publish: () => Promise<void>;
	readonly admit: (key: string) => Promise<Admission> | Admission;
	readonly liveStream: () => boolean | Promise<boolean>;
	readonly portForKey: (key: string) => string | undefined;
};

type JournalEntry = {
	id: string;
	action: "retry-port" | "usb2";
	unit: string;
	phase: "started" | "finished" | "failed";
	process: string;
	at: number;
	detail?: string;
};

const processToken = randomUUID();
const inFlight = new Set<string>();
const cooldownUntil = new Map<string, number>();
const ports = new Map<string, string>();

const defaultDeps: Deps = {
	root: "/",
	now: () => Date.now(),
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
	portForKey: (key) => ports.get(key),
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

/** Remember kernel ports for modem rows. The names stay off the wire. */
export function rememberHelperPorts(roots: readonly UsbTreeNode[]): void {
	const next = new Map<string, string>();
	const walk = (nodes: readonly UsbTreeNode[]): void => {
		for (const node of nodes) {
			if (node.kind === "modem" && KERNEL_PORT.test(node.kernelName)) {
				next.set(node.key, node.kernelName);
			}
			walk(node.children);
		}
	};
	walk(roots);
	ports.clear();
	for (const [key, name] of next) ports.set(key, name);
}

export function setHelperActionDepsForTest(next: Partial<Deps> | null): void {
	override = next;
	if (next === null) {
		inFlight.clear();
		cooldownUntil.clear();
	}
}

export function resetHelperActionGuardForTest(): void {
	inFlight.clear();
	cooldownUntil.clear();
	override = null;
	ports.clear();
}

function journalPath(root: string): string {
	return join(root, "run/ceralive/devices-actions.json");
}

async function regularFile(path: string): Promise<boolean> {
	try {
		const st = await lstat(path);
		return st.isFile();
	} catch {
		return false;
	}
}

async function unitPresent(
	root: string,
	rels: readonly string[],
): Promise<boolean> {
	for (const rel of rels) {
		if (await regularFile(join(root, rel))) return true;
	}
	return false;
}

/**
 * The image writes an integer. Missing means none used yet.
 * A symlink, a fifo, or a non-integer is fail-closed: we do not treat
 * it as zero, and we do not rewrite the file.
 */
async function rearmCount(root: string): Promise<number | null> {
	const path = join(root, "run/ceralive-typec/rearm");
	try {
		const st = await lstat(path);
		if (!st.isFile()) return null;
	} catch {
		return 0;
	}
	try {
		const value = (await readFile(path, "utf8")).trim();
		if (!/^[0-9]+$/.test(value)) return null;
		const count = Number(value);
		if (!Number.isSafeInteger(count)) return null;
		return count;
	} catch {
		return null;
	}
}

function isEntry(raw: unknown): raw is JournalEntry {
	if (typeof raw !== "object" || raw === null) return false;
	const entry = raw as Record<string, unknown>;
	return (
		typeof entry.id === "string" &&
		entry.id.length > 0 &&
		entry.id.length <= 80 &&
		(entry.action === "retry-port" || entry.action === "usb2") &&
		typeof entry.unit === "string" &&
		entry.unit.length > 0 &&
		entry.unit.length <= 80 &&
		(entry.phase === "started" ||
			entry.phase === "finished" ||
			entry.phase === "failed") &&
		typeof entry.process === "string" &&
		entry.process.length > 0 &&
		entry.process.length <= 80 &&
		typeof entry.at === "number"
	);
}

async function loadJournal(root: string): Promise<JournalEntry[] | null> {
	const path = journalPath(root);
	try {
		const st = await lstat(path);
		if (!st.isFile()) return null;
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!Array.isArray(parsed)) return null;
		return parsed.filter(isEntry);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return [];
		return null;
	}
}

async function saveJournal(
	root: string,
	entries: readonly JournalEntry[],
): Promise<boolean> {
	const path = journalPath(root);
	const tmp = `${path}.${processToken}.tmp`;
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(tmp, JSON.stringify(entries.slice(-JOURNAL_CAP)));
		await rename(tmp, path);
		return true;
	} catch (err) {
		logger.warn("helper action journal was not saved", {
			module: "devices",
			err,
		});
		return false;
	}
}

/**
 * A start that has no matching end belongs to a process that is gone.
 * Mark it failed. Do not start the unit again from this record.
 */
export async function recoverHelperActionJournal(): Promise<boolean> {
	const entries = await loadJournal(currentDeps().root);
	if (entries === null) return false;
	let changed = false;
	const at = currentDeps().now();
	for (const entry of entries) {
		if (entry.phase === "started" && entry.process !== processToken) {
			entry.phase = "failed";
			entry.detail = "interrupted";
			entry.at = at;
			changed = true;
		}
	}
	if (!changed) return true;
	return saveJournal(currentDeps().root, entries);
}

async function appendJournal(
	entry: JournalEntry,
): Promise<JournalEntry[] | null> {
	const root = currentDeps().root;
	const entries = await loadJournal(root);
	if (entries === null) return null;
	entries.push(entry);
	if (!(await saveJournal(root, entries))) return null;
	return entries;
}

async function updateJournal(
	id: string,
	phase: "finished" | "failed",
	detail?: string,
): Promise<void> {
	const root = currentDeps().root;
	const entries = await loadJournal(root);
	if (entries === null) return;
	const entry = entries.find((item) => item.id === id);
	if (entry === undefined) return;
	entry.phase = phase;
	entry.at = currentDeps().now();
	if (detail !== undefined) entry.detail = detail;
	await saveJournal(root, entries);
}

type Plan =
	| { readonly ok: false; readonly refusal: HelperActionRefusal }
	| { readonly ok: true; readonly unit: string; readonly leaseKey: string };

async function plan(request: HelperActionRequest, deps: Deps): Promise<Plan> {
	if (request.action === "retry-port") {
		const text = await readMaybe(
			join(deps.root, "proc/device-tree/compatible"),
		);
		if (boardFromIdentityText(text) !== "rock-5b-plus") {
			return { ok: false, refusal: "not_this_board" };
		}
		if (!(await unitPresent(deps.root, TYPEC_UNIT_PATHS))) {
			return { ok: false, refusal: "unit_absent" };
		}
		const count = await rearmCount(deps.root);
		if (count === null || count >= HELPER_REARM_MAX) {
			return { ok: false, refusal: "budget_exhausted" };
		}
		return { ok: true, unit: TYPEC_UNIT, leaseKey: TYPEC_SUBJECT };
	}
	if (!(await unitPresent(deps.root, USB2_UNIT_PATHS))) {
		return { ok: false, refusal: "unit_absent" };
	}
	const port = deps.portForKey(request.key);
	const unit = port === undefined ? null : usb2UnitName(port);
	if (unit === null) return { ok: false, refusal: "identity_unresolved" };
	return { ok: true, unit, leaseKey: request.key };
}

async function readMaybe(path: string): Promise<string | null> {
	try {
		const st = await lstat(path);
		if (!st.isFile()) return null;
		return await readFile(path, "utf8");
	} catch {
		return null;
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
	await recoverHelperActionJournal();
	const deps = currentDeps();
	const text = await readMaybe(join(deps.root, "proc/device-tree/compatible"));
	const rock = boardFromIdentityText(text) === "rock-5b-plus";
	const typec = await unitPresent(deps.root, TYPEC_UNIT_PATHS);
	const count = await rearmCount(deps.root);
	const exhausted =
		rock && typec && (count === null || count >= HELPER_REARM_MAX);
	const retry = rock && typec && count !== null && count < HELPER_REARM_MAX;
	const usb2 = await unitPresent(deps.root, USB2_UNIT_PATHS);
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

	// A live stream and the admission lease both refuse. Confirmation
	// does not override either one.
	if (await currentDeps().liveStream()) return refuse("streaming_active");

	const subject =
		request.action === "retry-port" ? TYPEC_SUBJECT : `usb2:${request.key}`;
	// One action at a time per port. A second call while this one is
	// inside systemctl start must not queue another rebind.
	if (inFlight.has(subject)) return refuse("action_in_progress");
	if (currentDeps().now() < (cooldownUntil.get(subject) ?? 0)) {
		return refuse("cooldown");
	}
	inFlight.add(subject);
	let release: (() => void) | undefined;
	let attempted = false;
	try {
		if (!(await recoverHelperActionJournal())) return refuse("start_failed");
		const deps = currentDeps();
		const planned = await plan(request, deps);
		if (!planned.ok) return planned;
		const admission = await deps.admit(planned.leaseKey);
		if (!admission.ok) {
			if (admission.refusal === "streaming_active") {
				return refuse("streaming_active");
			}
			if (admission.refusal === "mutation_in_progress") {
				return refuse("action_in_progress");
			}
			return refuse("start_failed");
		}
		release = admission.release;
		const id = randomUUID();
		const started: JournalEntry = {
			id,
			action: request.action,
			unit: planned.unit,
			phase: "started",
			process: processToken,
			at: deps.now(),
		};
		if ((await appendJournal(started)) === null) return refuse("start_failed");
		logger.info("helper port action started", {
			module: "devices",
			action: request.action,
		});
		attempted = true;
		try {
			await deps.startUnit(planned.unit);
		} catch (err) {
			await updateJournal(id, "failed", "start-failed");
			logger.info("helper port action finished", {
				module: "devices",
				action: request.action,
				ok: false,
				err,
			});
			return refuse("start_failed");
		}
		await updateJournal(id, "finished");
		logger.info("helper port action finished", {
			module: "devices",
			action: request.action,
			ok: true,
		});
		try {
			await deps.publish();
		} catch (err) {
			logger.warn("helper port action did not republish devices", {
				module: "devices",
				err,
			});
		}
		return { ok: true };
	} finally {
		release?.();
		inFlight.delete(subject);
		if (attempted) {
			cooldownUntil.set(
				subject,
				currentDeps().now() + HELPER_ACTION_COOLDOWN_MS,
			);
		}
	}
}
