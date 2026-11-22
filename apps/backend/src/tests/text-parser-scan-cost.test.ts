import { expect, test } from "bun:test";
import {
	parseAptUpgradeSummary,
	parseUpgradePackageCount,
} from "../modules/system/software-updates.ts";
import { parseRegulatoryDomain } from "../modules/wifi/regdomain.ts";

// Parsers fed by local tool output must stay linear on hostile text. Each input
// below took several seconds before the patterns were bounded; the limit is
// generous so a slow machine cannot trip it.
const LIMIT_MS = 1000;

function elapsed(run: () => void): number {
	const start = performance.now();
	run();
	return performance.now() - start;
}

test("apt package counts do not rescan a long digit run", () => {
	const digits = "1".repeat(100_000);
	expect(elapsed(() => parseUpgradePackageCount(digits))).toBeLessThan(
		LIMIT_MS,
	);
	expect(elapsed(() => parseAptUpgradeSummary(digits))).toBeLessThan(LIMIT_MS);
	expect(parseUpgradePackageCount(digits).ok).toBe(false);
});

test("apt package counts still read the summary line", () => {
	const summary =
		"12 upgraded, 3 newly installed, 0 to remove and 0 not upgraded.";
	expect(parseUpgradePackageCount(summary)).toEqual({ ok: true, value: 15 });
	// A count wider than any real package total is not a count.
	expect(parseUpgradePackageCount(`${"9".repeat(12)} upgraded`).ok).toBe(false);
});

test("regulatory domain does not rescan a long run of blank lines", () => {
	const blanks = "\n".repeat(60_000);
	expect(elapsed(() => parseRegulatoryDomain(blanks))).toBeLessThan(LIMIT_MS);
	expect(parseRegulatoryDomain(`${blanks}country DE: DFS-ETSI\n`)).toBe("DE");
	expect(parseRegulatoryDomain("global\n  country US: DFS-FCC\n")).toBe("US");
	expect(parseRegulatoryDomain("\tcountry 00: DFS-UNSET\r\n")).toBe("00");
});
