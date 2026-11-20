import { describe, expect, test } from "bun:test";
import {
	ageBoundMs,
	evaluateCandidate,
	evaluateHolder,
	independentLinkFailed,
	lagSamples,
	PROOF_POLICY,
	preFadeBondRate,
} from "./proof.ts";
import type { LinkSample, Snapshot } from "./sender-links.ts";

/** Roughly what a 1316-byte payload costs on the wire, in bits. */
const BITS_PER_PACKET = 1_400 * 8;

const base: LinkSample = {
	epoch: 1,
	connected: true,
	timedOut: false,
	queued: 0,
	entries: 0,
	ageMs: 100,
	rttMs: 30,
	bitrateBps: 0,
	stallGated: false,
	soleCarrierExcluded: false,
	weak: false,
	weakReason: null,
	inFlightCapActive: false,
	ccLossDegraded: false,
	ccTargetBps: null,
	ccState: null,
	ccLossPermille: null,
};

type Run = Readonly<{
	/** Packets queued per second, constant or per second `t` (for t-1..t). */
	pps: number | ((t: number) => number);
	/** Share of what was queued in second t-1..t that the receiver acknowledges. */
	deliver?: number | ((t: number) => number);
	/** Whole seconds the ACK side lags the queue side. */
	lagS?: number;
	ageMs?: number | null;
	over?: Partial<LinkSample> | ((t: number) => Partial<LinkSample>);
}>;

const at = <T>(v: T | ((t: number) => T), t: number): T =>
	typeof v === "function" ? (v as (t: number) => T)(t) : v;

/** One link, sampled once a second, ACKed in receiver batches of 10. */
function run(seconds: number, r: Run): LinkSample[] {
	const lagS = r.lagS ?? 1;
	const queuedAt: number[] = [0];
	const arrivedAt: number[] = [0];
	for (let t = 1; t <= seconds; t++) {
		const n = at(r.pps, t);
		queuedAt.push((queuedAt[t - 1] as number) + n);
		arrivedAt.push((arrivedAt[t - 1] as number) + n * at(r.deliver ?? 1, t));
	}
	const out: LinkSample[] = [];
	for (let t = 0; t <= seconds; t++) {
		const acked = t - lagS >= 0 ? (arrivedAt[t - lagS] as number) : 0;
		const rate = t > 0 ? at(r.pps, t) : at(r.pps, 1);
		out.push({
			...base,
			queued: queuedAt[t] as number,
			entries: Math.floor(acked / 10) * 10,
			ageMs: r.ageMs === undefined ? 100 : r.ageMs,
			bitrateBps: rate * BITS_PER_PACKET,
			...at(r.over ?? {}, t),
		});
	}
	return out;
}

function snaps(
	radios: Record<string, LinkSample[]>,
	others: Record<string, LinkSample[]> = {},
	latencyMs: number | null = 2000,
): Snapshot[] {
	const length = Math.max(
		...Object.values(radios).map((s) => s.length),
		...Object.values(others).map((s) => s.length),
	);
	const out: Snapshot[] = [];
	for (let i = 0; i < length; i++) {
		const pick = (rec: Record<string, LinkSample[]>) =>
			new Map(
				Object.entries(rec)
					.filter(([, s]) => s[i] !== undefined)
					.map(([k, s]) => [k, s[i] as LinkSample]),
			);
		const radiosAt = pick(radios);
		out.push({
			at: 10_000 + i * 1_000,
			radios: radiosAt,
			others: pick(others),
			negotiatedLatencyMs: latencyMs,
			claimed: new Set(radiosAt.keys()),
		});
	}
	return out;
}

const ctx = { carrying: 1, encoderBps: null, preFadeBondPacketsPerS: null };
const candidate = (
	s: Snapshot[],
	c: Partial<{
		carrying: number;
		encoderBps: number | null;
		preFadeBondPacketsPerS: number | null;
	}> = {},
) => evaluateCandidate(s, "wlan2", { ...ctx, ...c });

