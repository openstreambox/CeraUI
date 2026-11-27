/**
 * Whether a link delivers what it is offered, from the sender's per-link
 * arrival reports. Pure functions over 1 Hz snapshots (oldest first); no IO.
 *
 * The receiver acknowledges each data packet in an SRTLA ACK sent back on the
 * link it arrived on, in batches of ten. So over a span of one connection
 * epoch, the ACK entries a link reports, read a round trip later, should
 * match the packets the sender queued on it, give or take one batch. That is
 * the proof. It says nothing about capacity beyond the offered share: the bond
 * only carries what the encoder offers. Headroom is judged from the sender's
 * own estimates and labelled as such.
 *
 * Candidate and holder are judged asymmetrically. The sender holds a bad link
 * back by itself (stall gate, weak classifier, sole-carrier election), and a
 * link it holds back is offered too little to measure. For a candidate that
 * makes the span inconclusive. For a holder, the sender giving up on the path
 * (stall gate, sole-carrier, high-RTT weak, degraded CC loss) is a failure,
 * while the sender merely preferring a sibling is inconclusive, and a holder
 * that stops answering while another link still hears from the receiver is
 * dead. The in-flight cap is a per-tick queueing bound on any loaded link and
 * plays no part.
 */

import {
	heldBack,
	holderFailing,
	holderSidelined,
	type LinkSample,
	type Snapshot,
} from "./sender-links.ts";
import type { SpanVerdict } from "./swap-op.ts";

export type ProofPolicy = Readonly<{
	/** A candidate must deliver at least this share of what it was offered. */
	proofRatio: number;
	/** A holder below this share is fading; hysteresis against `proofRatio`. */
	fadeRatio: number;
	/** One receiver batch of quantization, once per span (entries). */
	slackEntries: number;
	minSpanMs: number;
	maxSpanMs: number;
	/** Packets a span must carry to be measured. */
	minSpanPackets: number;
	/** A 1 s step with this many queued and no new entries breaks the span. */
	continuityStepPackets: number;
	/** `cc_loss_permille` at or above this fails a candidate. */
	maxLossPermille: number;
	/** A candidate's RTT may use at most this share of the SRT latency. */
	latencyShare: number;
	/** `cc_target_bps` must reach this multiple of the encoder rate. */
	headroomFactor: number;
	/**
	 * A climbing CC target is clamped at twice the link's measured throughput,
	 * so a target at this multiple of what the link carries says only "capped
	 * by its share", not "no headroom".
	 */
	clampFactor: number;
	/** A candidate offered less than this share of 1/N is not measurable. */
	shareFloor: number;
	/** A holder's ACK age beyond this (or its rate bound) means dead. */
	deadAgeMs: number;
	/** A sibling with no measurable rate counts as answered within this. */
	freshAgeMs: number;
	/** The bond's rate during a proof, relative to before the fade. */
	loadFloor: number;
	/** How far back the pre-fade rate looks. */
	preFadeWindowMs: number;
	/** Receiver ACK batch size. */
	batchPackets: number;
}>;

export const PROOF_POLICY: ProofPolicy = {
	proofRatio: 0.95,
	fadeRatio: 0.9,
	slackEntries: 10,
	minSpanMs: 3_000,
	maxSpanMs: 10_000,
	minSpanPackets: 60,
	continuityStepPackets: 20,
	maxLossPermille: 20,
	latencyShare: 0.25,
	headroomFactor: 1.25,
	clampFactor: 1.9,
	shareFloor: 0.75,
	deadAgeMs: 1_500,
	freshAgeMs: 1_000,
	loadFloor: 0.5,
	preFadeWindowMs: 60_000,
	batchPackets: 10,
};

/** Samples to read the entries side later by: one RTT, at least one sample. */
export function lagSamples(rttMs: number): number {
	return Math.max(1, Math.ceil(Math.max(0, rttMs) / 1_000));
}

/**
 * How old the last ACK may be at a given packet rate: a batch takes
 * `batchPackets / rate` seconds to fill, twice that plus a round trip, and at
 * least one second.
 */
