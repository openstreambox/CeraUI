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
 * Start the image's own helper units. The argv is an allowlist: the Type-C
 * recheck oneshot, or one modem USB 2 instance whose name is a kernel port.
 * This file does not talk to ModemManager. The USB 2 unit does that itself.
 */

import { spawnWithTimeout } from "../../helpers/spawn-policy.ts";

const TYPEC_UNIT = "ceralive-typec-recheck.service";
const USB2_UNIT =
	/^ceralive-modem-usbspeed@[0-9]+-[0-9]+(?:\.[0-9]+)*\.service$/;

const TYPEC_TIMEOUT_MS = 70_000;
const USB2_TIMEOUT_MS = 310_000;

/** Argv for an allowlisted unit, or null when the name is not one of ours. */
export function helperUnitArgv(unit: string): readonly string[] | null {
	if (unit !== TYPEC_UNIT && !USB2_UNIT.test(unit)) return null;
	return ["systemctl", "start", unit];
}

/** `systemctl start` of one allowlisted unit. The oneshot's own timeout applies. */
export async function startHelperUnit(unit: string): Promise<void> {
	const argv = helperUnitArgv(unit);
	if (argv === null) {
		throw new Error("helper unit is not allowlisted");
	}
	const timeoutMs = unit === TYPEC_UNIT ? TYPEC_TIMEOUT_MS : USB2_TIMEOUT_MS;
	const result = await spawnWithTimeout([...argv], { timeoutMs });
	if (result.exitCode !== 0) {
		throw new Error("helper unit failed");
	}
}