describe("candidate proof", () => {
	test("a link that delivers everything it is offered passes after 3 s", () => {
		const p = candidate(snaps({ wlan2: run(4, { pps: 40 }) }));
		expect(p.verdict).toBe("pass");
		expect(p.durationMs).toBe(3_000);
		expect(p.offered).toBe(120);
	});

	test("too short a span is still open", () => {
		expect(candidate(snaps({ wlan2: run(3, { pps: 40 }) })).verdict).toBe(
			"open",
		);
	});

	test("65 % delivery at 40 pkt/s fails (the per-window slack used to pass it)", () => {
		expect(
			candidate(snaps({ wlan2: run(4, { pps: 40, deliver: 0.65 }) })).verdict,
		).toBe("fail");
	});

	test("the threshold sits near 87 % at 3 s and 40 pkt/s", () => {
		const v = (deliver: number) =>
			candidate(snaps({ wlan2: run(4, { pps: 40, deliver }) })).verdict;
		expect(v(0.8)).toBe("fail");
		expect(v(0.92)).toBe("pass");
	});

	test("delivery exactly at 0.95 × offered − 10 passes", () => {
		// 120 queued over the span: 104 entries is the bound.
		const s = run(4, { pps: 40 });
		const lagged = [0, 40, 80, 120, 144] as const;
		const tuned = s.map((x, i) => ({ ...x, entries: lagged[i] as number }));
		const p = candidate(snaps({ wlan2: tuned }));
		expect(p.delivered).toBe(104);
		expect(p.verdict).toBe("pass");
		const short = tuned.map((x, i) => (i === 4 ? { ...x, entries: 143 } : x));
		expect(candidate(snaps({ wlan2: short })).verdict).toBe("fail");
	});

	test("the span is the shortest qualifying one, so recent loss is not diluted", () => {
		// 10 s clean, then 3 s at 80 %: a 10 s average would still pass.
		const s = snaps({
			wlan2: run(14, { pps: 40, deliver: (t) => (t > 10 ? 0.8 : 1) }),
		});
		const p = candidate(s);
		expect(p.durationMs).toBe(3_000);
		expect(p.verdict).toBe("fail");
	});

	test("a low-rate link is judged over a longer span, but never over 10 s", () => {
		const slow = candidate(snaps({ wlan2: run(11, { pps: 8, ageMs: 1_800 }) }));
		expect(slow.verdict).toBe("pass");
		expect(slow.durationMs).toBe(8_000);
		expect(ageBoundMs(8, 30)).toBe(2_530);
		// 5 pkt/s needs 12 s for 60 packets: past the cap, so never measured.
		const tooSlow = candidate(snaps({ wlan2: run(20, { pps: 5 }) }));
		expect(tooSlow.verdict).toBe("inconclusive");
		expect(tooSlow.reason).toBe("too little traffic");
	});

	test("a link offered too little over 10 s is inconclusive, not failed", () => {
		expect(candidate(snaps({ wlan2: run(12, { pps: 4 }) })).verdict).toBe(
			"inconclusive",
		);
	});

	test("the sender holding the candidate back makes it inconclusive and restarts the span", () => {
		for (const over of [
			{ stallGated: true },
			{ soleCarrierExcluded: true },
			{ weak: true, weakReason: "low_share" },
		]) {
			const s = run(6, { pps: 40 });
			s[6] = { ...(s[6] as LinkSample), ...over };
			const p = candidate(snaps({ wlan2: s }));
			expect(p.verdict).toBe("inconclusive");
			expect(p.reason).toStartWith("held back");
		}
		const after = run(8, { pps: 40 });
		after[3] = { ...(after[3] as LinkSample), stallGated: true };
		// Ungated from sample 4: 4..7 is 3 s, but the entries side needs sample 8.
		expect(candidate(snaps({ wlan2: after.slice(0, 8) })).verdict).toBe("open");
		expect(candidate(snaps({ wlan2: after })).verdict).toBe("pass");
	});

	test("a flapping in-flight cap does not hold a candidate back", () => {
		const s = snaps({
			wlan2: run(30, {
				pps: 60,
				over: (t) => ({ inFlightCapActive: t % 3 === 0 }),
			}),
		});
		const verdicts = new Set<string>();
		for (let n = 5; n <= s.length; n++)
			verdicts.add(candidate(s.slice(0, n)).verdict);
		expect(verdicts).toEqual(new Set(["pass"]));
	});

	test("a disconnected sample restarts the span", () => {
		const s = run(6, { pps: 40 });
		s[3] = { ...(s[3] as LinkSample), connected: false };
		expect(candidate(snaps({ wlan2: s })).verdict).toBe("open");
	});

	test("an epoch change restarts the span", () => {
		const s = run(6, { pps: 40 });
		for (let i = 4; i < s.length; i++)
			s[i] = { ...(s[i] as LinkSample), epoch: 2 };
		expect(candidate(snaps({ wlan2: s })).verdict).toBe("open");
	});

	test("a busy second with no arrivals fails even if the total catches up", () => {
		const s = run(6, { pps: 40 });
		// The ACKs for one second arrive only with the next one's.
		s[5] = { ...(s[5] as LinkSample), entries: (s[4] as LinkSample).entries };
		expect(candidate(snaps({ wlan2: s })).reason).toBe(
			"a busy second with no arrivals",
		);
	});

	test("a second with exactly 20 queued and no arrivals breaks the span", () => {
		const s = run(6, { pps: 20 });
		s[5] = { ...(s[5] as LinkSample), entries: (s[4] as LinkSample).entries };
		expect(candidate(snaps({ wlan2: s })).reason).toBe(
			"a busy second with no arrivals",
		);
	});

	test("a stale last ACK fails", () => {
		expect(
			candidate(snaps({ wlan2: run(4, { pps: 40, ageMs: 1_200 }) })).reason,
		).toBe("last ACK too old");
	});

	test("loss the sender's congestion control sees fails it", () => {
		const v = (over: Partial<LinkSample>) =>
			candidate(snaps({ wlan2: run(4, { pps: 40, over }) })).verdict;
		expect(v({ ccLossPermille: 20 })).toBe("fail");
		expect(v({ ccLossPermille: 19 })).toBe("pass");
		expect(v({ ccLossDegraded: true })).toBe("fail");
	});

	test("a bloated path fails against the SRT latency even if it delivers", () => {
		const bloated = run(4, { pps: 40, over: { rttMs: 600 } });
		expect(candidate(snaps({ wlan2: bloated })).reason).toBe(
			"RTT too large for the SRT latency",
		);
		const p = candidate(snaps({ wlan2: bloated }, {}, null));
		expect(p.verdict).toBe("pass");
		expect(p.checks?.latency).toBe(false);
	});

	test("a balanced share passes; well under 1/N is inconclusive, not a failure", () => {
		const fair = snaps({
			wlan2: run(5, { pps: 48 }),
			wlan1: run(5, { pps: 52 }),
		});
		expect(candidate(fair, { carrying: 2 }).verdict).toBe("pass");
		const low = snaps({
			wlan2: run(5, { pps: 30 }),
			wlan1: run(5, { pps: 70 }),
		});
		const p = candidate(low, { carrying: 2 });
		expect(p.verdict).toBe("inconclusive");
		expect(p.reason).toBe("offered less than its share of the bond");
	});

	test("a sibling re-added mid-span does not count its new totals", () => {
		// The sibling's new connection starts above its old totals: summed
		// across the epoch change it would look like 1000 packets.
		const sib = run(5, { pps: 40 }).map((x, i) =>
			i >= 3 ? { ...x, epoch: 2, queued: 1_000 + 40 * i } : x,
		);
		const p = candidate(snaps({ wlan2: run(5, { pps: 40 }), wlan1: sib }), {
			carrying: 2,
		});
		expect(p.verdict).toBe("pass");
	});

	test("headroom: an estimate at the CC's climb clamp is not a failure", () => {
		// A 50/50 bond at 1.4 Mbit/s: the candidate carries ~0.7 Mbit/s and
		// its climbing target is clamped at twice that.
		const enc = 1_400_000;
		const half = enc / BITS_PER_PACKET / 2;
		const clamped = snaps({
			wlan2: run(5, { pps: half, over: { ccTargetBps: 1_400_000 } }),
			wlan1: run(5, { pps: half }),
		});
		const p = candidate(clamped, { carrying: 2, encoderBps: enc });
		expect(p.verdict).toBe("pass");
		expect(p.checks?.headroom).toBe("at-clamp");
	});

	test("headroom: a target of 1.25 × the encoder rate is an estimate", () => {
		const s = snaps({
			wlan2: run(4, { pps: 100, over: { ccTargetBps: 1_750_000 } }),
		});
		const p = candidate(s, { encoderBps: 1_400_000 });
		expect(p.verdict).toBe("pass");
		expect(p.checks?.headroom).toBe("estimated");
	});

	test("headroom: a target below the clamp and below 1.25 × fails once the CC has settled", () => {
		// ~1.1 Mbit/s carried, target 1.5 Mbit/s, and the CC no longer climbing.
		for (const ccState of ["holding", "backing_off", "drain"]) {
			const s = snaps({
				wlan2: run(4, {
					pps: 100,
					over: { ccTargetBps: 1_500_000, ccState },
				}),
			});
			const p = candidate(s, { encoderBps: 1_400_000 });
			expect(p.verdict).toBe("fail");
			expect(p.reason).toBe("capacity estimate below the headroom factor");
		}
	});

	test("headroom: a share rising faster than a climbing CC is not a failure", () => {
		// A fade moves the candidate from 0.5 E to 0.8 E of a 1.4 Mbit/s stream;
		// its target (1.5 Mbit/s) is past the old clamp and still climbing.
		const enc = 1_400_000;
		const perS = enc / BITS_PER_PACKET;
		for (const ccState of ["climbing", "bootstrap", null]) {
			const s = snaps({
				wlan2: run(6, {
					pps: (t) => (t > 3 ? 0.8 * perS : 0.5 * perS),
					over: { ccTargetBps: 1_500_000, ccState },
				}),
			});
			const p = candidate(s, { encoderBps: enc });
			expect(p.verdict).toBe("pass");
			expect(p.checks?.headroom).toBe("climbing");
		}
	});

	test("headroom: no target, or no encoder rate, is reported as not estimated", () => {
		const p = candidate(snaps({ wlan2: run(4, { pps: 40 }) }), {
			encoderBps: 1_000_000,
		});
		expect(p.verdict).toBe("pass");
		expect(p.checks?.headroom).toBe("not-reported");
		const noEncoder = candidate(
			snaps({ wlan2: run(4, { pps: 40, over: { ccTargetBps: 10 } }) }),
		);
		expect(noEncoder.checks?.headroom).toBe("not-reported");
	});

	test("a proof below the pre-fade load floor is inconclusive and records its load", () => {
		const s = snaps({ wlan2: run(4, { pps: 40 }) });
		const ok = candidate(s, { preFadeBondPacketsPerS: 80 });
		expect(ok.verdict).toBe("pass");
		expect(ok.load?.bondPacketsPerS).toBe(40);
		const low = candidate(s, { preFadeBondPacketsPerS: 81 });
		expect(low.verdict).toBe("inconclusive");
		expect(low.reason).toBe("bond load below the pre-fade floor");
		expect(low.load?.bondPacketsPerS).toBe(40);
	});

	test("the entries side lags by the RTT in whole samples", () => {
		expect(lagSamples(30)).toBe(1);
		expect(lagSamples(1_000)).toBe(1);
		expect(lagSamples(1_001)).toBe(2);
		// The rate doubles mid-span and ACKs come 2 s late: reading them 1 s
		// late short-counts the span.
		const step = (rttMs: number) =>
			snaps({
				wlan2: run(8, {
					pps: (t) => (t > 5 ? 80 : 40),
					lagS: 2,
					over: { rttMs },
				}),
			});
		const loose = { ...PROOF_POLICY, latencyShare: 1 };
		expect(evaluateCandidate(step(400), "wlan2", ctx, loose).verdict).toBe(
			"fail",
		);
		expect(evaluateCandidate(step(1_100), "wlan2", ctx, loose).verdict).toBe(
			"pass",
		);
	});
});

