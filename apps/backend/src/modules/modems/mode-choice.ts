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

/** Pure, deliberately write-free. Missing evidence is never permission. Ages are seconds. */
export type MemoryAge = "fresh" | "hint" | "history" | "gone";
export function memoryAge(
	age: number,
	continuouslyInBucket: boolean,
	invalidated: boolean,
): MemoryAge {
	if (invalidated || !Number.isFinite(age) || age < 0 || age >= 30 * 86400)
		return "gone";
	if (age < 1800 && continuouslyInBucket) return "fresh";
	return age < 7 * 86400 ? "hint" : "history";
}
export interface OtherLink {
	ready: boolean;
	load?: number;
	cleanPeak?: number;
	peakAge?: number;
	rttP95?: number;
	nakRising?: boolean;
}
export function passiveTrialHint(i: {
	nrSinr?: number;
	txDbm?: number;
	belowShare?: boolean;
	newBucket?: boolean;
	storedAlternative?: boolean;
}): string | undefined {
	if (i.storedAlternative === true) return "stored-alternative";
	if (i.nrSinr !== undefined && Number.isFinite(i.nrSinr) && i.nrSinr < 0)
		return "negative-nr-sinr";
	if (i.txDbm !== undefined && Number.isFinite(i.txDbm) && i.txDbm >= 20)
		return "high-tx-power";
	if (i.belowShare === true) return "below-share";
	if (i.newBucket === true) return "new-bucket";
	return undefined;
}
export interface TrialInputs {
	currentMode?:
		| "auto"
		| "lte-only"
		| "prefer-5g"
		| "prefer-4g"
		| "5g-only"
		| "5g-off"
		| undefined;
	now: number;
	window: "covered" | "preflight" | "idle";
	capable?: boolean;
	locked?: boolean;
	privacy?: boolean;
	brb?: boolean;
	countdown?: boolean;
	hold?: boolean;
	recovery?: boolean;
	handover?: boolean;
	otherAction?: boolean;
	viewerAffected?: boolean;
	littleToGain?: boolean;
	dataAvailable?: boolean;
	idlePermission?: boolean;
	handoverAge?: number;
	publicAge?: number;
	endIn?: number;
	movingKmh?: number;
	changesPerMinute?: number;
	bucketStableSeconds?: number;
	bucket?: string;
	memory?: MemoryAge;
	hint?: string;
	trialAges?: number[];
	boxOutSeconds?: number;
	streamTrialAges?: number[];
	streamAge?: number;
	candidateShare?: number;
	steadySeconds?: number;
	latencyBudget?: number;
	others?: OtherLink[];
}
export function decideModeTrial(i: TrialInputs) {
	const reasons: string[] = [];
	if (i.currentMode === undefined) reasons.push("unavailable:current-mode");
	const numericKeys = [
		"now",
		"handoverAge",
		"publicAge",
		"endIn",
		"movingKmh",
		"changesPerMinute",
		"bucketStableSeconds",
		"boxOutSeconds",
		"streamAge",
		"candidateShare",
		"steadySeconds",
		"latencyBudget",
	] as const;
	for (const key of numericKeys) {
		const value = i[key];
		if (value !== undefined && (!Number.isFinite(value) || value < 0))
			reasons.push(`invalid:${key}`);
	}
	for (const ages of [i.trialAges, i.streamTrialAges])
		if (ages?.some((age) => !Number.isFinite(age) || age < 0))
			reasons.push("invalid:trial-age");
	for (const link of i.others ?? [])
		for (const value of [link.load, link.cleanPeak, link.peakAge, link.rttP95])
			if (value !== undefined && (!Number.isFinite(value) || value < 0))
				reasons.push("invalid:other-link");

	const needFalse = [
		"locked",
		"privacy",
		"brb",
		"countdown",
		"hold",
		"recovery",
		"handover",
		"otherAction",
		"viewerAffected",
		"littleToGain",
	] as const;
	for (const key of needFalse)
		if (i[key] !== false)
			reasons.push(i[key] === undefined ? `unavailable:${key}` : key);
	for (const key of ["capable", "dataAvailable"] as const)
		if (i[key] !== true)
			reasons.push(i[key] === undefined ? `unavailable:${key}` : key);
	const min = (key: keyof TrialInputs, n: number) => {
		const value = i[key];
		if (typeof value !== "number" || !Number.isFinite(value))
			reasons.push(`unavailable:${key}`);
		else if (value < n) reasons.push(String(key));
	};
	min("bucketStableSeconds", 60);
	min("handoverAge", 60);
	for (const [key, limit] of [
		["movingKmh", 25],
		["changesPerMinute", 2],
	] as const) {
		const value = i[key];
		if (value === undefined || !Number.isFinite(value))
			reasons.push(`unavailable:${key}`);
		else if (key === "movingKmh" ? value > limit : value >= limit)
			reasons.push(key);
	}
	if (!i.bucket) reasons.push("unavailable:bucket");
	if (i.memory === undefined) reasons.push("unavailable:memory");
	if (i.memory === "fresh") reasons.push("fresh-memory");
	if (!i.hint) reasons.push("no-hint");
	if (!i.trialAges) reasons.push("unavailable:trial-budget");
	else if (
		i.trialAges.some((age) => age < 900) ||
		i.trialAges.filter((age) => age < 3600).length >= 2
	)
		reasons.push("modem-budget");
	if (i.boxOutSeconds === undefined) reasons.push("unavailable:box-budget");
	else if (i.boxOutSeconds + 55 > 180) reasons.push("box-budget");
	if (i.window === "idle" && i.idlePermission !== true)
		reasons.push("idle-permission");
	const covered = {
		share: i.candidateShare ?? null,
		others: i.others ?? null,
		requiredRoom: null as number | null,
		measuredRoom: null as number | null,
	};
	if (i.window === "covered") {
		min("publicAge", 120);
		min("endIn", 60);
		min("steadySeconds", 120);
		if (i.streamAge === undefined || i.streamTrialAges === undefined)
			reasons.push("unavailable:stream-budget");
		else if (
			i.streamAge < 7200
				? i.streamTrialAges.length >= 6
				: i.streamTrialAges.filter((age) => age < 3600).length >= 2
		)
			reasons.push("stream-budget");
		if (
			!i.others ||
			i.candidateShare === undefined ||
			i.latencyBudget === undefined
		)
			reasons.push("unavailable:headroom");
		else {
			const links = i.others.filter((l) => l.ready);
			if (!links.length) reasons.push("only-link");
			covered.requiredRoom = (links.length === 1 ? 2 : 1.5) * i.candidateShare;
			let room = 0;
			for (const l of links) {
				if (
					l.load === undefined ||
					l.cleanPeak === undefined ||
					l.peakAge === undefined ||
					l.peakAge > 1800 ||
					l.cleanPeak <= l.load
				)
					reasons.push("unknown-room");
				else room += l.cleanPeak - l.load;
				if (
					l.rttP95 === undefined ||
					l.rttP95 >= 0.7 * i.latencyBudget ||
					l.nakRising !== false
				)
					reasons.push("other-link-health");
			}
			covered.measuredRoom = room;
			if (room < covered.requiredRoom) reasons.push("insufficient-room");
		}
	}
	return {
		wouldTry: reasons.length === 0,
		target:
			i.currentMode === undefined
				? null
				: i.currentMode === "lte-only" || i.currentMode === "5g-off"
					? ("auto" as const)
					: ("lte-only" as const),
		automaticWrite: false as const,
		reasons,
		hint: i.hint ?? null,
		covered,
		estimatedLinkOutSeconds: i.capable === true ? 55 : null,
	};
}
