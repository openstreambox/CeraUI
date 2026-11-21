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
  THE SNAPSHOT FOR THE BOX'S OWN STATUS SCREEN

  The image paints a status page on a monitor plugged into the box, meant to be
  photographed for support (image `docs/status-screen.md`). What only this
  application knows reaches it through one small file:

    /run/ceralive/status-screen/snapshot.json   (schema 2, mode 0644)

  The file carries codes, kinds and states only, never free text. Every field
  is built here from an enum or a checked token, so names the backend holds
  (Wi-Fi networks, destinations, stream keys, modem names, IMEI, ICCID, phone
  numbers, operator names) have no field to arrive in. The page maps the codes
  to its own fixed wording.

  It is rewritten atomically when its content changes and at least every
  30 s; `expires` lets the page notice when this application stops.
*/

import { lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	type StreamReadiness,
	type UplinkHealthRecord,
	type UplinkHealthState,
	type UplinkKind,
	uplinkHealthStateSchema,
	uplinkKindSchema,
} from "@ceraui/rpc/schemas";
import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { getCommittedModemsWireMessage } from "../modems/modem-status.ts";
import { getUplinksMessage } from "../network/uplink-health/state.ts";
import {
	type LastStartError,
	lastStartError,
} from "../streaming/last-start-error.ts";
import { latestStreamReadiness } from "../streaming/stream-readiness.ts";
import { defaultCeraUiRevisionSources } from "./revisions.ts";

export const STATUS_SCREEN_SNAPSHOT =
	"/run/ceralive/status-screen/snapshot.json";
export const STATUS_SCREEN_SCHEMA = 2;
/** The page ignores a snapshot past `expires`: this application stopped. */
export const STATUS_SCREEN_TTL_MS = 90_000;
/** Rewritten at least this often even when nothing changed. */
export const STATUS_SCREEN_REFRESH_MS = 30_000;
export const STATUS_SCREEN_TICK_MS = 2_000;
/** The page reads at most this many entries of each list, and 16 KiB in all. */
export const STATUS_SCREEN_MAX_ENTRIES = 8;
export const STATUS_SCREEN_MAX_BYTES = 16_384;

// The same checks the page applies; ASCII only.
const CODE = /^[A-Za-z0-9_]{1,48}$/;
const VERSION = /^[0-9]{1,4}(\.[0-9]{1,4}){1,3}([.+~-][0-9A-Za-z]{1,12}){0,2}$/;

export type StatusScreenSim = "present" | "absent" | "locked" | "unknown";

export interface StatusScreenSnapshot {
	readonly schema: typeof STATUS_SCREEN_SCHEMA;
	/** Unix seconds. */
	readonly expires: number;
	readonly ceraui?: string;
	readonly uplinks: readonly {
		readonly kind: UplinkKind;
		readonly state: UplinkHealthState;
	}[];
	readonly modems: readonly { readonly sim: StatusScreenSim }[];
	readonly ready?: { readonly ready: boolean; readonly code?: string };
	readonly last_error?: { readonly code: string; readonly at: number };
}

/**
 * A modem row as the backend publishes it. Only `sim_presence`,
 * `sim_lock.required` and `device_class` are read; everything else is ignored.
 */
export type StatusScreenModemRow = object;

function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)[key]
		: undefined;
}

export interface StatusScreenInputs {
	/** Unix milliseconds. */
	readonly now: number;
	readonly version: string | undefined;
	readonly readiness: StreamReadiness | undefined;
	readonly uplinks: readonly UplinkHealthRecord[];
	readonly modems: Readonly<Record<string, StatusScreenModemRow>>;
	readonly lastError: LastStartError | undefined;
}

function code(value: unknown): string | undefined {
	return typeof value === "string" && CODE.test(value) ? value : undefined;
}

const LOCKED = new Set(["sim-pin", "sim-puk", "sim-puk2"]);

function simState(row: StatusScreenModemRow): StatusScreenSim {
	if (LOCKED.has(String(field(field(row, "sim_lock"), "required"))))
		return "locked";
	const presence = field(row, "sim_presence");
	return presence === "present" || presence === "absent" ? presence : "unknown";
}

const byNumber = (a: string, b: string) =>
	a.localeCompare(b, "en", { numeric: true });

/**
 * Pure: picks the allowlisted facts and nothing else. Each value is rebuilt
 * from an enum or a checked token, never copied as a whole object.
 */