describe("pre-fade rate", () => {
	test("is the median per-second bond rate before the fade", () => {
		const s = snaps(
			{ wlan1: run(6, { pps: (t) => (t === 3 ? 200 : 40) }) },
			{ "modem-a": run(6, { pps: 20 }) },
		);
		expect(preFadeBondRate(s, s[6]?.at as number)).toBe(60);
		expect(preFadeBondRate(s.slice(0, 1), s[0]?.at as number)).toBeNull();
	});

	test("ignores snapshots older than its 60 s window", () => {
		// 100 busy seconds long before the fade, then a quiet minute: unbounded,
		// the busy stretch would be the median.
		const s = snaps({
			wlan1: run(160, { pps: (t) => (t <= 100 ? 500 : 20) }),
		});
		expect(preFadeBondRate(s, s[160]?.at as number)).toBe(20);
		expect(preFadeBondRate(s, s[60]?.at as number)).toBe(500);
	});
});

describe("holder judgement", () => {
	const holder = (s: Snapshot[]) => evaluateHolder(s, "wlan1");

	test("the sender giving up on the path is a failure", () => {
		for (const over of [
			{ stallGated: true },
			{ soleCarrierExcluded: true },
			{ weak: true, weakReason: "high_rtt" },
			{ ccLossDegraded: true },
		]) {
			const h = holder(snaps({ wlan1: run(4, { pps: 40, over }) }));
			expect(h.verdict).toBe("fail");
			expect(h.dead).toBe(false);
			expect(h.reason).toStartWith("sender gave up");
		}
	});

	test("the sender preferring a sibling is inconclusive", () => {
		for (const weakReason of ["low_share", "no_traffic"]) {
			const h = holder(
				snaps({ wlan1: run(4, { pps: 40, over: { weak: true, weakReason } }) }),
			);
			expect(h.verdict).toBe("inconclusive");
		}
	});

	test("one capped sample does not fail a holder", () => {
		const s = snaps({
			wlan1: run(6, {
				pps: 60,
				over: (t) => ({ inFlightCapActive: t === 6 }),
			}),
		});
		expect(holder(s).verdict).toBe("pass");
	});

	test("a disconnected holder is dead", () => {
		expect(
			holder(snaps({ wlan1: run(4, { pps: 40, over: { connected: false } }) }))
				.dead,
		).toBe(true);
	});

	test("a holder without ACKs while a sibling gets them is dead", () => {
		const h = holder(
			snaps({
				wlan1: run(4, { pps: 40, ageMs: 1_600 }),
				wlan2: run(4, { pps: 40, ageMs: 200 }),
			}),
		);
		expect(h.dead).toBe(true);
		expect(h.verdict).toBe("fail");
	});

	test("the dead bound follows the holder's rate", () => {
		// At 8 pkt/s a batch takes over a second; 2 s is within its bound.
		const sib = run(11, { pps: 40, ageMs: 200 });
		expect(
			holder(snaps({ wlan1: run(11, { pps: 8, ageMs: 2_000 }), wlan2: sib }))
				.dead,
		).toBe(false);
		expect(
			holder(snaps({ wlan1: run(11, { pps: 8, ageMs: 3_000 }), wlan2: sib }))
				.dead,
		).toBe(true);
	});

	test("without a fresh sibling, a quiet holder is not called dead", () => {
		const s = snaps({
			wlan1: run(4, { pps: 40, ageMs: 1_600 }),
			wlan2: run(4, { pps: 40, ageMs: 1_600 }),
		});
		expect(holder(s).dead).toBe(false);
	});

	test("a disconnected sibling is not fresh", () => {
		const s = snaps({
			wlan1: run(4, { pps: 40, ageMs: 1_600 }),
			wlan2: run(4, { pps: 40, ageMs: 100, over: { connected: false } }),
		});
		expect(holder(s).dead).toBe(false);
	});

	test("a low-rate sibling is fresh within its own bound", () => {
		const s = snaps(
			{ wlan1: run(11, { pps: 40, ageMs: 1_600 }) },
			{ "modem-a": run(11, { pps: 8, ageMs: 2_000 }) },
		);
		expect(holder(s).dead).toBe(true);
	});

	test("a cellular link counts as the fresh sibling", () => {
		const s = snaps(
			{ wlan1: run(4, { pps: 40, ageMs: 1_600 }) },
			{ "modem-a": run(4, { pps: 40, ageMs: 200 }) },
		);
		expect(holder(s).dead).toBe(true);
	});

	test("a holder whose new connection never got an ACK is dead", () => {
		const s = snaps({
			wlan1: run(6, {
				pps: 60,
				deliver: 0,
				ageMs: null,
				over: { epoch: 2 },
			}),
			wlan2: run(6, { pps: 60 }),
		});
		expect(holder(s).dead).toBe(true);
		// A new connection that has carried almost nothing is not judged yet.
		const young = snaps({
			wlan1: run(6, { pps: 2, ageMs: null, over: { epoch: 2 } }),
			wlan2: run(6, { pps: 60 }),
		});
		expect(holder(young).dead).toBe(false);
	});

	test("delivery below 0.90 is a fade and a failure; 0.95 is fine", () => {
		const fading = holder(
			snaps({ wlan1: run(4, { pps: 100, deliver: 0.85 }) }),
		);
		expect(fading.verdict).toBe("fail");
		expect(fading.fading).toBe(true);
		const fine = holder(snaps({ wlan1: run(4, { pps: 100, deliver: 0.95 }) }));
		expect(fine.verdict).toBe("pass");
		expect(fine.fading).toBe(false);
	});

	test("a holder dropping to 80 % is called fading within 4 s", () => {
		let after = -1;
		for (let n = 12; n <= 25 && after < 0; n++) {
			const s = snaps({
				wlan1: run(n, { pps: 40, deliver: (t) => (t > 11 ? 0.8 : 1) }),
			});
			if (holder(s).fading) after = n - 11;
		}
		expect(after).toBeGreaterThan(0);
		expect(after).toBeLessThanOrEqual(4);
	});

	test("a just-proven link is not fading at once (hysteresis)", () => {
		expect(
			holder(snaps({ wlan1: run(4, { pps: 100, deliver: 0.92 }) })).fading,
		).toBe(false);
	});
});

