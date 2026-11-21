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
 * Milliseconds since boot (CLOCK_BOOTTIME, through `/proc/uptime`), the same
 * in every process of one boot. Bun's `process.hrtime` starts at the process,
 * and wall time steps when NTP syncs, so neither can carry a deadline across a
 * backend restart. It is read on every call (10 ms resolution): mixing one
 * sample with this process's monotonic clock would drift by any suspend time
 * between processes. A failed read returns undefined, every time, and is
 * never replaced by another clock; callers then write no stamp.
 */
export function createBootClock(
	readUptime: () => string = () => readFileSync("/proc/uptime", "ascii"),
): () => number | undefined {
	return () => {
		try {
			const seconds = Number.parseFloat(readUptime().split(/\s+/)[0] ?? "");
			return Number.isFinite(seconds) && seconds >= 0
				? Math.round(seconds * 1000)
				: undefined;
		} catch {
			return undefined;
		}
	};
}

/** This process's boot clock: socket open stamps and the network-change owner share it. */
export const bootClock = createBootClock();