export function ageBoundMs(
	packetsPerS: number,
	rttMs: number,
	policy: ProofPolicy = PROOF_POLICY,
): number {
	if (!(packetsPerS > 0)) return Number.POSITIVE_INFINITY;
	return Math.max(
		1_000,
		((2 * policy.batchPackets) / packetsPerS) * 1_000 + Math.max(0, rttMs),
	);
}

type Lookup = (snap: Snapshot) => LinkSample | undefined;

/**
 * CC states in which a target below the load means "no headroom". While the
 * CC is still in `bootstrap` or `climbing` (as it is when a fade shifts load
 * onto the candidate faster than the target rises, a few percent per tick), a
 * low target only says it has not climbed yet.
 */
const SETTLED_CC_STATES: ReadonlySet<string> = new Set([
	"holding",
	"backing_off",
	"drain",
]);

export type SpanMeasure =
	| Readonly<{ status: "absent" | "open" | "too-little" }>
	| Readonly<{
			status: "measured";
			startAt: number;
			endAt: number;
			durationMs: number;
			offered: number;
			delivered: number;
			lag: number;
			continuityBreak: boolean;
			packetsPerS: number;
			latest: LinkSample;
			startIndex: number;
			endIndex: number;
	  }>;

const never = () => false;

/**
 * Measure the latest span of one link: the shortest trailing span of one
 * epoch, in which it stayed connected and `breaks` never held, that reaches
 * `minSpanMs` and `minSpanPackets`, at most `maxSpanMs` long. The entries
 * side is read `lag` samples later. The shortest span keeps a verdict about
 * the last few seconds: at 20 pkt/s and up it is 3 s, and only a slower link
 * is judged over up to 10 s.
 */
export function measureSpan(
	snaps: readonly Snapshot[],
	get: Lookup,
	breaks: (s: LinkSample) => boolean = never,
	policy: ProofPolicy = PROOF_POLICY,
): SpanMeasure {
	const n = snaps.length - 1;
	const latestSnap = snaps[n];
	const latest = latestSnap ? get(latestSnap) : undefined;
	if (!latestSnap || !latest) return { status: "absent" };
	const usable = (s: LinkSample | undefined): s is LinkSample =>
		s !== undefined &&
		s.epoch === latest.epoch &&
		s.connected &&
		!s.timedOut &&
		!breaks(s);
	if (!usable(latest)) return { status: "open" };
	let k = n;
	while (k > 0 && usable(get(snaps[k - 1] as Snapshot))) k--;
	const lag = lagSamples(latest.rttMs);
	const i1 = n - lag;
	if (i1 <= k) return { status: "open" };
	const at = (i: number) => (snaps[i] as Snapshot).at;
	const sample = (i: number) => get(snaps[i] as Snapshot) as LinkSample;
	let i0 = -1;
	for (let j = i1 - 1; j >= k && at(i1) - at(j) <= policy.maxSpanMs; j--) {
		if (
			at(i1) - at(j) >= policy.minSpanMs &&
			sample(i1).queued - sample(j).queued >= policy.minSpanPackets
		) {
			i0 = j;
			break;
		}
	}
	if (i0 < 0)
		return {
			status: at(i1) - at(k) >= policy.maxSpanMs ? "too-little" : "open",
		};
	const durationMs = at(i1) - at(i0);
	const offered = sample(i1).queued - sample(i0).queued;
	const delivered = sample(i1 + lag).entries - sample(i0 + lag).entries;
	let continuityBreak = false;
	for (let j = i0; j < i1; j++) {
		const dq = sample(j + 1).queued - sample(j).queued;
		const de = sample(j + 1 + lag).entries - sample(j + lag).entries;
		if (dq >= policy.continuityStepPackets && de === 0) continuityBreak = true;
	}
	return {
		status: "measured",
		startAt: at(i0),
		endAt: at(i1),
		durationMs,
		offered,
		delivered,
		lag,
		continuityBreak,
		packetsPerS: (offered / durationMs) * 1_000,
		latest,
		startIndex: i0,
		endIndex: i1,
	};
}

