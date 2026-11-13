/** Policy proposals live here; no hardware actions or persistence. Times are milliseconds. */
export const HEAT_SETTINGS = {
	stepOrder: [
		"idleExtras",
		"bankRest",
		"bitrateCap",
		"spareLink",
		"resolutionOffer",
	],
	automaticBitrate: true,
	capPercent: { hot: 75, critical: 50 },
	floorKbps: 2000,
	automaticSpareLink: true,
	resolutionPolicy: "offer",
	keepQualityDuration: "stream" as "stream" | "stage" | "untilOff",
	phoneChargingAdvice: true,
	thresholds: {
		soc: [70, 75, 80],
		modem: [65, 70, 75],
		pack: [50, 55, 60],
		bankA: [45, 50, 55],
		bankB: [45, 50, 55],
	} as Record<string, number[]>,
	hysteresis: { soc: 5, modem: 5, pack: 3, bankA: 5, bankB: 5 } as Record<
		string,
		number
	>,
	filterMs: 1000,
	enterMs: 10000,
	leaveMs: 60000,
	minimumHoldMs: 300000,
	undoIntervalMs: 120000,
	flapWindowMs: 1800000,
	flapCount: 3,
	staleMs: 5000,
	/** Backoff after the engine rejects a heat change. */
	retryMinMs: 5000,
	retryMaxMs: 60000,
	/** Readings outside this range are faults, not temperatures (same as the supervisor parser). */
	plausibleC: { min: -20, max: 125 },
};
/** A reading the ladder may act on: finite and inside the plausible range. */
export function plausibleTemperature(
	value: number | null | undefined,
): boolean {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= HEAT_SETTINGS.plausibleC.min &&
		value <= HEAT_SETTINGS.plausibleC.max
	);
}
/**
 * Parse a Linux thermal-zone `temp` file (millidegrees); anything else is
 * unknown. An exact 0 is the usual failed-read value of a zone, never a
 * working SoC's temperature, so it is unknown too.
 */
export function parseThermalZone(text: string): number | null {
	const trimmed = text.trim();
	if (!/^-?\d+$/.test(trimmed) || Number.parseInt(trimmed, 10) === 0)
		return null;
	const celsius = Number.parseInt(trimmed, 10) / 1000;
	return plausibleTemperature(celsius) ? celsius : null;
}
export interface HeatState {
	stage: number;
	capStage: number;
	enteredAt: number;
	candidate: number;
	candidateAt: number;
	coolAt: number | null;
	lastUndo: number;
	lastAt: number | null;
	/** Time of the last sample with every input readable. */
	knownAt: number | null;
	hotSince: Record<number, number>;
	filtered: Record<string, number>;
	entries: Record<number, number[]>;
	flap: boolean;
	keepQuality: boolean;
	unknown: boolean;
}
export function initialHeat(): HeatState {
	return {
		stage: 0,
		capStage: 0,
		enteredAt: 0,
		candidate: 0,
		candidateAt: 0,
		coolAt: null,
		lastUndo: -Infinity,
		lastAt: null,
		knownAt: null,
		hotSince: {},
		filtered: {},
		entries: {},
		flap: false,
		keepQuality: false,
		unknown: false,
	};
}
export function advanceHeat(
	previous: HeatState,
	inputs: Record<string, number | null>,
	now: number,
): HeatState {
	const p = HEAT_SETTINGS;
	const s: HeatState = {
		...previous,
		filtered: { ...previous.filtered },
		entries: { ...previous.entries },
		hotSince: { ...previous.hotSince },
	};
	const elapsed = s.knownAt === null ? 0 : now - s.knownAt;
	s.lastAt = now;
	// A gap of more than staleMs since the last readable sample is missing
	// evidence, never time spent hot or cool: the timers start over. A shorter
	// gap (one unreadable sample) only pauses them, as a late sample would.
	const gap = elapsed < 0 || elapsed > p.staleMs;
	if (gap) {
		s.candidateAt = now;
		s.coolAt = null;
		s.filtered = {};
		s.hotSince = {};
	}
	s.unknown =
		Object.values(inputs).some((t) => !plausibleTemperature(t)) ||
		!Object.keys(inputs).length;
	// Unknown never takes a step and never undoes one.
	if (s.unknown) return s;
	s.knownAt = now;
	let level = 0,
		cool = true,
		allNormal = true;
	for (const [key, raw] of Object.entries(inputs)) {
		if (raw === null) continue;
		const thresholds = p.thresholds[key];
		if (!thresholds) {
			s.unknown = true;
			return s;
		}
		const old = s.filtered[key];
		const filtered =
			old === undefined
				? raw
				: old +
					(raw - old) * (1 - Math.exp(-Math.max(0, elapsed) / p.filterMs));
		s.filtered[key] = filtered;
		let inputLevel = 0;
		for (let i = 0; i < thresholds.length; i++)
			if (filtered >= (thresholds[i] ?? Infinity)) inputLevel = i + 1;
		level = Math.max(level, inputLevel);
		const h = p.hysteresis[key] ?? 5;
		if (filtered > (thresholds[0] ?? Infinity) - h) allNormal = false;
		if (s.stage && filtered > (thresholds[s.stage - 1] ?? Infinity) - h)
			cool = false;
	}
	if (level !== s.candidate) {
		s.candidate = level;
		s.candidateAt = now;
	}
	let entering = s.stage;
	for (let i = 1; i <= 3; i++) {
		if (level >= i) s.hotSince[i] ??= now;
		else delete s.hotSince[i];
		if (level >= i && now - (s.hotSince[i] ?? now) >= p.enterMs)
			entering = Math.max(entering, i);
	}
	if (entering > s.stage) {
		s.stage = entering;
		s.capStage = Math.max(s.capStage, entering);
		s.enteredAt = now;
		s.coolAt = null;
		const entries = [
			...(s.entries[entering] ?? []).filter((t) => now - t <= p.flapWindowMs),
			now,
		];
		s.entries[entering] = entries;
		s.flap ||= entries.length >= p.flapCount;
		if (p.keepQualityDuration === "stage") s.keepQuality = false;
	}
	if (s.flap && allNormal) s.flap = false;
	if (cool) s.coolAt ??= now;
	else s.coolAt = null;
	if (
		s.stage &&
		!s.flap &&
		s.coolAt !== null &&
		now - s.coolAt >= p.leaveMs &&
		now - s.enteredAt >= p.minimumHoldMs &&
		now - s.lastUndo >= p.undoIntervalMs
	) {
		s.stage--;
		if (s.stage < 2) s.capStage = 0;
		s.lastUndo = now;
		s.coolAt = null;
		if (p.keepQualityDuration === "stage") s.keepQuality = false;
	}
	return s;
}
export function heatCeiling(s: HeatState, ownKbps: number): number {
	if (s.keepQuality || !HEAT_SETTINGS.automaticBitrate || s.stage < 2)
		return ownKbps;
	const percent =
		Math.max(s.stage, s.capStage) === 3
			? HEAT_SETTINGS.capPercent.critical
			: HEAT_SETTINGS.capPercent.hot;
	return Math.min(
		ownKbps,
		Math.max(HEAT_SETTINGS.floorKbps, Math.floor((ownKbps * percent) / 100)),
	);
}
