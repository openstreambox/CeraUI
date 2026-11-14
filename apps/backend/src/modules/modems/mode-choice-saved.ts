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
 * The saved choice, seen from a live modem.
 *
 * The saved choice is an intent; the modem's live read is the truth. Every read
 * reconciles the two, and a disagreement is REPORTED (`lock_matches: false`) for
 * the streamer to act on. Nothing here writes a radio mode, and nothing re-applies
 * a saved choice by itself.
 */

import type {
	FiveGPreference,
	ModemFiveGPreference,
	ModeTrialRecord,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import {
	fiveGPreferenceToModes,
	readFiveGPreference,
	sameModePair,
} from "./five-g-preference.ts";
import { modemIdentityTagForId } from "./mode-choice-identity.ts";
import {
	type ModeChoiceState,
	readModeChoice,
	recordModeChoice,
	wireModeHistory,
} from "./mode-choice-store.ts";
import type { Modem } from "./modems-state.ts";

function manualRecord(fields: {
	current: FiveGPreference | null;
	target: FiveGPreference | null;
	reasons: string[];
	estimatedLinkOutSeconds: number | null;
}): ModeTrialRecord {
	return {
		at: Date.now(),
		source: "manual",
		window: "unavailable",
		hint: null,
		current: fields.current,
		target: fields.target,
		beforeBucket: null,
		afterBucket: null,
		beforeDeliveredUpload: null,
		afterDeliveredUpload: null,
		outcome: "applied",
		reasons: fields.reasons,
		estimatedLinkOutSeconds: fields.estimatedLinkOutSeconds,
	};
}

/** Save a confirmed manual change. `false` when it could not be saved. */
export function saveManualModeChoice(
	id: number,
	change: {
		current: FiveGPreference | null;
		target: FiveGPreference;
		estimatedLinkOutSeconds: number | null;
	},
): boolean {
	const tag = modemIdentityTagForId(id);
	if (tag === undefined) return false;
	try {
		recordModeChoice(
			tag,
			manualRecord({
				...change,
				reasons: ["unavailable:radio-bucket", "unavailable:delivered-upload"],
			}),
			{ lock: change.target },
			{ replaceUnreadable: true },
		);
		return true;
	} catch {
		logger.warn("Mode choice changed on the modem but was not saved", {
			module: "modems",
		});
		return false;
	}
}

/**
 * The modem-settings save wrote a mode: the saved choice follows it, so the two
 * controls can never disagree. A pair no posture names clears the saved choice.
 */
export function noteModeSetInModemSettings(
	id: number,
	before: FiveGPreference | null,
	after: Modem["radio_modes"],
): boolean {
	const tag = modemIdentityTagForId(id);
	if (tag === undefined) return false;
	const landed = readFiveGPreference(after);
	try {
		recordModeChoice(
			tag,
			manualRecord({
				current: before,
				target: landed,
				reasons: ["via:modem-settings"],
				estimatedLinkOutSeconds: null,
			}),
			{ lock: landed ?? undefined },
			{ replaceUnreadable: true },
		);
		return true;
	} catch {
		logger.warn("Mode set in modem settings was not saved", {
			module: "modems",
		});
		return false;
	}
}

export function readSavedModeChoice(id: number): ModeChoiceState | undefined {
	const tag = modemIdentityTagForId(id);
	if (tag === undefined) return undefined;
	try {
		return readModeChoice(tag);
	} catch {
		return undefined;
	}
}

/**
 * Whether the saved choice is what the radio reports right now. `undefined`
 * when there is nothing saved or the live read is missing.
 */
export function savedChoiceMatches(
	lock: FiveGPreference | undefined,
	radioModes: Modem["radio_modes"],
): boolean | undefined {
	if (lock === undefined || radioModes?.current === undefined) return undefined;
	return sameModePair(
		fiveGPreferenceToModes(lock, radioModes),
		radioModes.current,
	);
}

/** Only an explicit non-Automatic choice keeps the evaluator away. */
export function isModeLocked(lock: FiveGPreference | undefined): boolean {
	return lock !== undefined && lock !== "auto";
}

export function savedChoiceWireFields(
	id: number,
	radioModes: Modem["radio_modes"],
): Pick<ModemFiveGPreference, "lock" | "lock_matches" | "history"> {
	const saved = readSavedModeChoice(id);
	if (saved === undefined) return {};
	const matches = savedChoiceMatches(saved.lock, radioModes);
	return {
		...(saved.lock === undefined ? {} : { lock: saved.lock }),
		...(matches === undefined ? {} : { lock_matches: matches }),
		...(saved.history.length === 0 ? {} : { history: wireModeHistory(saved) }),
	};
}
