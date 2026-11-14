import { afterEach, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../helpers/logger.ts";
import {
	PRIVATE_STATE_FILES,
	tightenPrivateFiles,
} from "../helpers/private-startup.ts";

const dirs: string[] = [];
afterEach(() => {
	mock.restore();
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const dir = fs.mkdtempSync(join(tmpdir(), "private-startup-"));
	dirs.push(dir);
	return dir;
}
test("startup tightens known files without saving contents and logs once", () => {
	const dir = fixture();
	for (const name of PRIVATE_STATE_FILES) {
		fs.writeFileSync(join(dir, name), "unchanged");
		fs.chmodSync(join(dir, name), 0o644);
	}
	const info = spyOn(logger, "info").mockImplementation(() => logger);
	tightenPrivateFiles(dir);
	for (const name of PRIVATE_STATE_FILES) {
		expect(fs.statSync(join(dir, name)).mode & 0o777).toBe(0o600);
		expect(fs.readFileSync(join(dir, name), "utf8")).toBe("unchanged");
	}
	expect(info).toHaveBeenCalledTimes(1);
	tightenPrivateFiles(dir);
	expect(info).toHaveBeenCalledTimes(1);
});
test("startup preserves stricter modes and ignores missing files, directories and symlinks", () => {
	const dir = fixture();
	const outside = join(dir, "outside");
	fs.writeFileSync(outside, "secret");
	fs.chmodSync(outside, 0o644);
	fs.symlinkSync(outside, join(dir, "config.json"));
	fs.mkdirSync(join(dir, "auth_tokens.json"));
	fs.writeFileSync(join(dir, "hotspot_credentials.json"), "secret");
	fs.chmodSync(join(dir, "hotspot_credentials.json"), 0o400);
	tightenPrivateFiles(dir);
	expect(fs.statSync(outside).mode & 0o777).toBe(0o644);
	expect(fs.lstatSync(join(dir, "config.json")).isSymbolicLink()).toBe(true);
	expect(fs.statSync(join(dir, "hotspot_credentials.json")).mode & 0o777).toBe(
		0o400,
	);
});

test("startup does not traverse a symlink parent for additional paths", () => {
	const dir = fixture();
	const target = join(dir, "target");
	fs.mkdirSync(target);
	const file = join(target, "credentials.json");
	fs.writeFileSync(file, "secret");
	fs.chmodSync(file, 0o644);
	const link = join(dir, "link");
	fs.symlinkSync(target, link);
	tightenPrivateFiles(dir, [join(link, "credentials.json")]);
	expect(fs.statSync(file).mode & 0o777).toBe(0o644);
});
test("startup checks opened file identity before tightening", () => {
	const dir = fixture();
	const file = join(dir, "config.json");
	fs.writeFileSync(file, "original");
	fs.chmodSync(file, 0o644);
	const replacement = join(dir, "replacement");
	fs.writeFileSync(replacement, "replacement");
	fs.chmodSync(replacement, 0o644);
	const open = fs.openSync;
	spyOn(fs, "openSync").mockImplementation((path, flags) => {
		if (path === file) fs.renameSync(replacement, file);
		return open(path, flags);
	});
	tightenPrivateFiles(dir);
	expect(fs.statSync(file).mode & 0o777).toBe(0o644);
});

test("startup refuses a symlink substituted during open before fstat", () => {
	const dir = fixture();
	const file = join(dir, "config.json");
	const retained = join(dir, "retained");
	fs.writeFileSync(file, "original");
	fs.chmodSync(file, 0o644);
	const open = fs.openSync;
	const fstat = spyOn(fs, "fstatSync");
	spyOn(fs, "openSync").mockImplementation((path, flags) => {
		if (path === file) {
			fs.renameSync(file, retained);
			fs.symlinkSync(retained, file);
		}
		return open(path, flags);
	});
	tightenPrivateFiles(dir);
	// The symlink points to the original inode: identity alone cannot reject it.
	expect(fstat).toHaveBeenCalledTimes(0);
	expect(fs.statSync(retained).mode & 0o777).toBe(0o644);
});

test("startup tightens the opened descriptor after the path changes during fstat", () => {
	const dir = fixture();
	const file = join(dir, "config.json");
	const retained = join(dir, "retained");
	const unrelated = join(dir, "unrelated");
	fs.writeFileSync(file, "original");
	fs.writeFileSync(unrelated, "unrelated");
	fs.chmodSync(file, 0o644);
	fs.chmodSync(unrelated, 0o644);
	const fstat = fs.fstatSync;
	let swapped = false;
	spyOn(fs, "fstatSync").mockImplementation((fd) => {
		const current = fstat(fd);
		if (!swapped) {
			swapped = true;
			fs.renameSync(file, retained);
			fs.symlinkSync(unrelated, file);
		}
		return current;
	});
	tightenPrivateFiles(dir);
	expect(swapped).toBe(true);
	expect(fs.statSync(retained).mode & 0o777).toBe(0o600);
	expect(fs.statSync(unrelated).mode & 0o777).toBe(0o644);
	expect(fs.readFileSync(retained, "utf8")).toBe("original");
});