describe("common-target witness", () => {
	const pair = new Set(["wlan1", "wlan2"]);

	test("a failing link outside the pair is a witness", () => {
		const s = snaps(
			{ wlan1: run(4, { pps: 40 }), wlan2: run(4, { pps: 40 }) },
			{ "modem-a": run(4, { pps: 100, deliver: 0.5 }) },
		);
		expect(independentLinkFailed(s, pair)).toBe(true);
	});

	test("a link between the fade and proof ratios is no witness", () => {
		const s = snaps(
			{ wlan1: run(4, { pps: 40 }), wlan2: run(4, { pps: 40 }) },
			{ "modem-a": run(4, { pps: 100, deliver: 0.92 }) },
		);
		expect(independentLinkFailed(s, pair)).toBe(false);
	});

	test("the pair itself never counts, and a healthy other link is no witness", () => {
		const s = snaps(
			{
				wlan1: run(4, { pps: 100, deliver: 0.5 }),
				wlan2: run(4, { pps: 100, deliver: 0.5 }),
			},
			{ "modem-a": run(4, { pps: 100 }) },
		);
		expect(independentLinkFailed(s, pair)).toBe(false);
	});

	test("a Wi-Fi-only bond has no witness", () => {
		const s = snaps({
			wlan1: run(4, { pps: 100, deliver: 0.5 }),
			wlan2: run(4, { pps: 100, deliver: 0.5 }),
		});
		expect(independentLinkFailed(s, pair)).toBe(false);
	});
});
