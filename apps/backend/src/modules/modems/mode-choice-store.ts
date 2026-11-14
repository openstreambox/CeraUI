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
 * The saved mode choice and the bounded trial history, one private file per
 * modem identity tag (see `mode-choice-identity.ts`).
 *
 * Bounded on three axes, because the evaluator runs every status poll:
 * - an evaluator record is stored only when its verdict or reasons change, so an
 *   unchanged "would not try" costs no write at all;
 * - each source has its own cap, so evaluator records can never evict the
 *   streamer's own manual changes;
 * - the wire carries at most the newest {@link MODE_HISTORY_WIRE_LIMIT} records.
 */

import {
	closeSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	type FiveGPreference,
	fiveGPreferenceSchema,
	MODE_HISTORY_WIRE_LIMIT,
	type ModeTrialRecord,
	modeTrialRecordSchema,
} from "@ceraui/rpc/schemas";
import { z } from "zod";
import { isModemIdentityTag } from "./mode-choice-identity.ts";
import {
	ensurePrivateModeChoiceDir,
	modeChoiceDir,
} from "./mode-choice-key.ts";

export const MODE_HISTORY_CAP_PER_SOURCE = 50;
export { MODE_HISTORY_WIRE_LIMIT };

const MAX_AGE_MS = 30 * 86_400_000;

const stateSchema = z.object({
	version: z.literal(1),
	lock: fiveGPreferenceSchema.optional(),
	history: z.array(modeTrialRecordSchema),
});
export type ModeChoiceState = z.infer<typeof stateSchema>;

const EMPTY: ModeChoiceState = Object.freeze({
	version: 1,
	history: [],
}) as ModeChoiceState;

function path(tag: string): string {
	if (!isModemIdentityTag(tag)) throw new Error("invalid mode-choice tag");
	return join(modeChoiceDir(), `${tag}.json`);
}

/** Read-through cache: the wire reads this on every status broadcast. */
const cache = new Map<string, ModeChoiceState>();

type WriteFault = (() => void) | undefined;
let writeFault: WriteFault;

/** Tests only: make the next writes throw, as a full or read-only disk would. */
export function setModeChoiceWriteFault(fault: WriteFault): void {
	writeFault = fault;
}

export function resetModeChoiceStore(): void {
	cache.clear();
	writeFault = undefined;
}

export function readModeChoice(tag: string): ModeChoiceState {
	const file = path(tag);
	const hit = cache.get(file);
	if (hit !== undefined) return { ...hit, history: boundHistory(hit.history) };
	let state: ModeChoiceState;
	try {
		state = stateSchema.parse(JSON.parse(readFileSync(file, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		state = EMPTY;
	}
	cache.set(file, state);
	return { ...state, history: boundHistory(state.history) };
}

export function writeModeChoice(tag: string, state: ModeChoiceState): void {
	const file = path(tag);
	const dir = modeChoiceDir();
	const parsed = stateSchema.parse(state);
	writeFault?.();
	ensurePrivateModeChoiceDir(dir);
	const temp = `${file}.tmp`;
	const fd = openSync(temp, "w", 0o600);
	try {
		writeFileSync(fd, JSON.stringify(parsed));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temp, file);
	const parent = openSync(dir, "r");
	try {
		fsyncSync(parent);
	} finally {
		closeSync(parent);
	}
	cache.set(file, parsed);
}

/** Expire by age, then cap each source on its own. Oldest go first. */
export function boundHistory(
	history: readonly ModeTrialRecord[],
	now = Date.now(),
): ModeTrialRecord[] {
	const recent = history.filter((r) => r.at > now - MAX_AGE_MS);
	const keep = new Set<ModeTrialRecord>();
	for (const source of ["manual", "evaluator"] as const) {
		for (const r of recent
			.filter((x) => x.source === source)
			.slice(-MODE_HISTORY_CAP_PER_SOURCE))
			keep.add(r);
	}
	return recent.filter((r) => keep.has(r));
}

/**
 * Append one record. `change.lock` replaces the saved choice (`undefined`
 * clears it); without `change` the saved choice is kept.
 */
export function recordModeChoice(
	tag: string,
	record: ModeTrialRecord,
	change?: { readonly lock: FiveGPreference | undefined },
	options: { readonly replaceUnreadable?: boolean } = {},
): void {
	let state: ModeChoiceState;
	try {
		state = readModeChoice(tag);
	} catch (error) {
		// An explicit choice by the streamer outranks a file nobody can read: it
		// starts a fresh record rather than leaving every later save failing.
		if (options.replaceUnreadable !== true) throw error;
		state = EMPTY;
	}
	const lock = change === undefined ? state.lock : change.lock;
	writeModeChoice(tag, {
		version: 1,
		...(lock === undefined ? {} : { lock }),
		history: boundHistory([...state.history, record]),
	});
}

function verdictSignature(r: ModeTrialRecord): string {
	return JSON.stringify([
		r.outcome,
		r.current,
		r.target,
		r.hint ?? null,
		[...r.reasons].sort(),
	]);
}

/**
 * Store an evaluator record only when its verdict differs from the last stored
 * one. Returns whether anything was written.
 */
export function recordEvaluatorVerdict(
	tag: string,
	record: ModeTrialRecord,
): boolean {
	const last = [...readModeChoice(tag).history]
		.reverse()
		.find((r) => r.source === "evaluator");
	if (last !== undefined && verdictSignature(last) === verdictSignature(record))
		return false;
	recordModeChoice(tag, record);
	return true;
}

/** What the wire carries: the newest few, with every local tag removed. */
export function wireModeHistory(state: ModeChoiceState): ModeTrialRecord[] {
	return boundHistory(state.history)
		.sort((a, b) => a.at - b.at)
		.slice(-MODE_HISTORY_WIRE_LIMIT)
		.map((record) => ({ ...record, beforeBucket: null, afterBucket: null }));
}
