import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	backendTestRunner,
	runTestCommand,
} from "./helpers/run-test-command.ts";

test("a backend test owns its streaming sentinel instead of an inherited session's marker", async () => {
	// Given an unrelated session's marker on a writable runtime filesystem.
	const root = await mkdtemp(join(tmpdir(), "backend-runtime-isolation-"));
	const marker = join(root, "streaming");
	await Bun.write(marker, "foreign-session");
	try {
		// When the unchanged mock-Stop regression runs with the normal preload.
		const result = await runTestCommand(
			[
				process.execPath,
				backendTestRunner,
				"--parallel=2",
				"./src/tests/switch-input-follow.test.ts",
				"-t",
				"5b",
			],
			{
				cwd: fileURLToPath(new URL("../../", import.meta.url)),
				env: { CERALIVE_STREAMING_MARKER: marker },
			},
		);
		// Then the one-broadcast assertion passes without clearing foreign state.
		expect({
			code: result.code,
			output: result.code === 0 ? "" : result.stdout + result.stderr,
		}).toEqual({ code: 0, output: "" });
		expect(await Bun.file(marker).text()).toBe("foreign-session");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test.each(["plain Bun", "the wrapper"])(
	"shared temp writes fail %s even when the test process catches the errors",
	async (mode) => {
		const scratch = await mkdtemp(join(tmpdir(), "temp-guard-regression-"));
		const preload = join(scratch, "escape.ts");
		const escaped = Array.from(
			{ length: 6 },
			() => `/var/tmp/ceraui-escape-${randomUUID()}`,
		);
		try {
			await Bun.write(
				preload,
				`import { writeFileSync, openSync } from "node:fs";
			import { writeFile } from "node:fs/promises";
			import { tmpdir } from "node:os";
			import { basename, join } from "node:path";
			const paths = ${JSON.stringify(escaped)};
			const writes = [
				() => writeFileSync(paths[0], "escape"),
				() => writeFile(paths[1], "escape"),
				() => Bun.write(paths[2], "escape"),
				() => Bun.file(paths[3]).writer().end("escape"),
				() => openSync(paths[4], "w"),
				() => {
					const previous = process.env.TMPDIR;
					process.env.TMPDIR = "/var/tmp";
					try {
						writeFileSync(join(tmpdir(), basename(paths[5])), "escape");
					} finally {
						process.env.TMPDIR = previous;
					}
				},
			];
			for (const write of writes) await Promise.resolve().then(write).catch(() => {});`,
			);
			const result = await runTestCommand(
				[
					process.execPath,
					mode === "plain Bun" ? "test" : backendTestRunner,
					"--parallel=1",
					"--preload",
					preload,
					"./src/tests/crypto.test.ts",
				],
				{
					cwd: fileURLToPath(new URL("../../", import.meta.url)),
					env: {
						TMPDIR: scratch,
						CERAUI_TEST_TEMP_TREE: "",
						CERAUI_TEST_TEMP_ROOT: "",
					},
				},
			);
			if (mode === "the wrapper") expect(result.stderr).toContain("0 fail");
			expect(result.code).toBe(1);
			for (const path of escaped) {
				expect(result.stderr).toContain(`outside its temp root: ${path}`);
				expect(existsSync(path)).toBe(false);
			}
			expect(await readdir(scratch)).toEqual(["escape.ts"]);
		} finally {
			await Promise.all(escaped.map((path) => rm(path, { force: true })));
			await rm(scratch, { recursive: true, force: true });
		}
	},
);

test("the wrapper removes its temp tree when a preload throws", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "temp-abort-regression-"));
	const preload = join(scratch, "throw.ts");
	try {
		await Bun.write(preload, 'throw new Error("intentional preload failure");');
		const result = await runTestCommand(
			[
				process.execPath,
				backendTestRunner,
				"--parallel=1",
				"--preload",
				preload,
				"./src/tests/crypto.test.ts",
			],
			{
				cwd: fileURLToPath(new URL("../../", import.meta.url)),
				env: { TMPDIR: scratch },
			},
		);
		expect(result.stderr).toContain("intentional preload failure");
		expect(result.code).toBe(1);
		expect(await readdir(scratch)).toEqual(["throw.ts"]);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});
