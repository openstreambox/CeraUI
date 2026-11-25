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

/**
 * Restart modem under `MOCK_SCENARIO`: the REAL restart flow (guards, lease,
 * wait-by-port) with the device half replaced. A "reset" hides the modem from
 * the roster for {@link MOCK_RESTART_OUT_MS} and then lists it again, connected,
 * so a dev host and the e2e suite see "Restarting…" followed by a result,
 * exactly as on a board, only faster. Nothing is written anywhere.
 */
import type { ModemRestartDeps } from "../../modules/modems/modem-restart.ts";
import { getModems, type Modem } from "../../modules/modems/modems-state.ts";

export const MOCK_RESTART_OUT_MS = 3_000;

const resetAt = new Map<number, number>();

export function mockModemRestartDeps(): Partial<ModemRestartDeps> {
	return {
		mmReset: async (id) => {
			resetAt.set(id, Date.now());
			return true;
		},
		usbRebind: async () => false,
		modems: () => {
			const visible: Record<number, Modem> = {};
			for (const [key, modem] of Object.entries(getModems())) {
				const id = Number(key);
				const at = resetAt.get(id);
				if (at !== undefined && Date.now() - at < MOCK_RESTART_OUT_MS) continue;
				visible[id] = modem;
			}
			return visible;
		},
		pollMs: 500,
	};
}
