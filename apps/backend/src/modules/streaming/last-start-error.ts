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

import type { StartResult } from "@ceraui/rpc/schemas";

/**
 * The class of the latest failed start, cleared by a start that succeeds. In
 * memory only, and never the failure message, which can carry engine or
 * destination text. Read by the status screen snapshot.
 */
export interface LastStartError {
	readonly code: string;
	/** Unix milliseconds. */
	readonly at: number;
}

let latest: LastStartError | undefined;

export function noteStartResult(result: StartResult, now = Date.now()): void {
	if (result.result === "failed")
		latest = { code: result.failure.class, at: now };
	else if (result.result === "started") latest = undefined;
}

export function lastStartError(): LastStartError | undefined {
	return latest;
}

export function resetLastStartErrorForTest(): void {
	latest = undefined;
}
