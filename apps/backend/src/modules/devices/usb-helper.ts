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
 * Read-only helper facts for Network › Devices.
 *
 * J11 comes from the Type-C sysfs port (power role, data role, whether a
 * partner directory exists, and the vbus5v0_typec regulator). The port-fix
 * line is the /run marker and the re-arm count, classified, never the
 * journal text. The RM520 line is the oneshot's /run marker: stored "20"
 * or the outcome token. Marker JSON may carry a unit id, a model string
 * and the previous speed; none of that is copied.
 *
 * image #61's save_marker stores phase, time, and the caller's fields. The
 * verified line is save_marker(port, phase, **base, speed=speed,
 * returned_as=pick). base is model, revision, speed_before, unit, and
 * port_paths. returned_as and the filename are kernel addresses such as
 * "1-1". unit is a hash of the IMEI, not a USB serial. The marker has no
 * boot id, busnum, or devnum, so a later device at that address would
 * inherit the hold. Every boot record stays unassigned. A follow-up on #61
 * could record the USB serial, or busnum and devnum with the boot id. The
 * writer is not changed here.
 *
 * This module never writes sysfs or /run, and it never opens a partner
 * directory or a journal.
 */

import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
	USB_HELPER_DATA_ROLES,
	USB_HELPER_HOLD_OUTCOMES,
	USB_HELPER_POWER_ROLES,
	USB_HELPER_REPROBE_OUTCOMES,
	USB_HELPER_STORED_PHASES,
	type UsbHelperHold,
	type UsbHelperReprobe,
	type UsbHelperWire,
	usbHelperSchema,
} from "@ceraui/rpc/schemas";

import type { UsbTreeBoard } from "./usb-tree.ts";

const ROLE = /\[(source|sink|host|device|dual)\]/;
const REPROBE =
	/^(recovered|no-partner|skipped|failed-unbind|failed-bind|attempted|port-missing)(?: ([0-9]{10}))?$/;
const PORT_FILE = /^[0-9]+-[0-9]+(?:\.[0-9]+)*\.json$/;
const REGULATOR = /^regulator\.\d+$/;
const VBUS_NAME = "vbus5v0_typec";

const HOLD_OUTCOMES = new Set<string>(USB_HELPER_HOLD_OUTCOMES);
const STORED_PHASES = new Set<string>(USB_HELPER_STORED_PHASES);
const POWER_ROLES = new Set<string>(USB_HELPER_POWER_ROLES);
const DATA_ROLES = new Set<string>(USB_HELPER_DATA_ROLES);
const REPROBE_OUTCOMES = new Set<string>(USB_HELPER_REPROBE_OUTCOMES);

function isReprobe(value: string): value is UsbHelperReprobe["outcome"] {
	return REPROBE_OUTCOMES.has(value);
}

const EMPTY: UsbHelperWire = { typec: null, reprobe: null, holds: [] };

export type UsbHelperTrace = (event: {
	readonly op: "open" | "readdir" | "stat";
	readonly path: string;
}) => void;

export type ReadUsbHelperOptions = {
	/** Directory that contains `sys/` and `run/`. `/` on a device. */
	readonly root: string;
	/** J11 is the ROCK 5B+ USB-C socket. Other boards do not get that read. */
	readonly board?: UsbTreeBoard;
	/**
	 * Accepted and ignored. A kernel address is not a device instance, and
	 * the marker does not record one.
	 */
	readonly kernelKeys?: ReadonlyMap<string, string>;
	/** Test hook. Production does not pass one. */
	readonly trace?: UsbHelperTrace;
};

/** The development fixture. The design RM520 row is the one hold. The reader never sets a row key. */
export function mockUsbHelper(): UsbHelperWire {
	return usbHelperSchema.parse({
		typec: {
			powerRole: "source",
			dataRole: "host",
			partner: true,
			vbus: "on",
		},
		reprobe: { outcome: "recovered", rearm: 2 },
		holds: [
			{
				key: "fc400000.usb:usb2:1.1",
				stored: "20",
				outcome: "verified",
			},
		],
	});
}

/** Allowlisted reads only. A missing file is an absent fact, not an error. */
export async function readUsbHelper(
	options: ReadUsbHelperOptions,
): Promise<UsbHelperWire> {
	try {
		const typec =
			options.board === "rock-5b-plus"
				? await readTypec(options.root, options.trace)
				: null;
		const reprobe = await readReprobe(options.root, options.trace);
		const holds = await readHolds(options.root, options.trace);
		return usbHelperSchema.parse({ typec, reprobe, holds });
	} catch {
		return EMPTY;
	}
}

