import { afterEach, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { publishStatus, removeLegacyStatus, statusPath } from "./status.ts";

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
		fixture();
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
		expect(rename).toHaveBeenCalledTimes(61);
		expect(rename.mock.calls.every(([, to]) => to === statusPath())).toBe(true);
		expect(sync).toHaveBeenCalledTimes(0);
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

for (const kind of ["regular", "symlink", "directory", "missing"] as const) {
	test(`startup legacy cleanup handles ${kind} without following links`, () => {
		const root = fixture();
		const legacy = join(root, "status.json");
		const target = join(root, "target");
		fs.writeFileSync(target, "keep");
		if (kind === "regular") fs.writeFileSync(legacy, "stale");
		if (kind === "symlink") fs.symlinkSync(target, legacy);
		if (kind === "directory") fs.mkdirSync(legacy);
		const log = mock(() => {});
		removeLegacyStatus(root, log);
		removeLegacyStatus(root, log);
		expect(fs.readFileSync(target, "utf8")).toBe("keep");
		expect(fs.existsSync(legacy)).toBe(
			kind === "symlink" || kind === "directory",
		);
		if (kind === "symlink")
			expect(fs.lstatSync(legacy).isSymbolicLink()).toBe(true);
		expect(log).toHaveBeenCalledTimes(kind === "regular" ? 1 : 0);
	});
}

test("legacy cleanup logs one failure and lets startup continue", () => {
	const root = fixture();
	fs.writeFileSync(join(root, "status.json"), "stale");
	const log = mock(() => {});
	spyOn(fs, "unlinkSync").mockImplementation(() => {
		throw Object.assign(new Error("denied"), { code: "EACCES" });
	});
	expect(() => removeLegacyStatus(root, log)).not.toThrow();
	expect(log).toHaveBeenCalledTimes(1);
	expect(fs.readFileSync(join(root, "status.json"), "utf8")).toBe("stale");
});
