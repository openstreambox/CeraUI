import { describe, expect, test } from "bun:test";
import {
	classifyHolder,
	classifyUplink,
	diversityAgainst,
	FRESH_SEARCH_CLOCK,
	joinCooldownMs,
	DEFAULT_SEARCH_POLICY as P,
	pickCandidate,
	proactiveInterval,
	type ScanRow,
	searchDue,
	signalSlope,
} from "./policy.ts";

const health = (
	signalDbm: number | null,
	attributedBps: number | null = null,
	encoderBps: number | null = null,
	nakRatio: number | null = null,
) => ({ signalDbm, attributedBps, encoderBps, nakRatio });

describe("holder condition", () => {
	test("good signal with no rate evidence is headroom", () => {
		expect(classifyHolder(health(-55), null)).toBe("headroom");
	});
	test("good signal but only 1.3x the encoder rate is steady", () => {
		expect(classifyHolder(health(-55, 1_300_000, 1_000_000), null)).toBe(
			"steady",
		);
	});
	test("1.5x the encoder rate with low loss is headroom", () => {
		expect(classifyHolder(health(-60, 1_500_000, 1_000_000, 0.01), null)).toBe(
			"headroom",
		);
	});
	test("each fade signal alone is a fade", () => {
		expect(classifyHolder(health(-70), null)).toBe("fade");
		expect(classifyHolder(health(-55), -1.2)).toBe("fade");
		expect(classifyHolder(health(-55, 1_100_000, 1_000_000), null)).toBe(
			"fade",
		);
		expect(classifyHolder(health(-55, null, null, 0.06), null)).toBe("fade");
	});
	test("unknown signal is never headroom", () => {
		expect(classifyHolder(health(null, 3e6, 1e6, 0), null)).toBe("steady");
	});
	test("between the thresholds is steady", () => {
		expect(classifyHolder(health(-68), null)).toBe("steady");
	});
});

describe("signal slope", () => {
	test("a steady 1.5 dB/s decline", () => {
		const samples = [0, 2000, 4000, 6000, 8000, 10000].map((at) => ({
			at,
			dbm: -50 - (1.5 * at) / 1000,
		}));
		expect(signalSlope(samples, 10_000, 10_000)).toBeCloseTo(-1.5, 6);
	});
	test("too few or too short is unknown", () => {
		expect(signalSlope([{ at: 0, dbm: -50 }], 0, 10_000)).toBeNull();
		const short = [0, 500, 1000].map((at) => ({ at, dbm: -50 }));
		expect(signalSlope(short, 1000, 10_000)).toBeNull();
	});
});

describe("search cadence", () => {
	test("first search is due at once, steady never", () => {
		expect(searchDue(0, "headroom", FRESH_SEARCH_CLOCK)).toBe(true);
		expect(searchDue(0, "steady", FRESH_SEARCH_CLOCK)).toBe(false);
	});
	test("proactive interval doubles while searches find nothing, capped", () => {
		const clock = (emptySearches: number) => ({
			...FRESH_SEARCH_CLOCK,
			lastSearchAt: 0,
			emptySearches,
		});
		expect(proactiveInterval(clock(0))).toBe(60_000);
		expect(proactiveInterval(clock(1))).toBe(120_000);
		expect(proactiveInterval(clock(9))).toBe(P.maxBackoffMs);
		expect(searchDue(119_999, "headroom", clock(1))).toBe(false);
		expect(searchDue(120_000, "headroom", clock(1))).toBe(true);
	});
	test("a fade expedites past the back-off, but not inside 15 s", () => {
		const clock = { ...FRESH_SEARCH_CLOCK, lastSearchAt: 0, emptySearches: 5 };
		expect(searchDue(14_999, "fade", clock)).toBe(false);
		expect(searchDue(15_000, "fade", clock)).toBe(true);
	});
	test("a join cooldown blocks every trigger", () => {
		const clock = { ...FRESH_SEARCH_CLOCK, notBefore: 20_000 };
		expect(searchDue(19_999, "fade", clock)).toBe(false);
	});
	test("cooldowns 20, 40, 80, 120 s", () => {
		expect([1, 2, 3, 4, 7].map(joinCooldownMs)).toEqual([
			20_000, 40_000, 80_000, 120_000, 120_000,
		]);
	});
});

