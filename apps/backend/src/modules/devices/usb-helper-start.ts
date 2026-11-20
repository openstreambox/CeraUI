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
 * Start the image's own helper units, and ask systemd whether that unit
 * is still active. The argv is an allowlist: the Type-C recheck oneshot,
 * or one modem USB 2 instance whose name is a kernel port.
 * This file does not talk to ModemManager. The USB 2 unit does that itself.
 * Failures thrown here never include the command or the unit name.
 */

import { spawnWithTimeout } from "../../helpers/spawn-policy.ts";

const TYPEC_UNIT = "ceralive-typec-recheck.service";
const USB2_UNIT =
	/^ceralive-modem-usbspeed@[0-9]+-[0-9]+(?:\.[0-9]+)*\.service$/;

const TYPEC_TIMEOUT_MS = 70_000;
const USB2_TIMEOUT_MS = 310_000;
const SHOW_TIMEOUT_MS = 5_000;

const BUSY_STATES = new Set(["active", "activating", "deactivating"]);
const IDLE_STATES = new Set(["inactive", "failed"]);

/** Argv for an allowlisted unit, or null when the name is not one of ours. */
export function helperUnitArgv(unit: string): readonly string[] | null {
	if (unit !== TYPEC_UNIT && !USB2_UNIT.test(unit)) return null;
	return ["systemctl", "start", unit];
}

/** Argv that reads ActiveState and Job for an allowlisted unit, or null. */
export function helperUnitShowArgv(unit: string): readonly string[] | null {
	if (helperUnitArgv(unit) === null) return null;
	return ["systemctl", "show", "-p", "ActiveState,Job", unit];
}

/**
 * Busy unless systemd reports a terminal ActiveState and an empty Job.
 * A queued job can leave ActiveState inactive. Blank or unknown output
 * stays busy so the lease is not dropped on a probe we cannot read.
 */
export function helperUnitBusyFromShow(stdout: string): boolean {
	const fields = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
	}
	if (!fields.has("ActiveState") || !fields.has("Job")) return true;
	const job = fields.get("Job") ?? "";
	if (job !== "") return true;
	const state = fields.get("ActiveState") ?? "";
	if (BUSY_STATES.has(state)) return true;
	if (IDLE_STATES.has(state)) return false;
	return true;
}

/**
 * `systemctl start` of one allowlisted unit.
 * A timeout or a non-zero exit becomes a generic error. The oneshot may
 * still be running; the caller waits on ActiveState before it drops the lease.
 */
export async function startHelperUnit(unit: string): Promise<void> {
	const argv = helperUnitArgv(unit);
	if (argv === null) {
		throw new Error("helper unit is not allowlisted");
	}
	const timeoutMs = unit === TYPEC_UNIT ? TYPEC_TIMEOUT_MS : USB2_TIMEOUT_MS;
	try {
		const result = await spawnWithTimeout([...argv], { timeoutMs });
		if (result.exitCode !== 0) {
			throw new Error("helper unit failed");
		}
	} catch (err) {
		if (
			err instanceof Error &&
			(err.message === "helper unit failed" ||
				err.message === "helper unit is not allowlisted")
		) {
			throw err;
		}
		throw new Error("helper unit failed");
	}
}

/**
 * True when the unit is busy or the state cannot be read.
 * Unknown stays busy so a lease is not dropped on a probe failure.
 * The returned boolean is the only thing callers log.
 */
export async function helperUnitIsActive(unit: string): Promise<boolean> {
	const argv = helperUnitShowArgv(unit);
	if (argv === null) return true;
	try {
		const result = await spawnWithTimeout([...argv], {
			timeoutMs: SHOW_TIMEOUT_MS,
		});
		if (result.exitCode !== 0) return true;
		return helperUnitBusyFromShow(result.stdout);
	} catch {
		return true;
	}
}
