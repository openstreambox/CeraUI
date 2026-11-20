import { describe, expect, test } from "bun:test";
import {
	ageBoundMs,
	evaluateCandidate,
	evaluateHolder,
	independentLinkFailed,
	lagSamples,
	PROOF_POLICY,
} from "./proof.ts";
import type { LinkSample, Snapshot } from "./sender-links.ts";

const base: LinkSample = {
	epoch: 1,
	connected: true,
	timedOut: false,
	queued: 0,
	entries: 0,
	ageMs: 100,
	rttMs: 30,
	gated: false,
	gatedBy: null,
	ccTargetBps: null,
	ccLossPermille: null,
};

type Run = Readonly<{
	pps: number;
	/** Share of queued packets the receiver acknowledges. */
	deliver?: number;
	/** Seconds the ACK side lags the queue side. */
	lagS?: number;
	ageMs?: number;
	over?: Partial<LinkSample>;
}>;

/** One link, sampled once a second for `seconds`, in receiver batches of 10. */
function run(seconds: number, r: Run): LinkSample[] {
	const out: LinkSample[] = [];
	for (let t = 0; t <= seconds; t++) {
		const queued = r.pps * t;
		const arrived = Math.max(0, r.pps * (t - (r.lagS ?? 1)));
		const entries = Math.floor(((r.deliver ?? 1) * arrived) / 10) * 10;
		out.push({ ...base, queued, entries, ageMs: r.ageMs ?? 100, ...r.over });
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
		out.push({
			at: 10_000 + i * 1_000,
			radios: pick(radios),
			others: pick(others),
			negotiatedLatencyMs: latencyMs,
		});
	}
	return out;
}

const ctx = { carrying: 1, encoderBps: null, preFadeBondPacketsPerS: null };