describe("uplink diversity", () => {
	const up = (
		gateway: string | null,
		gatewayMac: string | null,
		subnet: string | null,
		egress: string | null = null,
	) => ({ gateway, gatewayMac, subnet, egress });
	test("egress decides when both are known", () => {
		expect(
			classifyUplink(up("a", "m1", "s1", "e1"), up("a", "m1", "s1", "e2")),
		).toBe("diverse");
		expect(
			classifyUplink(up("a", "m1", "s1", "e1"), up("b", "m2", "s2", "e1")),
		).toBe("same-uplink");
	});
	test("one SSID on two routers: different gateway MAC is distinct", () => {
		expect(
			classifyUplink(
				up("192.0.2.1", "02:00:00:00:00:01", "192.0.2.0/24"),
				up("192.0.2.1", "02:00:00:00:00:02", "192.0.2.0/24"),
			),
		).toBe("distinct-gateway");
	});
	test("two SSIDs on one router: same gateway MAC is the same uplink", () => {
		expect(
			classifyUplink(
				up("192.0.2.1", "02:00:00:00:00:01", "192.0.2.0/24"),
				up("198.51.100.1", "02:00:00:00:00:01", "198.51.100.0/24"),
			),
		).toBe("same-uplink");
	});
	test("same gateway and subnet with a gateway MAC missing is unknown, not one uplink", () => {
		expect(
			classifyUplink(
				up("192.168.0.1", null, "192.168.0.0/24"),
				up("192.168.0.1", "02:00:00:00:00:02", "192.168.0.0/24"),
			),
		).toBe("unknown");
		expect(
			classifyUplink(
				up("192.168.0.1", null, "192.168.0.0/24"),
				up("192.168.0.1", null, "192.168.0.0/24"),
			),
		).toBe("unknown");
	});
	test("against several holders the least diverse relation counts", () => {
		const path = up("g2", "m2", "s2");
		expect(
			diversityAgainst(path, [up("g1", "m1", "s1"), up("g3", "m2", "s3")]),
		).toBe("same-uplink");
		expect(diversityAgainst(path, [])).toBe("unknown");
	});
});

