import { afterEach, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { publishStatus, statusPath } from "./status.ts";

const dirs: string[] = [];
const previous = process.env.CERALIVE_RUN_DIR;
afterEach(() => {
	mock.restore();
	if (previous === undefined) delete process.env.CERALIVE_RUN_DIR;
	else process.env.CERALIVE_RUN_DIR = previous;
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const dir = fs.mkdtempSync(join(tmpdir(), "two-radio-status-"));
	dirs.push(dir);
	process.env.CERALIVE_RUN_DIR = join(dir, "run");
	return dir;
}
test("production status lives under /run", () => {
	delete process.env.CERALIVE_RUN_DIR;
	expect(statusPath()).toBe("/run/ceralive/two-radio/status.json");
});
for (const error of [false, true]) {
	test(`60 seconds of unchanged policy with changing rounds writes only runtime status (error=${error})`, () => {
		const dir = fixture();
		const config = join(dir, "config", "two-radio");
		fs.mkdirSync(config, { recursive: true });
		const legacy = join(config, "status.json");
		fs.writeFileSync(legacy, "legacy diagnostic");
		const rename = spyOn(fs, "renameSync");
		const sync = spyOn(fs, "fsyncSync");
		for (let second = 0; second <= 60; second++) {
			const state = {
				holder: "a",
				now: second * 1000,
				closedRounds: [`round-${second}`],
			};
			publishStatus(
				error
					? { session: "session", error: "reconcile", state }
					: { session: "session", ...state },
			);
		}
		expect(
			rename.mock.calls.filter(([, to]) => String(to).startsWith(config)),
		).toHaveLength(0);
		expect(rename).toHaveBeenCalledTimes(61);
		expect(rename.mock.calls.every(([, to]) => to === statusPath())).toBe(true);
		expect(sync).toHaveBeenCalledTimes(0);
		expect(fs.readFileSync(legacy, "utf8")).toBe("legacy diagnostic");
		const saved = JSON.parse(fs.readFileSync(statusPath(), "utf8"));
		expect((error ? saved.state : saved).now).toBe(60_000);
		expect(fs.statSync(statusPath()).mode & 0o777).toBe(0o600);
		expect(fs.statSync(dirname(statusPath())).mode & 0o777).toBe(0o700);
	});
}
test("identical runtime snapshots still skip replacement", () => {
	fixture();
	const rename = spyOn(fs, "renameSync");
	for (let second = 0; second <= 60; second++)
		publishStatus({ session: "session", holder: "a" });
	expect(rename).toHaveBeenCalledTimes(1);
});
