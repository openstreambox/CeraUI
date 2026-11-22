import { expect, test } from "bun:test";
import {
	parseAptUpgradeSummary,
	parseUpgradePackageCount,
} from "../modules/system/software-updates.ts";
import { parseRegulatoryDomain } from "../modules/wifi/regdomain.ts";

// Parsers fed by local tool output must stay linear on hostile text. A pattern
// that rescans from every position costs about 16 times more on four times the
// input; a linear one about 4 times. Comparing the two sizes does not depend on
// how fast the machine is.
//
// Each size is the median of several samples, so one garbage collection or
// scheduling pause cannot decide the result. A parser that is too cheap to time
// at the starting size is tried on larger input (up to 8 times as much) before
// it counts as fast, so a quadratic parser that happens to be quick on 40,000
// characters is still caught.
const LARGE = 40_000;
const SCALES = [1, 4, 8];
const SCREEN_MS = 10;
const SAMPLES = 5;
const MAX_RATIO = 10;

function once(parse: (input: string) => unknown, input: string): number {
	const start = performance.now();
	try {
		parse(input);
	} catch {
		// rejecting the input is fine; only the cost matters here
	}
	return performance.now() - start;
}

function median(parse: (input: string) => unknown, input: string): number {
	const samples = Array.from({ length: SAMPLES }, () => once(parse, input));
	samples.sort((a, b) => a - b);
	return samples[Math.floor(SAMPLES / 2)] ?? 0;
}

function expectLinear(
	name: string,
	parse: (input: string) => unknown,
	unit: string,
): void {
	for (const scale of SCALES) {
		const size = LARGE * scale;
		const large = unit.repeat(size);
		// The first call also warms the parser up.
		if (once(parse, large) < SCREEN_MS) continue;
		const largeMs = median(parse, large);
		const smallMs = Math.max(median(parse, unit.repeat(size / 4)), 1);
		expect(
			largeMs / smallMs,
			`${name}: ${smallMs.toFixed(0)} ms at ${size / 4}, ${largeMs.toFixed(0)} ms at ${size}`,
		).toBeLessThan(MAX_RATIO);
		return;
	}
}

test("apt package counts do not rescan a long digit run", () => {
	expectLinear("parseUpgradePackageCount", parseUpgradePackageCount, "1");
	expectLinear("parseAptUpgradeSummary", parseAptUpgradeSummary, "1");
	expect(parseUpgradePackageCount("1".repeat(LARGE)).ok).toBe(false);
}, 60_000);

test("apt package counts still read the summary line", () => {
	const summary =
		"12 upgraded, 3 newly installed, 0 to remove and 0 not upgraded.";
	expect(parseUpgradePackageCount(summary)).toEqual({ ok: true, value: 15 });
});

test("apt package counts wider than nine digits are not counts", () => {
	// Neither count may be read from the tail of a longer digit run.
	expect(
		parseUpgradePackageCount("1234567890 upgraded, 1 newly installed").ok,
	).toBe(false);
	expect(
		parseUpgradePackageCount("12 upgraded, 123456789012 newly installed").ok,
	).toBe(false);
	expect(
		parseUpgradePackageCount("999999999 upgraded, 1 newly installed"),
	).toEqual({ ok: true, value: 1_000_000_000 });
});

test("regulatory domain does not rescan a long run of blank lines", () => {
	expectLinear("parseRegulatoryDomain", parseRegulatoryDomain, "\n");
	const blanks = "\n".repeat(LARGE);
	expect(parseRegulatoryDomain(`${blanks}country DE: DFS-ETSI\n`)).toBe("DE");
	expect(parseRegulatoryDomain("global\n  country US: DFS-FCC\n")).toBe("US");
	expect(parseRegulatoryDomain("\tcountry 00: DFS-UNSET\r\n")).toBe("00");
}, 60_000);
