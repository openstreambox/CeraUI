import { expect, test } from "bun:test";
import fsDefault, * as fs from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordFsyncsPerTest } from "./helpers/recorded-fsync.ts";

const observed: string[] = [];
const fsyncs = recordFsyncsPerTest((path) => observed.push(path));

test("every fsync form records the synced path in call order", async () => {
	const root = fs.realpathSync(
		await mkdtemp(join(tmpdir(), "recorded-fsync-")),
	);
	const file = join(root, "record.json");
	observed.length = 0;
	try {
		const fd = fs.openSync(file, "w");
		fs.fsyncSync(fd);
		fsDefault.fdatasyncSync(fd);
		await new Promise<void>((resolve, reject) =>
			fs.fsync(fd, (error) => (error ? reject(error) : resolve())),
		);
		fs.closeSync(fd);
		const handle = await open(file, "r+");
		await handle.sync();
		await handle.datasync();
		await handle.close();
		const parent = fs.openSync(root, "r");
		fsDefault.fsyncSync(parent);
		fs.closeSync(parent);
		expect(fsyncs.synced).toEqual([file, file, file, file, file, root]);
		expect(observed).toEqual(fsyncs.synced);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a closed descriptor still fails as the kernel would", async () => {
	const root = await mkdtemp(join(tmpdir(), "recorded-fsync-"));
	try {
		const fd = fs.openSync(join(root, "closed"), "w");
		fs.closeSync(fd);
		expect(() => fs.fsyncSync(fd)).toThrow(/EBADF/);
		expect(() => fsDefault.fsyncSync(fd)).toThrow(/EBADF/);
		const error = await new Promise<unknown>((resolve) =>
			fs.fdatasync(fd, resolve),
		);
		expect(String(error)).toMatch(/EBADF/);
		const handle = await open(join(root, "closed"), "r");
		await handle.close();
		await expect(handle.sync()).rejects.toThrow();
		expect(fsyncs.synced).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
