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
 * back by itself (stall gate, weak classifier, sole-carrier election, in-flight
 * cap), and a link it holds back is offered too little to measure. For a
 * candidate that makes the span inconclusive; for a holder it is a failure, and
 * a holder that stops answering while another link still hears from the
 * receiver is dead.
 */

import type { LinkSample, Snapshot } from "./sender-links.ts";
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
	/** A holder's ACK age beyond this (or its rate bound) means dead. */
	deadAgeMs: number;
	/** A sibling ACK age within this counts as the receiver still answering. */
	freshAgeMs: number;
	/** The bond's rate during a proof, relative to before the fade. */
	loadFloor: number;
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
	deadAgeMs: 1_500,
	freshAgeMs: 1_000,
	loadFloor: 0.5,
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

/**
 * Measure the latest span of one link: the trailing stretch of one epoch in
 * which it stayed connected (and, with `resetOnGate`, ungated), capped at
 * `maxSpanMs`, with the entries side read `lag` samples later.
 */
export function measureSpan(
	snaps: readonly Snapshot[],
	get: Lookup,
	resetOnGate: boolean,
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
		!(resetOnGate && s.gated);
	let k = n;
	while (k > 0 && usable(get(snaps[k - 1] as Snapshot))) k--;
	if (!usable(latest)) return { status: "open" };
	const lag = lagSamples(latest.rttMs);
	const i1 = n - lag;
	if (i1 <= k) return { status: "open" };
	const at = (i: number) => (snaps[i] as Snapshot).at;
	const sample = (i: number) => get(snaps[i] as Snapshot) as LinkSample;
	let i0 = k;
	while (at(i1) - at(i0) > policy.maxSpanMs) i0++;
	const durationMs = at(i1) - at(i0);
	if (durationMs < policy.minSpanMs) return { status: "open" };
	const offered = sample(i1).queued - sample(i0).queued;
	if (offered < policy.minSpanPackets)
		return {
			status: at(i1) - at(k) >= policy.maxSpanMs ? "too-little" : "open",
		};
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

/** Packets queued on every link present with the same epoch at both indices. */
function bondOffered(
	snaps: readonly Snapshot[],
	i0: number,
	i1: number,
): number {
	const a = snaps[i0] as Snapshot;
	const b = snaps[i1] as Snapshot;
	const delta = (x: LinkSample | undefined, y: LinkSample | undefined) =>
		x && y && x.epoch === y.epoch ? Math.max(0, y.queued - x.queued) : 0;
	let total = 0;
	for (const [key, y] of b.radios) total += delta(a.radios.get(key), y);
	for (const [key, y] of b.others) total += delta(a.others.get(key), y);
	return total;
}

export type ProofLoad = Readonly<{
	candidatePacketsPerS: number;
	bondPacketsPerS: number;
	encoderBps: number | null;
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
	/** The sender gave a capacity estimate (`cc_target_bps`). */
	headroomEstimated?: boolean;
	/** The bond carried at least `loadFloor` of its pre-fade rate. */
	meetsLoadFloor?: boolean;
}>;

export type CandidateContext = Readonly<{
	/** Links carrying in the bond, the candidate included. */
	carrying: number;
	encoderBps: number | null;
	/** The bond's packet rate before the fade trigger, if known. */
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
	if (latest.gated)
		return { verdict: "inconclusive", reason: `held back: ${latest.gatedBy}` };
	const m = measureSpan(snaps, get, true, policy);
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
	const fail = (reason: string): CandidateProof => ({
		verdict: "fail",
		reason,
		...facts,
	});
	if (!deliversAtLeast(m, policy.proofRatio, policy))
		return fail("delivery below the proof ratio");
	if (m.continuityBreak) return fail("a busy second with no arrivals");
	const age = latestSnap.radios.get(ifname)?.ageMs ?? null;
	if (age === null || age > ageBoundMs(m.packetsPerS, latest.rttMs, policy))
		return fail("last ACK too old");
	if (
		latest.ccLossPermille !== null &&
		latest.ccLossPermille >= policy.maxLossPermille
	)
		return fail("congestion-control loss too high");
	const latency = latestSnap.negotiatedLatencyMs;
	if (latency !== null && latest.rttMs > latency * policy.latencyShare)
		return fail("RTT too large for the SRT latency");
	const bond = bondOffered(snaps, m.startIndex, m.endIndex);
	if (ctx.carrying > 1 && m.offered * ctx.carrying < bond)
		return fail("offered less than its share of the bond");
	if (
		latest.ccTargetBps !== null &&
		ctx.encoderBps !== null &&
		latest.ccTargetBps < policy.headroomFactor * ctx.encoderBps
	)
		return fail("capacity estimate below the headroom factor");
	const bondPacketsPerS = (bond / m.durationMs) * 1_000;
	return {
		verdict: "pass",
		reason: "delivered what it was offered",
		...facts,
		load: {
			candidatePacketsPerS: m.packetsPerS,
			bondPacketsPerS,
			encoderBps: ctx.encoderBps,
		},
		headroomEstimated: latest.ccTargetBps !== null,
		meetsLoadFloor:
			ctx.preFadeBondPacketsPerS === null ||
			bondPacketsPerS >= policy.loadFloor * ctx.preFadeBondPacketsPerS,
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

function siblingFresh(
	snap: Snapshot,
	ifname: string,
	policy: ProofPolicy,
): boolean {
	const fresh = (s: LinkSample) =>
		s.connected && s.ageMs !== null && s.ageMs <= policy.freshAgeMs;
	for (const [key, s] of snap.radios)
		if (key !== ifname && fresh(s)) return true;
	for (const s of snap.others.values()) if (fresh(s)) return true;
	return false;
}

/** Judge the holder: dead, failing (sender gating counts), fading, or fine. */
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
	const m = measureSpan(snaps, get, false, policy);
	const rate = m.status === "measured" ? m.packetsPerS : 0;
	const bound = Math.max(
		policy.deadAgeMs,
		rate > 0 ? ageBoundMs(rate, latest.rttMs, policy) : policy.deadAgeMs,
	);
	if (
		latest.ageMs !== null &&
		latest.ageMs > bound &&
		siblingFresh(latestSnap, ifname, policy)
	)
		return judged("fail", "no ACKs while a sibling still gets them", {
			dead: true,
		});
	if (latest.gated) return judged("fail", `held back: ${latest.gatedBy}`);
	if (m.status !== "measured") return judged("inconclusive", "measuring");
	if (!deliversAtLeast(m, policy.fadeRatio, policy))
		return judged("fail", "delivery below the fade ratio", { fading: true });
	return judged("pass", "delivering");
}

/**
 * Whether a link outside the pair failed over its latest span: the witness a
 * common-target failure needs. Radios in `pair` are skipped.
 */
export function independentLinkFailed(
	snaps: readonly Snapshot[],
	pair: ReadonlySet<string>,
	policy: ProofPolicy = PROOF_POLICY,
): boolean {
	const latestSnap = snaps[snaps.length - 1];
	if (!latestSnap) return false;
	const failed = (get: Lookup) => {
		const m = measureSpan(snaps, get, false, policy);
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