describe("candidate choice", () => {
	const row = (bssid: string, ssid: string, quality: number): ScanRow => ({
		bssid,
		ssid,
		quality,
		channel: 6,
	});
	const ctx = (
		goal: "continuity" | "diversity" | "capacity",
		saved: string[] = [],
		learned: Array<
			[string, "same-uplink" | "diverse" | "distinct-gateway" | "unknown"]
		> = [],
	) => ({
		goal,
		holderBssids: new Set(["AA:00:00:00:00:01"]),
		savedSsids: new Set(["venue", ...saved]),
		learned: new Map(learned),
	});
	test("never the holder's BSSID, in any letter case, except for capacity", () => {
		const rows = [row("aa:00:00:00:00:01", "venue", 90)];
		expect(pickCandidate(rows, ctx("continuity"))).toBeUndefined();
		expect(pickCandidate(rows, ctx("diversity"))).toBeUndefined();
		expect(pickCandidate(rows, ctx("capacity"))?.bssid).toBe(
			"aa:00:00:00:00:01",
		);
	});
	test("continuity takes the strongest usable BSSID", () => {
		const pick = pickCandidate(
			[
				row("aa:00:00:00:00:01", "venue", 60),
				row("bb:00:00:00:00:02", "venue", 55),
				row("cc:00:00:00:00:03", "home", 70),
			],
			ctx("continuity", ["home"]),
		);
		expect(pick?.bssid).toBe("cc:00:00:00:00:03");
	});
	test("diversity prefers a BSSID learned to be on another uplink", () => {
		const pick = pickCandidate(
			[
				row("aa:00:00:00:00:01", "venue", 60),
				row("bb:00:00:00:00:02", "venue", 70),
				row("cc:00:00:00:00:03", "home", 55),
			],
			ctx("diversity", ["home"], [["cc:00:00:00:00:03", "diverse"]]),
		);
		expect(pick?.bssid).toBe("cc:00:00:00:00:03");
	});
	test("diversity skips a BSSID known to share the holder's uplink", () => {
		const pick = pickCandidate(
			[row("bb:00:00:00:00:02", "venue", 90)],
			ctx("diversity", [], [["bb:00:00:00:00:02", "same-uplink"]]),
		);
		expect(pick).toBeUndefined();
	});
	test("capacity prefers a fresh BSSID over the holder's own", () => {
		const pick = pickCandidate(
			[
				row("aa:00:00:00:00:01", "venue", 90),
				row("bb:00:00:00:00:02", "venue", 60),
			],
			ctx("capacity"),
		);
		expect(pick?.bssid).toBe("bb:00:00:00:00:02");
	});
	test("capacity keeps a spare warm on another AP, even a weaker one on the same uplink", () => {
		const pick = pickCandidate(
			[
				row("aa:00:00:00:00:01", "venue", 90),
				row("bb:00:00:00:00:02", "venue", 45),
			],
			ctx("capacity", [], [["bb:00:00:00:00:02", "same-uplink"]]),
		);
		expect(pick?.bssid).toBe("bb:00:00:00:00:02");
	});
	test("capacity still takes a more diverse fresh BSSID over a stronger fresh one", () => {
		const pick = pickCandidate(
			[
				row("bb:00:00:00:00:02", "venue", 80),
				row("cc:00:00:00:00:03", "home", 50),
			],
			ctx("capacity", ["home"], [["cc:00:00:00:00:03", "diverse"]]),
		);
		expect(pick?.bssid).toBe("cc:00:00:00:00:03");
	});
	test("the holder's SSID is no candidate without a profile bound to this radio", () => {
		expect(
			pickCandidate([row("bb:00:00:00:00:02", "venue", 90)], {
				...ctx("continuity"),
				savedSsids: new Set(["home"]),
			}),
		).toBeUndefined();
	});
	test("a BSSID that failed recently goes behind the others, and alone is retried", () => {
		const rows = [
			row("bb:00:00:00:00:02", "venue", 80),
			row("cc:00:00:00:00:03", "home", 60),
		];
		const failures = new Map([["bb:00:00:00:00:02", 1]]);
		for (const goal of ["continuity", "diversity", "capacity"] as const)
			expect(
				pickCandidate(rows, { ...ctx(goal, ["home"]), failures })?.bssid,
			).toBe("cc:00:00:00:00:03");
		expect(
			pickCandidate([row("bb:00:00:00:00:02", "venue", 80)], {
				...ctx("continuity"),
				failures,
			})?.bssid,
		).toBe("bb:00:00:00:00:02");
	});
	test("networks without a saved profile are never candidates", () => {
		expect(
			pickCandidate([row("cc:00:00:00:00:03", "cafe", 90)], ctx("continuity")),
		).toBeUndefined();
	});
	test("too weak, or more than 10 below the holder's BSSID, is no candidate", () => {
		expect(
			pickCandidate([row("bb:00:00:00:00:02", "venue", 39)], ctx("continuity")),
		).toBeUndefined();
		const vs = (q: number) =>
			pickCandidate(
				[
					row("aa:00:00:00:00:01", "venue", 80),
					row("bb:00:00:00:00:02", "venue", q),
				],
				ctx("continuity"),
			)?.bssid;
		expect(vs(69)).toBeUndefined();
		expect(vs(70)).toBe("bb:00:00:00:00:02");
	});
});
