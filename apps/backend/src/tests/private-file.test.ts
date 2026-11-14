import { afterEach, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	writeFileAtomicSync,
	writePrivateStatusSync,
} from "../helpers/config-loader.ts";

const dirs: string[] = [];
afterEach(() => {
	mock.restore();
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const dir = fs.mkdtempSync(join(tmpdir(), "private-writer-"));
	dirs.push(dir);
	fs.chmodSync(dir, 0o755);
	return { dir, file: join(dir, "state.json") };
}
for (const previous of [undefined, 0o644, 0o600, 0o400, 0o200, 0o000]) {
	test(`private replacement preserves permissions for ${previous?.toString(8) ?? "new"} file under 0022`, () => {
		const { dir, file } = fixture();
		if (previous !== undefined) {
			fs.writeFileSync(file, "old");
			fs.chmodSync(file, previous);
		}
		const mask = process.umask(0o022);
		try {
			writeFileAtomicSync(file, "synthetic secret", { mode: 0o600 });
		} finally {
			process.umask(mask);
		}
		expect(fs.statSync(file).mode & 0o777).toBe((previous ?? 0o600) & 0o600);
		fs.chmodSync(file, 0o600);
		expect(fs.readFileSync(file, "utf8")).toBe("synthetic secret");
		expect(fs.readdirSync(dir)).toEqual(["state.json"]);
	});
}
test("does not reuse a stale predictable temporary file", () => {
	const { dir, file } = fixture();
	const stale = join(dir, `.state.json.${process.pid}.tmp`);
	fs.writeFileSync(stale, "unrelated");
	fs.chmodSync(stale, 0o644);
	writeFileAtomicSync(file, "synthetic secret", { mode: 0o600 });
	expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	expect(fs.readFileSync(stale, "utf8")).toBe("unrelated");
});
for (const operation of [
	"fchmodSync",
	"writeFileSync",
	"fsyncSync",
	"renameSync",
] as const) {
	test(`cleans its temporary file after ${operation} failure`, () => {
		const { dir, file } = fixture();
		fs.writeFileSync(file, "original");
		const failure = spyOn(fs, operation).mockImplementation(() => {
			throw new Error("synthetic I/O failure");
		});
		expect(() =>
			writeFileAtomicSync(file, "synthetic secret", { mode: 0o600 }),
		).toThrow("synthetic I/O failure");
		failure.mockRestore();
		expect(fs.readFileSync(file, "utf8")).toBe("original");
		expect(fs.readdirSync(dir)).toEqual(["state.json"]);
	});
}
test("sets private mode before writing and syncs file before rename and directory after", () => {
	const { file } = fixture();
	const events: string[] = [];
	const write = fs.writeFileSync;
	const sync = fs.fsyncSync;
	const rename = fs.renameSync;
	spyOn(fs, "writeFileSync").mockImplementation((fd, contents) => {
		expect(typeof fd).toBe("number");
		expect(fs.fstatSync(fd as number).mode & 0o777).toBe(0o600);
		events.push("write");
		write(fd, contents);
	});
	spyOn(fs, "fsyncSync").mockImplementation((fd) => {
		events.push(
			fs.fstatSync(fd).isDirectory() ? "directory sync" : "file sync",
		);
		sync(fd);
	});
	spyOn(fs, "renameSync").mockImplementation((from, to) => {
		events.push("rename");
		rename(from, to);
	});
	writeFileAtomicSync(file, "synthetic secret", { mode: 0o600 });
	expect(events).toEqual(["write", "file sync", "rename", "directory sync"]);
});
for (const mask of [0o002, 0o077]) {
	test(`private creation under umask ${mask.toString(8)}`, () => {
		const { file } = fixture();
		const old = process.umask(mask);
		try {
			writeFileAtomicSync(file, "synthetic secret", { mode: 0o600 });
		} finally {
			process.umask(old);
		}
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	});
}
test("refuses a symlink target", () => {
	const { dir, file } = fixture();
	const other = join(dir, "other");
	fs.writeFileSync(other, "unchanged");
	fs.symlinkSync(other, file);
	expect(() =>
		writeFileAtomicSync(file, "synthetic secret", { mode: 0o600 }),
	).toThrow();
	expect(fs.readFileSync(other, "utf8")).toBe("unchanged");
});

test("staged publishers retain the final target's stricter permissions", () => {
	const { dir, file } = fixture();
	fs.writeFileSync(file, "original");
	fs.chmodSync(file, 0o400);
	const stage = join(dir, "stage");
	writeFileAtomicSync(stage, "synthetic secret", {
		mode: 0o600,
		permissionSource: file,
	});
	fs.renameSync(stage, file);
	expect(fs.statSync(file).mode & 0o777).toBe(0o400);
});
test("a public cache keeps the generic writer's mode", async () => {
	const { file } = fixture();
	const { writeTextFileAtomic } = await import("../helpers/text-files.ts");
	const mask = process.umask(0o022);
	try {
		expect(writeTextFileAtomic(file, "public cache")).toBe(true);
	} finally {
		process.umask(mask);
	}
	expect(fs.statSync(file).mode & 0o777).toBe(0o644);
});

test("reports directory sync failure after publishing private bytes", () => {
	const { dir, file } = fixture();
	const sync = fs.fsyncSync;
	spyOn(fs, "fsyncSync").mockImplementation((fd) => {
		if (fs.fstatSync(fd).isDirectory())
			throw new Error("directory sync failed");
		sync(fd);
	});
	expect(() =>
		writeFileAtomicSync(file, "synthetic secret", { mode: 0o600 }),
	).toThrow("directory sync failed");
	expect(fs.readFileSync(file, "utf8")).toBe("synthetic secret");
	expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	expect(fs.readdirSync(dir)).toEqual(["state.json"]);
});
test("refuses a symlink parent without writing into it", () => {
	const { dir } = fixture();
	const link = join(dir, "link");
	const destination = join(dir, "destination");
	fs.mkdirSync(destination);
	fs.symlinkSync(destination, link);
	expect(() =>
		writeFileAtomicSync(join(link, "state.json"), "synthetic secret", {
			mode: 0o600,
		}),
	).toThrow();
	expect(fs.readdirSync(destination)).toEqual([]);
});

test("public replacement keeps a narrower existing mode", () => {
	const { file } = fixture();
	fs.writeFileSync(file, "old");
	fs.chmodSync(file, 0o600);
	writeFileAtomicSync(file, "new");
	expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	expect(fs.readFileSync(file, "utf8")).toBe("new");
});

test("public symlink refusal uses a mode-neutral message", () => {
	const { dir, file } = fixture();
	const target = join(dir, "target.json");
	fs.writeFileSync(target, "unchanged");
	fs.symlinkSync(target, file);
	expect(() => writeFileAtomicSync(file, "new")).toThrow(
		"Target must be a regular file",
	);
	expect(fs.readFileSync(target, "utf8")).toBe("unchanged");
	expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
});

test("status writes skip all fsync calls and unchanged publications while retaining private mode", () => {
	const { file } = fixture();
	const sync = spyOn(fs, "fsyncSync");
	const rename = spyOn(fs, "renameSync");
	writePrivateStatusSync(file, "first");
	writePrivateStatusSync(file, "first");
	expect(rename).toHaveBeenCalledTimes(1);
	writePrivateStatusSync(file, "second");
	expect(rename).toHaveBeenCalledTimes(2);
	expect(sync).toHaveBeenCalledTimes(0);
	expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	writeFileAtomicSync(file, "durable", { mode: 0o600 });
	expect(sync).toHaveBeenCalledTimes(2);
});

test("unchanged legacy status is still upgraded to private permissions", () => {
	const { file } = fixture();
	fs.writeFileSync(file, "same");
	fs.chmodSync(file, 0o644);
	const sync = spyOn(fs, "fsyncSync");
	writePrivateStatusSync(file, "same");
	expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	expect(sync).toHaveBeenCalledTimes(0);
});
test("ephemeral SIM and kiosk secrets stay private without fsync", async () => {
	const { dir } = fixture();
	const previous = process.env.CERALIVE_RUN_DIR;
	process.env.CERALIVE_RUN_DIR = dir;
	try {
		const { storeSimPin, simPinSecretPath } = await import(
			"../modules/modems/sim-secrets.ts"
		);
		const { mintKioskToken, kioskTokenPath } = await import(
			"../modules/ui/kiosk-token.ts"
		);
		const sync = spyOn(fs, "fsyncSync");
		await storeSimPin("1234");
		await mintKioskToken();
		expect(sync).toHaveBeenCalledTimes(0);
		expect(fs.statSync(simPinSecretPath()).mode & 0o777).toBe(0o600);
		expect(fs.statSync(kioskTokenPath()).mode & 0o777).toBe(0o600);
	} finally {
		if (previous === undefined) delete process.env.CERALIVE_RUN_DIR;
		else process.env.CERALIVE_RUN_DIR = previous;
	}
});
