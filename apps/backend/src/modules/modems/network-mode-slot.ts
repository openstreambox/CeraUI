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
 * One radio-mode write at a time, across every modem and every caller.
 *
 * Callers take the slot BEFORE they arm a journal entry or change anything, so a
 * busy slot is an honest "another mode change is running" refusal and never a
 * write that failed half-way. The 5G/LTE choice and the modem-settings save
 * refuse when it is held; a crash-journal rollback waits for it instead, because
 * refusing a restore would leave the device blocked.
 */

let held = false;
const waiters: Array<() => void> = [];

function release(): void {
	const next = waiters.shift();
	if (next) next();
	else held = false;
}

/** The release function, or `undefined` when another mode write holds the slot. */
export function tryClaimNetworkModeWrite(): (() => void) | undefined {
	if (held) return undefined;
	held = true;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		release();
	};
}

/** Run `fn` once the slot is free. Used by restores, which must not be refused. */
export async function withNetworkModeWrite<T>(
	fn: () => Promise<T>,
): Promise<T> {
	if (held) {
		await new Promise<void>((resolve) => waiters.push(resolve));
	} else {
		held = true;
	}
	try {
		return await fn();
	} finally {
		release();
	}
}

export function isNetworkModeWriteBusy(): boolean {
	return held;
}

/** Tests only. */
export function resetNetworkModeSlot(): void {
	held = false;
	waiters.length = 0;
}
