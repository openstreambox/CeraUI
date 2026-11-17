import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// External fault tooling drives the steering owner through its dependency
// ports. Those modules must load without backend setup; the composed runtime
// keeps production setup validation.
const PORT_MODULES = [
	"uplink-steering/coordinator",
	"uplink-steering/applier",
	"uplink-steering/route-manager",
	"uplink-steering/verify",
	"uplink-steering/ruleset",
	"uplink-sharing",
];

async function importWithoutSetup(module: string): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "steering-import-"));
	try {
		const url = new URL(`../modules/network/${module}.ts`, import.meta.url)
			.href;
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`try { await import(${JSON.stringify(url)}); console.log("ok"); } catch (error) { console.log(JSON.stringify({ name: error.name })); }`,
			],
			{ cwd, stdout: "pipe", stderr: "pipe" },
		);
		const output = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		return (
			output
				.trim()
				.split("\n")
				.find((line) => line === "ok" || line.startsWith('{"name":')) ?? ""
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

for (const module of PORT_MODULES) {
	it(`imports ${module} without backend setup`, async () => {
		expect(await importWithoutSetup(module)).toBe("ok");
	});
}

it("keeps setup validation in the composed steering runtime", async () => {
	expect(await importWithoutSetup("uplink-steering/runtime")).toBe(
		JSON.stringify({ name: "ZodError" }),
	);
});
