import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTestCommand } from "./helpers/run-test-command.ts";

test.each(["legacy", "unavailable", "competing", "write-failure"])(
	"local claim: %s",
	async (scenario) => {
		// Config and token authority both resolve in the child CWD.
		const cwd = mkdtempSync(join(tmpdir(), "local-claim-"));
		try {
			copyFileSync(
				new URL("../../setup.json", import.meta.url),
				join(cwd, "setup.json"),
			);
			const fixture = new URL(
				"./helpers/local-claim-fixture.ts",
				import.meta.url,
			).pathname;
			const result = await runTestCommand(
				[process.execPath, fixture, scenario],
				{
					cwd,
					env: { CERALIVE_LOCAL_CLAIM: scenario === "legacy" ? "0" : "1" },
				},
			);
			expect(result.code, result.stderr + result.stdout).toBe(0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);