/** `delivered ≥ ratio × offered − slack`, once for the whole span. */
export function deliversAtLeast(
	m: Readonly<{ offered: number; delivered: number }>,
	ratio: number,
	policy: ProofPolicy = PROOF_POLICY,
): boolean {
	return m.delivered >= ratio * m.offered - policy.slackEntries;
}

/** Packets queued on every link present with the same epoch at both snapshots. */
function bondOffered(a: Snapshot, b: Snapshot): number {
	const delta = (x: LinkSample | undefined, y: LinkSample | undefined) =>
		x && y && x.epoch === y.epoch ? Math.max(0, y.queued - x.queued) : 0;
	let total = 0;
	for (const [key, y] of b.radios) total += delta(a.radios.get(key), y);
	for (const [key, y] of b.others) total += delta(a.others.get(key), y);
	return total;
}

/**
 * The bond's median packet rate over the `preFadeWindowMs` before `fadeAt`,
 * from consecutive snapshots. `null` without two snapshots in the window.
 */
export function preFadeBondRate(
	snaps: readonly Snapshot[],
	fadeAt: number,
	policy: ProofPolicy = PROOF_POLICY,
): number | null {
	const window = snaps.filter(
		(s) => s.at <= fadeAt && s.at >= fadeAt - policy.preFadeWindowMs,
	);
	const rates: number[] = [];
	for (let i = 1; i < window.length; i++) {
		const a = window[i - 1] as Snapshot;
		const b = window[i] as Snapshot;
		if (b.at > a.at) rates.push((bondOffered(a, b) / (b.at - a.at)) * 1_000);
	}
	if (rates.length === 0) return null;
	rates.sort((x, y) => x - y);
	const mid = Math.floor(rates.length / 2);
	return rates.length % 2
		? (rates[mid] as number)
		: ((rates[mid - 1] as number) + (rates[mid] as number)) / 2;
}

export type ProofLoad = Readonly<{
	candidatePacketsPerS: number;
	bondPacketsPerS: number;
	encoderBps: number | null;
}>;

/**
 * Which checks a proof could run. The latency cap needs the negotiated SRT
 * latency; headroom needs a CC target and the encoder rate. A target at the
 * climb clamp only says the link is capped by its share, and a low target
 * while the CC is still climbing (or its state is not reported) only says it
 * has not caught up: neither counts against the candidate.
 */
export type ProofChecks = Readonly<{
	latency: boolean;
	headroom: "estimated" | "at-clamp" | "climbing" | "not-reported";
}>;

export type CandidateProof = Readonly<{
	/** `open`: keep sampling; the span is not long or busy enough yet. */
	verdict: SpanVerdict | "open";
	reason: string;
	offered?: number;
	delivered?: number;
	durationMs?: number;
	/** The load the proof was taken at. */
	load?: ProofLoad;
	checks?: ProofChecks;
}>;

export type CandidateContext = Readonly<{
	/** Links carrying in the bond, the candidate included. */
	carrying: number;
	encoderBps: number | null;
	/** The bond's packet rate before the fade trigger ({@link preFadeBondRate}). */
	preFadeBondPacketsPerS: number | null;
}>;