describe("candidate proof", () => {
	test("a link that delivers everything it is offered passes after 3 s", () => {
		const s = snaps({ wlan2: run(4, { pps: 40 }) });
		const p = evaluateCandidate(s, "wlan2", ctx);
		expect(p.verdict).toBe("pass");
		expect(p.durationMs).toBe(3_000);
		expect(p.offered).toBe(120);
	});

	test("too short a span is still open", () => {
		const s = snaps({ wlan2: run(3, { pps: 40 }) });
		expect(evaluateCandidate(s, "wlan2", ctx).verdict).toBe("open");
	});

	test("65 % delivery at 40 pkt/s fails (the per-window slack used to pass it)", () => {
		const s = snaps({ wlan2: run(4, { pps: 40, deliver: 0.65 }) });
		expect(evaluateCandidate(s, "wlan2", ctx).verdict).toBe("fail");
	});

	test("the threshold sits near 87 % at 3 s and 40 pkt/s", () => {
		const at = (deliver: number) =>
			evaluateCandidate(
				snaps({ wlan2: run(4, { pps: 40, deliver }) }),
				"wlan2",
				ctx,
			).verdict;
		expect(at(0.8)).toBe("fail");
		expect(at(0.92)).toBe("pass");
	});

	test("a sender gating flag makes it inconclusive, and the span restarts after it", () => {
		const gated = run(6, { pps: 40 });
		gated[6] = { ...(gated[6] as LinkSample), gated: true, gatedBy: "weak" };
		expect(
			evaluateCandidate(snaps({ wlan2: gated }), "wlan2", ctx).verdict,
		).toBe("inconclusive");
		const after = run(8, { pps: 40 });
		after[3] = {
			...(after[3] as LinkSample),
			gated: true,
			gatedBy: "stall_gated",
		};
		// Ungated from sample 4: 4..7 is 3 s, but the entries side needs sample 8.
		expect(
			evaluateCandidate(snaps({ wlan2: after.slice(0, 8) }), "wlan2", ctx)
				.verdict,
		).toBe("open");
		expect(
			evaluateCandidate(snaps({ wlan2: after }), "wlan2", ctx).verdict,
		).toBe("pass");
	});

	test("an epoch change restarts the span", () => {
		const s = run(6, { pps: 40 });
		for (let i = 4; i < s.length; i++)
			s[i] = { ...(s[i] as LinkSample), epoch: 2 };
		expect(evaluateCandidate(snaps({ wlan2: s }), "wlan2", ctx).verdict).toBe(
			"open",
		);
	});

	test("a low-rate link can pass: the age bound follows the batch fill time", () => {
		const s = snaps({ wlan2: run(11, { pps: 8, ageMs: 1_800 }) });
		const p = evaluateCandidate(s, "wlan2", ctx);
		expect(p.verdict).toBe("pass");
		expect(ageBoundMs(8, 30)).toBe(2_530);
	});

	test("a link offered too little over 10 s is inconclusive, not failed", () => {
		const s = snaps({ wlan2: run(12, { pps: 4 }) });
		expect(evaluateCandidate(s, "wlan2", ctx).verdict).toBe("inconclusive");
	});

	test("a busy second with no arrivals fails even if the total catches up", () => {
		const s = run(6, { pps: 40 });
		// The ACKs for second 2 arrive only with second 3's.
		s[3] = { ...(s[3] as LinkSample), entries: (s[2] as LinkSample).entries };
		expect(evaluateCandidate(snaps({ wlan2: s }), "wlan2", ctx).reason).toBe(
			"a busy second with no arrivals",
		);
	});

	test("a stale last ACK fails", () => {
		const s = snaps({ wlan2: run(4, { pps: 40, ageMs: 1_200 }) });
		expect(evaluateCandidate(s, "wlan2", ctx).reason).toBe("last ACK too old");
	});

	test("loss the sender's congestion control sees fails it", () => {
		const s = snaps({
			wlan2: run(4, { pps: 40, over: { ccLossPermille: 20 } }),
		});
		expect(evaluateCandidate(s, "wlan2", ctx).verdict).toBe("fail");
		const ok = snaps({
			wlan2: run(4, { pps: 40, over: { ccLossPermille: 19 } }),
		});
		expect(evaluateCandidate(ok, "wlan2", ctx).verdict).toBe("pass");
	});

	test("a bloated path fails against the SRT latency even if it delivers", () => {
		const s = snaps({ wlan2: run(4, { pps: 40, over: { rttMs: 600 } }) });
		expect(evaluateCandidate(s, "wlan2", ctx).reason).toBe(
			"RTT too large for the SRT latency",
		);
	});

	test("a candidate offered less than 1/N of the bond fails", () => {
		const s = snaps({
			wlan2: run(4, { pps: 20 }),
			wlan1: run(4, { pps: 100 }),
		});
		expect(evaluateCandidate(s, "wlan2", { ...ctx, carrying: 2 }).reason).toBe(
			"offered less than its share of the bond",
		);
		const fair = snaps({
			wlan2: run(4, { pps: 60 }),
			wlan1: run(4, { pps: 60 }),
		});
		expect(
			evaluateCandidate(fair, "wlan2", { ...ctx, carrying: 2 }).verdict,
		).toBe("pass");
	});

	test("headroom uses the sender's capacity estimate when there is one", () => {
		const low = snaps({
			wlan2: run(4, { pps: 40, over: { ccTargetBps: 1_200_000 } }),
		});
		expect(
			evaluateCandidate(low, "wlan2", { ...ctx, encoderBps: 1_000_000 })
				.verdict,
		).toBe("fail");
		const high = snaps({
			wlan2: run(4, { pps: 40, over: { ccTargetBps: 1_300_000 } }),
		});
		const p = evaluateCandidate(high, "wlan2", {
			...ctx,
			encoderBps: 1_000_000,
		});
		expect(p.verdict).toBe("pass");
		expect(p.headroomEstimated).toBe(true);
		const none = evaluateCandidate(
			snaps({ wlan2: run(4, { pps: 40 }) }),
			"wlan2",
			{ ...ctx, encoderBps: 1_000_000 },
		);
		expect(none.verdict).toBe("pass");
		expect(none.headroomEstimated).toBe(false);
	});

	test("the proof records its load and checks it against the pre-fade rate", () => {
		const s = snaps({ wlan2: run(4, { pps: 40 }) });
		const ok = evaluateCandidate(s, "wlan2", {
			...ctx,
			preFadeBondPacketsPerS: 80,
		});
		expect(ok.load?.bondPacketsPerS).toBe(40);
		expect(ok.meetsLoadFloor).toBe(true);
		const low = evaluateCandidate(s, "wlan2", {
			...ctx,
			preFadeBondPacketsPerS: 81,
		});
		expect(low.verdict).toBe("pass");
		expect(low.meetsLoadFloor).toBe(false);
	});

	test("the entries side lags by the RTT in whole samples", () => {
		expect(lagSamples(30)).toBe(1);
		expect(lagSamples(1_500)).toBe(2);
		const slow = snaps({
			wlan2: run(6, { pps: 40, lagS: 2, over: { rttMs: 400 } }),
		});
		expect(evaluateCandidate(slow, "wlan2", ctx).verdict).toBe("fail");
		const slowRtt = snaps({
			wlan2: run(6, { pps: 40, lagS: 2, over: { rttMs: 1_100 } }),
		});
		expect(
			evaluateCandidate(slowRtt, "wlan2", ctx, {
				...PROOF_POLICY,
				latencyShare: 1,
			}).verdict,
		).toBe("pass");
	});
});

