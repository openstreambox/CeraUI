/**
 * When the searching radio should look for another access point, and which one
 * it should take. Pure functions over observations; no IO.
 *
 * Signal units differ on purpose. Fade and headroom use the holder's own link
 * signal in dBm (`iw dev <if> link`, read without scanning). Candidates are
 * compared in NetworkManager's 0-100 scan quality, because that is what the
 * searcher's own scan returns for every BSSID, the holder's current one
 * included.
 */

export type HolderHealth = Readonly<{
	/** Link signal of the holder in dBm, `null` when unknown. */
	signalDbm: number | null;
	/** Receiver-attributed payload rate on the holder's link, bits/s. */
	attributedBps: number | null;
	/** What the encoder is producing right now, bits/s. */
	encoderBps: number | null;
	/** Share of the holder's packets reported lost, 0-1. */
	nakRatio: number | null;
}>;

export type SearchPolicy = Readonly<{
	/** Proactive search cadence while the holder has headroom. */
	proactiveMs: number;
	/** Upper bound of the doubling back-off when searches find nothing. */
	maxBackoffMs: number;
	/** Minimum gap between searches while the holder fades. */
	expediteMs: number;
	/** Holder carries at least this multiple of the encoder rate: headroom. */
	headroomRatio: number;
	/** Holder carries less than this multiple of the encoder rate: fading. */
	fadeRatio: number;
	okSignalDbm: number;
	fadeSignalDbm: number;
	/** dB per second over the slope window that counts as a fade. */
	fadeSlopeDbPerS: number;
	slopeWindowMs: number;
	okNakRatio: number;
	fadeNakRatio: number;
	/** Candidate scan quality floor (0-100). */
	minCandidateQuality: number;
	/** A candidate may be at most this much weaker than the holder's BSSID. */
	candidateMargin: number;
}>;

export const DEFAULT_SEARCH_POLICY: SearchPolicy = {
	proactiveMs: 60_000,
	maxBackoffMs: 600_000,
	expediteMs: 15_000,
	headroomRatio: 1.5,
	fadeRatio: 1.2,
	okSignalDbm: -67,
	fadeSignalDbm: -70,
	fadeSlopeDbPerS: -1,
	slopeWindowMs: 10_000,
	okNakRatio: 0.02,
	fadeNakRatio: 0.05,
	minCandidateQuality: 40,
	candidateMargin: 10,
};

export type HolderCondition =
	/** Holder alone can carry the stream with margin: a search costs nothing. */
	| "headroom"
	/** Holder is losing the AP: search now, even without margin. */
	| "fade"
	/** Neither: the holder carries but has no spare capacity proven. */
	| "steady";

export type SignalSample = Readonly<{ at: number; dbm: number }>;

/** Least-squares slope of the samples inside the window, dB per second. */
export function signalSlope(
	samples: readonly SignalSample[],
	now: number,
	windowMs: number,
): number | null {
	const recent = samples.filter((s) => s.at <= now && now - s.at <= windowMs);
	if (recent.length < 3) return null;
	const span = (recent.at(-1)?.at ?? 0) - (recent[0]?.at ?? 0);
	if (span < windowMs / 2) return null;
	const mx = recent.reduce((a, s) => a + s.at, 0) / recent.length;
	const my = recent.reduce((a, s) => a + s.dbm, 0) / recent.length;
	let num = 0;
	let den = 0;
	for (const s of recent) {
		num += (s.at - mx) * (s.dbm - my);
		den += (s.at - mx) ** 2;
	}
	return den === 0 ? null : (num / den) * 1000;
}

/**
 * Classify the holder. Fade wins over headroom: any single fade signal is
 * enough, while headroom needs every known signal to agree and at least the
 * link signal to be known.
 */
export function classifyHolder(
	health: HolderHealth,
	slopeDbPerS: number | null,
	policy: SearchPolicy = DEFAULT_SEARCH_POLICY,
): HolderCondition {
	const { signalDbm, attributedBps, encoderBps, nakRatio } = health;
	const ratio =
		attributedBps !== null && encoderBps !== null && encoderBps > 0
			? attributedBps / encoderBps
			: null;
	if (
		(signalDbm !== null && signalDbm <= policy.fadeSignalDbm) ||
		(slopeDbPerS !== null && slopeDbPerS <= policy.fadeSlopeDbPerS) ||
		(ratio !== null && ratio < policy.fadeRatio) ||
		(nakRatio !== null && nakRatio > policy.fadeNakRatio)
	)
		return "fade";
	if (
		signalDbm !== null &&
		signalDbm >= policy.okSignalDbm &&
		(ratio === null || ratio >= policy.headroomRatio) &&
		(nakRatio === null || nakRatio < policy.okNakRatio)
	)
		return "headroom";
	return "steady";
}