/** Judge a candidate's latest span. */
export function evaluateCandidate(
	snaps: readonly Snapshot[],
	ifname: string,
	ctx: CandidateContext,
	policy: ProofPolicy = PROOF_POLICY,
): CandidateProof {
	const get: Lookup = (s) => s.radios.get(ifname);
	const latestSnap = snaps[snaps.length - 1];
	const latest = latestSnap ? get(latestSnap) : undefined;
	if (!latestSnap || !latest)
		return { verdict: "inconclusive", reason: "not reported" };
	const held = heldBack(latest);
	if (held !== null)
		return { verdict: "inconclusive", reason: `held back: ${held}` };
	const m = measureSpan(snaps, get, (s) => heldBack(s) !== null, policy);
	if (m.status !== "measured") {
		if (m.status === "open") return { verdict: "open", reason: "measuring" };
		return {
			verdict: "inconclusive",
			reason: m.status === "absent" ? "not reported" : "too little traffic",
		};
	}
	const facts = {
		offered: m.offered,
		delivered: m.delivered,
		durationMs: m.durationMs,
	};
	const latency = latestSnap.negotiatedLatencyMs;
	let headroom: ProofChecks["headroom"] | "below" = "not-reported";
	const target = latest.ccTargetBps;
	if (target !== null && ctx.encoderBps !== null) {
		if (target >= policy.headroomFactor * ctx.encoderBps)
			headroom = "estimated";
		else if (
			latest.bitrateBps > 0 &&
			target >= policy.clampFactor * latest.bitrateBps
		)
			headroom = "at-clamp";
		else if (latest.ccState !== null && SETTLED_CC_STATES.has(latest.ccState))
			headroom = "below";
		else headroom = "climbing";
	}
	const checks: ProofChecks = {
		latency: latency !== null,
		headroom: headroom === "below" ? "estimated" : headroom,
	};
	const fail = (reason: string): CandidateProof => ({
		verdict: "fail",
		reason,
		...facts,
		checks,
	});
	const inconclusive = (reason: string): CandidateProof => ({
		verdict: "inconclusive",
		reason,
		...facts,
		checks,
	});
	if (!deliversAtLeast(m, policy.proofRatio, policy))
		return fail("delivery below the proof ratio");
	if (m.continuityBreak) return fail("a busy second with no arrivals");
	const age = latest.ageMs;
	if (age === null || age > ageBoundMs(m.packetsPerS, latest.rttMs, policy))
		return fail("last ACK too old");
	if (
		latest.ccLossDegraded ||
		(latest.ccLossPermille !== null &&
			latest.ccLossPermille >= policy.maxLossPermille)
	)
		return fail("congestion-control loss too high");
	if (latency !== null && latest.rttMs > latency * policy.latencyShare)
		return fail("RTT too large for the SRT latency");
	if (headroom === "below")
		return fail("capacity estimate below the headroom factor");
	const bond = bondOffered(
		snaps[m.startIndex] as Snapshot,
		snaps[m.endIndex] as Snapshot,
	);
	if (ctx.carrying > 1 && m.offered * ctx.carrying < policy.shareFloor * bond)
		return inconclusive("offered less than its share of the bond");
	const bondPacketsPerS = (bond / m.durationMs) * 1_000;
	const load: ProofLoad = {
		candidatePacketsPerS: m.packetsPerS,
		bondPacketsPerS,
		encoderBps: ctx.encoderBps,
	};
	if (
		ctx.preFadeBondPacketsPerS !== null &&
		bondPacketsPerS < policy.loadFloor * ctx.preFadeBondPacketsPerS
	)
		return { ...inconclusive("bond load below the pre-fade floor"), load };
	return {
		verdict: "pass",
		reason: "delivered what it was offered",
		...facts,
		load,
		checks,
	};
}

export type HolderJudgement = Readonly<{
	verdict: SpanVerdict;
	/** Delivery below the fade ratio over a measured span. */
	fading: boolean;
	/** Gone for the receiver while another link still hears from it. */
	dead: boolean;
	reason: string;
}>;

/**
 * The receiver still answers some other link: one that is connected and got an
 * ACK within its own rate's bound (or `freshAgeMs` when its rate is unknown).
 */
function siblingFresh(
	snaps: readonly Snapshot[],
	ifname: string,
	policy: ProofPolicy,
): boolean {
	const latestSnap = snaps[snaps.length - 1] as Snapshot;
	const fresh = (get: Lookup) => {
		const s = get(latestSnap);
		if (!s?.connected || s.timedOut || s.ageMs === null) return false;
		const m = measureSpan(snaps, get, never, policy);
		const bound =
			m.status === "measured"
				? ageBoundMs(m.packetsPerS, s.rttMs, policy)
				: policy.freshAgeMs;
		return s.ageMs <= bound;
	};
	for (const key of latestSnap.radios.keys())
		if (key !== ifname && fresh((s) => s.radios.get(key))) return true;
	for (const key of latestSnap.others.keys())
		if (fresh((s) => s.others.get(key))) return true;
	return false;
}

