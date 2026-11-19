import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The scenario driver must not be reachable in a production build. The
 * backend's `build` script bundles with `NODE_ENV=production bun build
 * --minify`; Bun inlines the literal `process.env.NODE_ENV` reads. This test
 * runs that bundle step (without `--compile`, which only wraps the same
 * output) and checks two things in each environment:
 *
 * - the shipped bundle (src/main.ts) keeps no driver admission: neither the
 *   upgrade header nor the secret's variable, so no socket can become the
 *   driver, and no `dev` routes;
 * - a probe bundled the same way, then run with a development runtime
 *   environment, mocks on and a driver socket, still has its scenario call
 *   refused as production.
 *
 * The development bundles passing the opposite checks is what makes the
 * production results mean something. Bun keeps unreachable module bodies in
 * its output, so the proof is reachability, not the absence of every byte.
 */
const ADMISSION_MARKERS = [
	"x-ceraui-scenario-secret", // rpc/scenario-driver-admission.ts
	"CERAUI_SCENARIO_SECRET", // rpc/server.ts
	"rebindWifi", // a dev route name in rpc/router.ts
];

const backendDir = resolve(import.meta.dir, "../..");
const repoDir = resolve(backendDir, "../..");
let outDir = "";

async function run(
	argv: string[],
	env: Record<string, string>,
): Promise<string> {
	const child = Bun.spawn(argv, {
		cwd: outDir,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0)
		throw new Error(`${argv.join(" ")} failed (${code}): ${stderr}`);
	return stdout;
}

async function bundle(entry: string, nodeEnv: string): Promise<string> {
	const outfile = join(outDir, `${nodeEnv}-${entry.replace(/\W+/g, "-")}.js`);
	await run(
		[
			process.execPath,
			"build",
			"--minify",
			"--target=bun",
			resolve(backendDir, entry),
			"--outfile",
			outfile,
		],
		{ NODE_ENV: nodeEnv },
	);
	return outfile;
}

beforeAll(async () => {
	outDir = await mkdtemp(join(tmpdir(), "ceraui-scenario-build-"));
	// The probe runs here; the backend's modules read setup.json from the cwd.
	await copyFile(join(backendDir, "setup.json"), join(outDir, "setup.json"));
});

afterAll(async () => {
	if (outDir) await rm(outDir, { recursive: true, force: true });
});

test(
	"the production bundle keeps no scenario driver admission and no dev routes",
	async () => {
		const [production, development] = await Promise.all(
			["production", "development"].map(async (env) =>
				readFile(await bundle("src/main.ts", env), "utf8"),
			),
		);
		for (const marker of ADMISSION_MARKERS) {
			expect({ marker, development: development.includes(marker) }).toEqual({
				marker,
				development: true,
			});
			expect({ marker, production: production.includes(marker) }).toEqual({
				marker,
				production: false,
			});
		}
	},
	{ timeout: 120_000 },
);

test(
	"a production-built scenario call is refused even with a development runtime and a driver socket",
	async () => {
		// The probe's report is its last stdout line; the backend logger writes
		// to stdout too.
		const lastLine = (out: string) => out.trimEnd().split("\n").at(-1) ?? "";
		const probe = async (nodeEnv: string, runtime = "development") =>
			JSON.parse(
				lastLine(
					await run(
						[
							process.execPath,
							"--preload",
							resolve(repoDir, "scripts/dev-safety.ts"),
							await bundle("src/tests/fixtures/dev-scenario-probe.ts", nodeEnv),
						],
						{ NODE_ENV: runtime, MOCK_MODE: "true" },
					),
				),
			);
		expect(await probe("development", "production")).toEqual({
			apply: { success: false, refused: "production" },
			admission: false,
			routes: false,
			handlers: [false, false, false],
		});
		expect(await probe("production", "production")).toEqual({
			apply: { success: false, refused: "production" },
			admission: false,
			routes: false,
			handlers: [false, false, false],
		});
		expect(await probe("production")).toEqual({
			apply: { success: false, refused: "production" },
			admission: false,
			routes: false,
			handlers: [false, false, false],
		});
		expect(await probe("development")).toMatchObject({
			apply: { success: true, status: { pinned: true, seed: 1, t_ms: 0 } },
			admission: true,
			routes: true,
			handlers: [true, true, true],
		});
	},
	{ timeout: 120_000 },
);
