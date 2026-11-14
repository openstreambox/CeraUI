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

import { createHmac } from "node:crypto";
import { memoryAge } from "./mode-choice.ts";

/** Inputs remain local. Only keyed tags may enter the private history store. */
export interface RadioConditions {
	model: string;
	firmware: string;
	usbSpeed: "usb2" | "usb3";
	network: string;
	homeNetwork: string;
	layer: "LTE" | "NSA" | "SA";
	bands: string[];
	cell: string;
	rsrp: number;
	txDbm?: number;
	timingAdvance?: number;
	neighbours: { band: string; sending: boolean }[];
}
export function conditionTags(key: Uint8Array, c: RadioConditions) {
	if (key.length !== 32 || !Number.isFinite(c.rsrp) || !c.cell)
		throw new Error("Unavailable conditions");
	const conditions = [
		c.model,
		c.firmware,
		c.usbSpeed,
		c.network,
		c.homeNetwork,
		c.layer,
		[...c.bands].sort(),
		c.rsrp > -90 ? 0 : c.rsrp > -100 ? 1 : c.rsrp > -110 ? 2 : 3,
		c.txDbm === undefined ? "unknown" : c.txDbm < 10 ? 0 : c.txDbm < 20 ? 1 : 2,
		c.timingAdvance === undefined
			? "unknown"
			: c.timingAdvance <= 2
				? 0
				: c.timingAdvance <= 6
					? 1
					: c.timingAdvance <= 12
						? 2
						: 3,
		[...c.neighbours].sort((a, b) =>
			JSON.stringify(a).localeCompare(JSON.stringify(b)),
		),
	];
	const tag = (value: unknown) =>
		createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
	return { exact: tag([conditions, c.cell]), conditions: tag(conditions) };
}
export interface RememberedTrial {
	exact: string;
	conditions: string;
	at: number;
	mode: "auto" | "lte-only";
	invalidated: boolean;
	disturbed: boolean;
}
export function lookupModeMemory(
	entries: RememberedTrial[],
	tags: ReturnType<typeof conditionTags>,
	now: number,
	enteredBucketAt: number,
	invalidated = false,
) {
	const matches = entries
		.filter(
			(e) =>
				e.conditions === tags.conditions &&
				!e.invalidated &&
				!e.disturbed &&
				memoryAge((now - e.at) / 1000, false, invalidated) !== "gone",
		)
		.sort((a, b) => b.at - a.at);
	const match = matches.find((e) => e.exact === tags.exact) ?? matches[0];
	if (!match) return { state: "gone" as const };
	const state = memoryAge(
		(now - match.at) / 1000,
		match.exact === tags.exact && enteredBucketAt <= match.at,
		invalidated,
	);
	return {
		state,
		mode: state === "fresh" || state === "hint" ? match.mode : undefined,
	};
}
