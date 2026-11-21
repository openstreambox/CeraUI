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

import { logger } from "../../helpers/logger.ts";
import { readFiveGPreference } from "./five-g-preference.ts";
import { decideModeTrial } from "./mode-choice.ts";
import { modemIdentityTagForId } from "./mode-choice-identity.ts";
import { isModeLocked } from "./mode-choice-saved.ts";
import { readModeChoice, recordEvaluatorVerdict } from "./mode-choice-store.ts";
import { getModems } from "./modems-state.ts";

/** Evaluate at most once a minute per modem. In memory: no file read per tick. */
const lastEvaluatedAt = new Map<string, number>();

/**
 * Log-only. This module has no writer dependency, and the current branch lacks
 * radio buckets and measured clean peaks, so every verdict is "would not try".
 * A verdict is stored only when it differs from the last stored one.
 */
export function recordModeEvaluations(now = Date.now()) {
	for (const [id, modem] of Object.entries(getModems())) {
		const tag = modemIdentityTagForId(Number(id));
		if (!tag) continue;
		const last = lastEvaluatedAt.get(tag);
		if (last !== undefined && now - last < 60_000 && now >= last) continue;
		lastEvaluatedAt.set(tag, now);
		try {
			const state = readModeChoice(tag);
			const current = readFiveGPreference(modem.radio_modes);
			const verdict = decideModeTrial({
				now,
				window: "covered",
				currentMode: current ?? undefined,
				locked: isModeLocked(state.lock),
				capable: modem.model?.startsWith("RM520") === true,
			});
			recordEvaluatorVerdict(tag, {
				at: now,
				source: "evaluator",
				current,
				target: verdict.target,
				window: "covered",
				hint: verdict.hint,
				coverage: verdict.covered,
				beforeBucket: null,
				afterBucket: null,
				beforeDeliveredUpload: null,
				afterDeliveredUpload: null,
				outcome: "would-not-try",
				reasons: verdict.reasons,
				estimatedLinkOutSeconds: verdict.estimatedLinkOutSeconds,
			});
		} catch {
			logger.warn("Mode history unavailable", { module: "modems" });
		}
	}
}

/** Tests only. */
export function resetModeEvaluations(): void {
	lastEvaluatedAt.clear();
}
