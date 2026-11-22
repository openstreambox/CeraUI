import { expect, test } from "bun:test";
import {
	parseAptUpgradeSummary,
	parseUpgradePackageCount,
} from "../modules/system/software-updates.ts";
import { parseRegulatoryDomain } from "../modules/wifi/regdomain.ts";

// Parsers fed by local tool output must stay linear on hostile text. A pattern
// that rescans from every position costs about 16 times more on four times the
// input; a linear one about 4 times. Comparing the two sizes does not depend on
// how fast the machine is. A call under 50 ms at the larger size is too cheap to
// judge, which is where the fixed parsers sit (the old ones took 0.4 s to 1.4 s).
const SMALL = 10_000;
const LARGE = 40_000;
const FLOOR_MS = 50;
const MAX_RATIO = 10;

function elapsed(run: () => unknown): number {
	const start = performance.now();
	run();
	return performance.now() - start;
}

function expectLinear(
	name: string,
	parse: (input: string) => unknown,
	unit: string,
): void {
	const large = elapsed(() => parse(unit.repeat(LARGE)));
	if (large < FLOOR_MS) return;
	const small = Math.max(
		elapsed(() => parse(unit.repeat(SMALL))),
		1,
	);
	expect(
		large / small,
		`${name}: ${small.toFixed(0)} ms at ${SMALL}, ${large.toFixed(0)} ms at ${LARGE}`,
	).toBeLessThan(MAX_RATIO);
}

test("apt package counts do not rescan a long digit run", () => {
	expectLinear("parseUpgradePackageCount", parseUpgradePackageCount, "1");
	expectLinear("parseAptUpgradeSummary", parseAptUpgradeSummary, "1");
	expect(parseUpgradePackageCount("1".repeat(LARGE)).ok).toBe(false);
}, 30_000);

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
}, 30_000);
