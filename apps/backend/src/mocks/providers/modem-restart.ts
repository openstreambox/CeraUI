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
 * wait-by-port) with only the device replaced. A "reset" takes the modem out of
 * the mocked ModemManager list for {@link MOCK_RESTART_OUT_MS} and then lists it
 * again under a NEW index, on the same USB port and interface, which is what a
 * board does. The restart's own roster refresh (one discovery per poll) picks
 * that up, so the published row goes away and a new one replaces it whatever
 * the phase of the 30 s status poll. Nothing is written
 * anywhere.
 */
import type { ModemRestartDeps } from "../../modules/modems/modem-restart.ts";

export const MOCK_RESTART_OUT_MS = 6_000;

/** base (scenario) index -> the index it is listed under after a restart. */
const renumbered = new Map<number, number>();
/** base index -> until when it is missing from the list. */
const hiddenUntil = new Map<number, number>();
let nextIndex = 100;

/** The scenario modem behind a listed index, or -1 for an index that no longer exists. */
export function mockBaseModemId(listed: number): number {
	for (const [base, index] of renumbered) if (index === listed) return base;
	return renumbered.has(listed) ? -1 : listed;
}

/** The index a scenario modem is listed under right now. */
export function mockListedModemId(base: number): number {
	return renumbered.get(base) ?? base;
}

/** Whether a scenario modem is out of the list right now. */
export function mockModemHidden(base: number, now = Date.now()): boolean {
	const until = hiddenUntil.get(base);
	return until !== undefined && now < until;
}

export function mockRestartModem(listed: number, now = Date.now()): void {
	const base = mockBaseModemId(listed);
	if (base < 0) return;
	hiddenUntil.set(base, now + MOCK_RESTART_OUT_MS);
	renumbered.set(base, nextIndex);
	nextIndex += 1;
}

export function resetMockModemRestarts(): void {
	renumbered.clear();
	hiddenUntil.clear();
	nextIndex = 100;
}

export function mockModemRestartDeps(): Partial<ModemRestartDeps> {
	return {
		mmReset: async (id) => {
			mockRestartModem(id);
			return "accepted";
		},
		pollMs: 1_000,
	};
}
