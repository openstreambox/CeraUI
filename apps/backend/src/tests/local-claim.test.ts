import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTestCommand } from "./helpers/run-test-command.ts";

const fixture = new URL("./helpers/local-claim-fixture.ts", import.meta.url)
	.pathname;

async function runScenarios(...scenarios: string[]) {
	// Config and token authority both resolve in the child CWD. Each scenario is
	// its own process, so a sequence of them is a real restart.
	const cwd = mkdtempSync(join(tmpdir(), "local-claim-"));
	try {
		copyFileSync(
			new URL("../../setup.json", import.meta.url),
			join(cwd, "setup.json"),
		);
		for (const scenario of scenarios) {
			const result = await runTestCommand(
				[process.execPath, fixture, scenario],
				{
					cwd,
					env: { CERALIVE_LOCAL_CLAIM: scenario === "legacy" ? "0" : "1" },
				},
			);
			expect(result.code, `${scenario}: ${result.stderr}${result.stdout}`).toBe(
				0,
			);
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

test.each([
	"legacy",
	"unavailable",
	"competing",
	"pre-rename",
	"post-rename",
	"stale-peers",
])("local claim: %s", (scenario) => runScenarios(scenario));

test(
	"local claim: config recovers after an unreadable post-failure state",
	() => runScenarios("unreadable-after-failure"),
	20_000,
);

test.each(["restart-claim", "restart-post-rename"])(
	"local claim: %s survives a real restart",
	(scenario) => runScenarios(scenario, "restart-verify"),
	20_000,
);