export type SearchClock = Readonly<{
	/** When the last search started, `null` before the first. */
	lastSearchAt: number | null;
	/** Searches in a row that found no usable candidate. */
	emptySearches: number;
	/** No search before this time (failed join cooldown). */
	notBefore: number;
}>;

export const FRESH_SEARCH_CLOCK: SearchClock = {
	lastSearchAt: null,
	emptySearches: 0,
	notBefore: 0,
};

/** Interval before the next proactive search. */
export function proactiveInterval(
	clock: SearchClock,
	policy: SearchPolicy = DEFAULT_SEARCH_POLICY,
): number {
	return Math.min(
		policy.proactiveMs * 2 ** Math.min(clock.emptySearches, 20),
		policy.maxBackoffMs,
	);
}

/**
 * Whether a search is due now. A steady holder never triggers one: without
 * proven headroom, taking the searcher out of the bond to scan would put the
 * whole stream on a link that may not carry it.
 */
export function searchDue(
	now: number,
	condition: HolderCondition,
	clock: SearchClock,
	policy: SearchPolicy = DEFAULT_SEARCH_POLICY,
): boolean {
	if (now < clock.notBefore) return false;
	if (condition === "steady") return false;
	if (clock.lastSearchAt === null) return true;
	const since = now - clock.lastSearchAt;
	return condition === "fade"
		? since >= policy.expediteMs
		: since >= proactiveInterval(clock, policy);
}

/** Cooldown after a failed join: 20, 40, 80, then 120 s. */
export function joinCooldownMs(failures: number): number {
	return [20_000, 40_000, 80_000, 120_000][Math.min(failures, 4) - 1] ?? 0;
}

export type ScanRow = Readonly<{
	bssid: string;
	ssid: string;
	/** NetworkManager scan quality, 0-100. */
	quality: number;
	channel: number | null;
}>;

export const normalizeBssid = (bssid: string): string => bssid.toLowerCase();

/**
 * What a radio is for. Roles belong to radios, not to slots, so a third or
 * fourth client radio fits without changing the model.
 *
 * - holder: carries the stream and is never scanned, moved or disconnected
 *   on purpose. At least one radio holds whenever any radio is associated.
 * - assister: carries traffic in the bond but may be withdrawn from the bond
 *   (never while carrying) to search.
 * - searcher: out of the bond; may scan and join.
 * - standby: associated and verified, out of the bond (a lingering old holder
 *   or a candidate waiting for proof).
 * - hotspot-reserved: serves the phone hotspot; never touched.
 */
export type Role =
	| "holder"
	| "assister"
	| "searcher"
	| "standby"
	| "hotspot-reserved";

/**
 * How a joined path relates to the holders' paths, learned after joining.
 * One SSID can front several backends and two SSIDs can share one, so this is
 * decided from the gateway and egress, never from the name.
 */
export type Diversity =
	/** Same gateway on the same subnet, or the same egress address. */
	| "same-uplink"
	/** Different gateway or subnet; egress unknown. Probably separate. */
	| "distinct-gateway"
	/** Different egress addresses: separate uplinks. */
	| "diverse"
	| "unknown";

export type UplinkIdentity = Readonly<{
	gateway: string | null;
	/** Link-layer address of the gateway, which survives renumbering. */
	gatewayMac: string | null;
	/** Connected IPv4 subnet in CIDR form. */
	subnet: string | null;
	/** Public egress address as seen from outside, when known. */
	egress: string | null;
}>;

