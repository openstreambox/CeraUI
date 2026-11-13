import { describe, expect, test } from "bun:test";
import { exported } from "./support/journal-records.ts";
import { journalSample, sampleSecrets } from "./support/journal-sample.ts";

// The sample is assembled from upstream daemon log formats, not captured from a
// device. It pins how much ordinary evidence the allowlist keeps, so a privacy
// change that silently withholds diagnosis shows up here.
describe("realistic journal sample", () => {
	const output = exported(...journalSample);
	const shown = journalSample.filter(
		(record) => !exported(record).startsWith("[REDACTED"),
	).length;

	test("no sample secret reaches the export", () => {
		for (const secret of sampleSecrets) expect(output).not.toContain(secret);
	});
	test("most fetched records survive as diagnosis", () => {
		expect(journalSample.length).toBe(139);
		expect(shown).toBe(117);
	});
});