async function readTypec(
	root: string,
	trace?: UsbHelperTrace,
): Promise<UsbHelperWire["typec"]> {
	const port = join(root, "sys/class/typec/port0");
	if (!(await exists(port, trace))) return null;
	const power = await readCapped(join(port, "power_role"), 80, trace);
	const data = await readCapped(join(port, "data_role"), 80, trace);
	if (power === null && data === null) return null;
	return {
		powerRole: role(power, POWER_ROLES, "unknown"),
		dataRole: role(data, DATA_ROLES, "unknown"),
		partner: await exists(join(root, "sys/class/typec/port0-partner"), trace),
		vbus: await readVbus(root, trace),
	};
}

function role<T extends string>(
	raw: string | null,
	allowed: ReadonlySet<string>,
	fallback: T,
): T {
	if (raw === null) return fallback;
	const bracket = ROLE.exec(raw);
	const token = bracket?.[1] ?? raw.trim();
	if (allowed.has(token)) return token as T;
	return fallback;
}

async function readVbus(
	root: string,
	trace?: UsbHelperTrace,
): Promise<"on" | "off" | "unknown"> {
	const dir = join(root, "sys/class/regulator");
	let entries: string[] = [];
	try {
		trace?.({ op: "readdir", path: dir });
		entries = await readdir(dir);
	} catch {
		return "unknown";
	}
	for (const name of entries
		.filter((item) => REGULATOR.test(item))
		.slice(0, 64)) {
		const label = await readCapped(join(dir, name, "name"), 64, trace);
		if (label?.trim() !== VBUS_NAME) continue;
		const state = (
			await readCapped(join(dir, name, "state"), 32, trace)
		)?.trim();
		if (state === "enabled") return "on";
		if (state === "disabled") return "off";
		return "unknown";
	}
	return "unknown";
}

async function readReprobe(
	root: string,
	trace?: UsbHelperTrace,
): Promise<UsbHelperWire["reprobe"]> {
	const raw = await readRegular(
		join(root, "run/ceralive-typec/reprobe"),
		80,
		trace,
	);
	const match = raw === null ? null : REPROBE.exec(raw.trim());
	if (match === null) return null;
	const outcome = match[1];
	if (outcome === undefined || !isReprobe(outcome)) return null;
	const rearmRaw = await readRegular(
		join(root, "run/ceralive-typec/rearm"),
		8,
		trace,
	);
	const rearmText = rearmRaw?.trim();
	const rearm =
		rearmText === "1" || rearmText === "2" || rearmText === "3"
			? (Number(rearmText) as 1 | 2 | 3)
			: null;
	return { outcome, rearm };
}

async function readHolds(
	root: string,
	trace?: UsbHelperTrace,
): Promise<UsbHelperHold[]> {
	const dir = join(root, "run/ceralive/modem-usbspeed");
	let entries: string[] = [];
	try {
		trace?.({ op: "readdir", path: dir });
		entries = (await readdir(dir))
			.filter((name) => PORT_FILE.test(name))
			.sort();
	} catch {
		return [];
	}
	const holds: UsbHelperHold[] = [];
	for (const name of entries.slice(0, 8)) {
		const text = await readRegular(join(dir, name), 4096, trace);
		if (text === null) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			continue;
		}
		const hold = holdFrom(parsed);
		if (hold !== null) holds.push(hold);
	}
	return holds;
}

/**
 * Every boot record stays unassigned. returned_as is only the kernel address
 * the writer saw, and a different device can sit there later.
 */
function holdFrom(raw: unknown): UsbHelperHold | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		return null;
	const phase = "phase" in raw ? raw.phase : undefined;
	if (typeof phase !== "string" || !HOLD_OUTCOMES.has(phase)) return null;
	const original = "original" in raw ? raw.original : undefined;
	const stored = original === "20" || STORED_PHASES.has(phase) ? "20" : null;
	return { key: null, stored, outcome: phase as UsbHelperHold["outcome"] };
}

async function exists(path: string, trace?: UsbHelperTrace): Promise<boolean> {
	try {
		trace?.({ op: "stat", path });
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** Runtime markers must be real files. A symlink or a FIFO is not a record. */
async function readRegular(
	path: string,
	max: number,
	trace?: UsbHelperTrace,
): Promise<string | null> {
	try {
		trace?.({ op: "stat", path });
		const info = await lstat(path);
		if (!info.isFile()) return null;
		trace?.({ op: "open", path });
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const buf = Buffer.alloc(max + 1);
			const { bytesRead } = await handle.read(buf, 0, max + 1, 0);
			if (bytesRead > max) return null;
			return buf.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
}

/** A longer file is refused whole, so a planted dump cannot ride along. */
async function readCapped(
	path: string,
	max: number,
	trace?: UsbHelperTrace,
): Promise<string | null> {
	try {
		trace?.({ op: "open", path });
		const handle = await open(path, "r");
		try {
			const buf = Buffer.alloc(max + 1);
			const { bytesRead } = await handle.read(buf, 0, max + 1, 0);
			if (bytesRead > max) return null;
			return buf.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
}
