import { test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fc from "fast-check";
import { logger } from "../../helpers/logger.ts";

function integerFromEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
	return value;
}

export const json = fc.jsonValue({ maxDepth: 3 });
export const text = fc.string({ maxLength: 64, unit: "grapheme" });
export const seed = integerFromEnv("PARSER_FUZZ_SEED", 146701);
export const numRuns = integerFromEnv("PARSER_FUZZ_RUNS", 128);

// fast-check reports the minimized input and replay path on failure. A path
// applies to one property, selected with bun test -t. PARSER_FUZZ_SEED and
// PARSER_FUZZ_RUNS change the seed and the run count; PARSER_FUZZ_REPORT=1
// prints the seed and elapsed time of each property.
export function fuzz<T>(
	name: string,
	input: fc.Arbitrary<T>,
	check: (value: T) => void | Promise<void>,
): void {
	test(name, async () => {
		const start = performance.now();
		const silent = logger.silent;
		logger.silent = true;
		try {
			// A run stopped by the time limit is a pass with fewer runs; the report
			// line says how many ran.
			const details = await fc.check(
				fc.asyncProperty(input, async (value) => check(value)),
				{
					seed,
					numRuns,
					...(process.env.PARSER_FUZZ_PATH
						? { path: process.env.PARSER_FUZZ_PATH }
						: {}),
					interruptAfterTimeLimit: 55_000,
					markInterruptAsFailure: false,
				},
			);
			if (process.env.PARSER_FUZZ_REPORT === "1")
				process.stderr.write(
					`fuzz ${name}: seed=${seed} runs=${details.numRuns} interrupted=${details.interrupted} elapsed_ms=${Math.round(performance.now() - start)}\n`,
				);
			if (details.failed) throw new Error(fc.defaultReportMessage(details));
		} finally {
			logger.silent = silent;
		}
	}, 60_000);
}

export async function scratch<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "ceraui-fuzz-"));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