describe("holder judgement", () => {
	test("a sender gating flag is a failure for the holder", () => {
		const s = snaps({
			wlan1: run(4, { pps: 40, over: { gated: true, gatedBy: "stall_gated" } }),
		});
		const h = evaluateHolder(s, "wlan1");
		expect(h.verdict).toBe("fail");
		expect(h.dead).toBe(false);
	});

	test("a disconnected holder is dead", () => {
		const s = snaps({ wlan1: run(4, { pps: 40, over: { connected: false } }) });
		expect(evaluateHolder(s, "wlan1").dead).toBe(true);
	});

	test("a holder without ACKs while a sibling gets them is dead", () => {
		const s = snaps({
			wlan1: run(4, { pps: 40, ageMs: 1_600 }),
			wlan2: run(4, { pps: 40, ageMs: 200 }),
		});
		const h = evaluateHolder(s, "wlan1");
		expect(h.dead).toBe(true);
		expect(h.verdict).toBe("fail");
	});

	test("without a fresh sibling, a quiet holder is not called dead", () => {
		const s = snaps({
			wlan1: run(4, { pps: 40, ageMs: 1_600 }),
			wlan2: run(4, { pps: 40, ageMs: 1_600 }),
		});
		expect(evaluateHolder(s, "wlan1").dead).toBe(false);
	});

	test("a cellular link counts as the fresh sibling", () => {
		const s = snaps(
			{ wlan1: run(4, { pps: 40, ageMs: 1_600 }) },
			{ "modem-a": run(4, { pps: 40, ageMs: 200 }) },
		);
		expect(evaluateHolder(s, "wlan1").dead).toBe(true);
	});

	test("delivery below 0.90 is a fade and a failure; 0.95 is fine", () => {
		const fading = evaluateHolder(
			snaps({ wlan1: run(4, { pps: 100, deliver: 0.85 }) }),
			"wlan1",
		);
		expect(fading.verdict).toBe("fail");
		expect(fading.fading).toBe(true);
		const fine = evaluateHolder(
			snaps({ wlan1: run(4, { pps: 100, deliver: 0.95 }) }),
			"wlan1",
		);
		expect(fine.verdict).toBe("pass");
		expect(fine.fading).toBe(false);
	});

	test("a just-proven link is not fading at once (hysteresis)", () => {
		// Passes the 0.95 proof at the boundary, then holds above 0.90.
		const s = snaps({ wlan1: run(4, { pps: 100, deliver: 0.92 }) });
		expect(evaluateHolder(s, "wlan1").fading).toBe(false);
	});
});

describe("common-target witness", () => {
	test("a failing link outside the pair is a witness", () => {
		const s = snaps(
			{ wlan1: run(4, { pps: 40 }), wlan2: run(4, { pps: 40 }) },
			{ "modem-a": run(4, { pps: 100, deliver: 0.5 }) },
		);
		expect(independentLinkFailed(s, new Set(["wlan1", "wlan2"]))).toBe(true);
	});

	test("the pair itself never counts, and a healthy other link is no witness", () => {
		const s = snaps(
			{
				wlan1: run(4, { pps: 100, deliver: 0.5 }),
				wlan2: run(4, { pps: 100, deliver: 0.5 }),
			},
			{ "modem-a": run(4, { pps: 100 }) },
		);
		expect(independentLinkFailed(s, new Set(["wlan1", "wlan2"]))).toBe(false);
	});

	test("a Wi-Fi-only bond has no witness", () => {
		const s = snaps({
			wlan1: run(4, { pps: 100, deliver: 0.5 }),
			wlan2: run(4, { pps: 100, deliver: 0.5 }),
		});
		expect(independentLinkFailed(s, new Set(["wlan1", "wlan2"]))).toBe(false);
	});
});