export function buildStatusScreenSnapshot(
	inputs: StatusScreenInputs,
): StatusScreenSnapshot {
	const uplinks = [...inputs.uplinks]
		.sort((a, b) => byNumber(a.iface, b.iface))
		.flatMap((record) => {
			const kind = uplinkKindSchema.safeParse(record.kind);
			const state = uplinkHealthStateSchema.safeParse(record.state);
			return kind.success && state.success
				? [{ kind: kind.data, state: state.data }]
				: [];
		})
		.slice(0, STATUS_SCREEN_MAX_ENTRIES);
	// Router-mode dongles show no SIM to this box; they appear as uplinks.
	const modems = Object.keys(inputs.modems)
		.sort(byNumber)
		.map((id) => inputs.modems[id])
		.filter(
			(row): row is StatusScreenModemRow =>
				typeof row === "object" &&
				row !== null &&
				field(row, "device_class") !== "router-ethernet",
		)
		.map((row) => ({ sim: simState(row) }))
		.slice(0, STATUS_SCREEN_MAX_ENTRIES);
	const version =
		typeof inputs.version === "string" && VERSION.test(inputs.version)
			? inputs.version
			: undefined;
	const readiness = inputs.readiness;
	const reason = code(readiness?.reason?.code);
	const lastCode = code(inputs.lastError?.code);
	return {
		schema: STATUS_SCREEN_SCHEMA,
		expires: Math.floor((inputs.now + STATUS_SCREEN_TTL_MS) / 1000),
		...(version === undefined ? {} : { ceraui: version }),
		uplinks,
		modems,
		...(typeof readiness?.ready === "boolean"
			? {
					ready: {
						ready: readiness.ready,
						...(reason === undefined ? {} : { code: reason }),
					},
				}
			: {}),
		...(lastCode === undefined || inputs.lastError === undefined
			? {}
			: {
					last_error: {
						code: lastCode,
						at: Math.floor(inputs.lastError.at / 1000),
					},
				}),
	};
}

/**
 * Atomic replace in a directory only this process's user may write; refuses a
 * symlinked or shared directory rather than writing through it.
 */
export function writeStatusScreenSnapshot(
	snapshot: StatusScreenSnapshot,
	file = STATUS_SCREEN_SNAPSHOT,
): void {
	const body = JSON.stringify(snapshot);
	if (Buffer.byteLength(body) > STATUS_SCREEN_MAX_BYTES)
		throw new Error("status screen snapshot is too large");
	const directory = dirname(file);
	mkdirSync(directory, { recursive: true, mode: 0o755 });
	const info = lstatSync(directory);
	if (
		!info.isDirectory() ||
		info.uid !== process.getuid?.() ||
		(info.mode & 0o022) !== 0
	)
		throw new Error(
			"status screen directory must be owned and private to write",
		);
	writeFileAtomicSync(file, body, { mode: 0o644, durable: false });
}

// ─── Writer loop ─────────────────────────────────────────────────────────────

export interface StatusScreenDeps {
	readonly now: () => number;
	readonly version: () => string | undefined;
	readonly readiness: () => StreamReadiness | undefined;
	readonly uplinks: () => readonly UplinkHealthRecord[];
	readonly modems: () => Readonly<Record<string, StatusScreenModemRow>>;
	readonly lastError: () => LastStartError | undefined;
	readonly write: (snapshot: StatusScreenSnapshot) => void;
}

let version: string | undefined;

const defaultDeps: StatusScreenDeps = {
	now: Date.now,
	version: () => version,
	readiness: latestStreamReadiness,
	uplinks: getUplinksMessage,
	modems: getCommittedModemsWireMessage,
	lastError: lastStartError,
	write: (snapshot) => writeStatusScreenSnapshot(snapshot),
};

let deps: StatusScreenDeps = defaultDeps;
let lastContent: string | undefined;
let lastWrittenAt = 0;
let lastFailure: string | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

export function setStatusScreenDepsForTest(
	next: Partial<StatusScreenDeps> | null,
): void {
	deps = next === null ? defaultDeps : { ...defaultDeps, ...next };
}

/** Write when the content changed or the last write is due for refresh. */
export function tickStatusScreenSnapshot(): boolean {
	const now = deps.now();
	const snapshot = buildStatusScreenSnapshot({
		now,
		version: deps.version(),
		readiness: deps.readiness(),
		uplinks: deps.uplinks(),
		modems: deps.modems(),
		lastError: deps.lastError(),
	});
	const { expires: _expires, ...rest } = snapshot;
	const content = JSON.stringify(rest);
	if (content === lastContent && now - lastWrittenAt < STATUS_SCREEN_REFRESH_MS)
		return false;
	try {
		deps.write(snapshot);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message !== lastFailure)
			logger.warn("status screen snapshot not written", { error: message });
		lastFailure = message;
		return false;
	}
	lastFailure = undefined;
	lastContent = content;
	lastWrittenAt = now;
	return true;
}

export async function initStatusScreenSnapshot(): Promise<void> {
	if (timer !== undefined || shouldUseMocks()) return;
	version = (await defaultCeraUiRevisionSources.readVersionStamp())?.trim();
	timer = setInterval(() => {
		try {
			tickStatusScreenSnapshot();
		} catch (error) {
			logger.warn("status screen snapshot failed", { error });
		}
	}, STATUS_SCREEN_TICK_MS);
	timer.unref?.();
}

export function resetStatusScreenForTest(): void {
	if (timer !== undefined) clearInterval(timer);
	timer = undefined;
	deps = defaultDeps;
	lastContent = undefined;
	lastWrittenAt = 0;
	lastFailure = undefined;
	version = undefined;
}