export function classifyUplink(
	a: UplinkIdentity,
	b: UplinkIdentity,
): Diversity {
	if (a.egress !== null && b.egress !== null)
		return a.egress === b.egress ? "same-uplink" : "diverse";
	// Two consumer routers often use the same default subnet and gateway
	// address, so when both gateway MACs are known they decide.
	if (a.gatewayMac !== null && b.gatewayMac !== null)
		return a.gatewayMac === b.gatewayMac ? "same-uplink" : "distinct-gateway";
	if (
		a.gateway !== null &&
		a.gateway === b.gateway &&
		a.subnet !== null &&
		a.subnet === b.subnet
	)
		return "same-uplink";
	if (a.gateway === null || b.gateway === null) return "unknown";
	return "distinct-gateway";
}

/** The least diverse relation a path has to any of the holders' paths. */
export function diversityAgainst(
	path: UplinkIdentity,
	holders: readonly UplinkIdentity[],
): Diversity {
	const order: Diversity[] = [
		"same-uplink",
		"unknown",
		"distinct-gateway",
		"diverse",
	];
	let worst: Diversity = "diverse";
	for (const h of holders) {
		const d = classifyUplink(path, h);
		if (order.indexOf(d) < order.indexOf(worst)) worst = d;
	}
	return holders.length === 0 ? "unknown" : worst;
}

/**
 * What a search is for.
 * - continuity: the holder fades; any usable other BSSID, strongest first.
 * - diversity: the holder is fine; prefer a path on a different uplink.
 * - capacity: assist mode; any usable BSSID, the holder's own included.
 */
export type SearchGoal = "continuity" | "diversity" | "capacity";

export type CandidateContext = Readonly<{
	goal: SearchGoal;
	/** BSSIDs the holders are on. */
	holderBssids: ReadonlySet<string>;
	/** SSIDs the holders are on: always joinable with the radio's profile. */
	holderSsids: ReadonlySet<string>;
	/** SSIDs this radio has saved, interface-bound profiles for. */
	savedSsids: ReadonlySet<string>;
	/** What earlier joins learned about each BSSID's uplink. */
	learned: ReadonlyMap<string, Diversity>;
}>;

const DIVERSITY_RANK: Record<Diversity, number> = {
	diverse: 3,
	"distinct-gateway": 2,
	unknown: 1,
	"same-uplink": 0,
};

/**
 * Pick the searcher's candidate from its own scan. Holder BSSIDs set the
 * reference quality: a candidate may be at most `candidateMargin` weaker than
 * the best of them, so a marginal AP is not taken while the current one is
 * clearly better.
 */
export function pickCandidate(
	rows: readonly ScanRow[],
	ctx: CandidateContext,
	policy: SearchPolicy = DEFAULT_SEARCH_POLICY,
): ScanRow | undefined {
	const holders = new Set([...ctx.holderBssids].map(normalizeBssid));
	const reference = rows
		.filter((r) => holders.has(normalizeBssid(r.bssid)))
		.reduce<number | null>((a, r) => Math.max(a ?? 0, r.quality), null);
	const usable = rows.filter(
		(r) =>
			r.ssid !== "" &&
			(ctx.holderSsids.has(r.ssid) || ctx.savedSsids.has(r.ssid)) &&
			r.quality >= policy.minCandidateQuality &&
			(ctx.goal === "capacity" ||
				(!holders.has(normalizeBssid(r.bssid)) &&
					(reference === null ||
						r.quality >= reference - policy.candidateMargin))),
	);
	const learned = (r: ScanRow): Diversity =>
		ctx.learned.get(normalizeBssid(r.bssid)) ?? "unknown";
	const score = (r: ScanRow): number[] => {
		const div = DIVERSITY_RANK[learned(r)];
		const fresh = holders.has(normalizeBssid(r.bssid)) ? 0 : 1;
		switch (ctx.goal) {
			case "continuity":
				return [r.quality, div];
			case "diversity":
				// A BSSID already known to share the holder's uplink adds nothing.
				return learned(r) === "same-uplink" ? [-1] : [div, r.quality];
			case "capacity":
				return [fresh * div, r.quality];
		}
	};
	const better = (x: number[], y: number[]) => {
		for (let i = 0; i < Math.max(x.length, y.length); i++) {
			const d = (x[i] ?? 0) - (y[i] ?? 0);
			if (d !== 0) return d > 0;
		}
		return false;
	};
	let best: ScanRow | undefined;
	for (const r of usable) {
		if (score(r)[0] === -1) continue;
		if (best === undefined || better(score(r), score(best))) best = r;
	}
	return best;
}