/**
 * How long since the receiver last answered on this link in its current
 * epoch: the reported age, or, before any ACK, the time the epoch has been
 * carrying traffic without one (`null` while it has carried too little).
 */
function silenceMs(
	snaps: readonly Snapshot[],
	get: Lookup,
	latest: LinkSample,
	policy: ProofPolicy,
): number | null {
	if (latest.ageMs !== null) return latest.ageMs;
	const n = snaps.length - 1;
	let first = n;
	while (first > 0 && get(snaps[first - 1] as Snapshot)?.epoch === latest.epoch)
		first--;
	const start = get(snaps[first] as Snapshot) as LinkSample;
	if (latest.queued - start.queued < 2 * policy.batchPackets) return null;
	return (snaps[n] as Snapshot).at - (snaps[first] as Snapshot).at;
}

/**
 * Judge the holder: dead, failing, fading, or fine. The sender giving up on
 * its path (stall gate, sole-carrier, a high-RTT weak flag, degraded CC loss)
 * is a failure; the sender merely preferring a sibling is inconclusive.
 */
export function evaluateHolder(
	snaps: readonly Snapshot[],
	ifname: string,
	policy: ProofPolicy = PROOF_POLICY,
): HolderJudgement {
	const get: Lookup = (s) => s.radios.get(ifname);
	const latestSnap = snaps[snaps.length - 1];
	const latest = latestSnap ? get(latestSnap) : undefined;
	const judged = (
		verdict: SpanVerdict,
		reason: string,
		extra: Partial<Pick<HolderJudgement, "fading" | "dead">> = {},
	): HolderJudgement => ({
		verdict,
		fading: extra.fading ?? false,
		dead: extra.dead ?? false,
		reason,
	});
	if (!latestSnap || !latest) return judged("inconclusive", "not reported");
	if (!latest.connected || latest.timedOut)
		return judged("fail", "disconnected", { dead: true });
	const m = measureSpan(snaps, get, never, policy);
	const rate = m.status === "measured" ? m.packetsPerS : 0;
	const bound = Math.max(
		policy.deadAgeMs,
		rate > 0 ? ageBoundMs(rate, latest.rttMs, policy) : policy.deadAgeMs,
	);
	const silence = silenceMs(snaps, get, latest, policy);
	if (
		silence !== null &&
		silence > bound &&
		siblingFresh(snaps, ifname, policy)
	)
		return judged("fail", "no ACKs while a sibling still gets them", {
			dead: true,
		});
	const failing = holderFailing(latest);
	if (failing !== null) return judged("fail", `sender gave up: ${failing}`);
	const sidelined = holderSidelined(latest);
	if (sidelined !== null)
		return judged("inconclusive", `sender prefers a sibling: ${sidelined}`);
	if (m.status !== "measured") return judged("inconclusive", "measuring");
	if (!deliversAtLeast(m, policy.fadeRatio, policy))
		return judged("fail", "delivery below the fade ratio", { fading: true });
	return judged("pass", "delivering");
}

/**
 * Whether a link outside the pair failed over its latest span: the witness a
 * common-target failure needs. Radios in `pair` are skipped. Each link is
 * judged over its own latest span, at the fade ratio.
 */
export function independentLinkFailed(
	snaps: readonly Snapshot[],
	pair: ReadonlySet<string>,
	policy: ProofPolicy = PROOF_POLICY,
): boolean {
	const latestSnap = snaps[snaps.length - 1];
	if (!latestSnap) return false;
	const failed = (get: Lookup) => {
		const m = measureSpan(snaps, get, never, policy);
		return (
			m.status === "measured" && !deliversAtLeast(m, policy.fadeRatio, policy)
		);
	};
	for (const key of latestSnap.radios.keys())
		if (!pair.has(key) && failed((s) => s.radios.get(key))) return true;
	for (const key of latestSnap.others.keys())
		if (failed((s) => s.others.get(key))) return true;
	return false;
}
