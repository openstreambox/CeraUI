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

import { readFileSync } from "node:fs";

/**
 * Milliseconds since boot (CLOCK_BOOTTIME), the same in every process of one
 * boot. Bun's `process.hrtime` starts at the process, and wall time steps when
 * NTP syncs, so neither can carry a deadline across a backend restart.
 * `/proc/uptime` is read once (10 ms resolution) and advanced with this
 * process's monotonic clock. Where it can't be read (not Linux), it returns
 * undefined and callers fall back to wall time.
 */
export function createBootClock(
	readUptime: () => string = () => readFileSync("/proc/uptime", "ascii"),
	monotonic: () => number = () => performance.now(),
): () => number | undefined {
	let offset: number | null | undefined;
	return () => {
		if (offset === undefined) {
			try {
				const seconds = Number.parseFloat(readUptime().split(/\s+/)[0] ?? "");
				offset =
					Number.isFinite(seconds) && seconds >= 0
						? seconds * 1000 - monotonic()
						: null;
			} catch {
				offset = null;
			}
		}
		return offset === null ? undefined : offset + monotonic();
	};
}

/** This process's boot clock: socket open stamps and the network-change owner share it. */
export const bootClock = createBootClock();
