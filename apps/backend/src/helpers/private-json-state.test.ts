import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readPrivateJson, writePrivateJson } from "./private-json-state.ts";

test("a first durable state write persists each newly created directory link before returning", async () => {
	const root = await mkdtemp(join(tmpdir(), "private-directory-chain-"));
	const dir = join(root, "first", "second");
	const synced: string[] = [];
	const actual = fs.fsyncSync;
	const spy = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
		synced.push(fs.readlinkSync(`/proc/self/fd/${fd}`));
		actual(fd);
	});
	try {
		await writePrivateJson({ dir }, "0".repeat(64), { attempted: true });
		expect(synced).toContain(root);
		expect(synced).toContain(dirname(dir));
		expect(synced).toContain(dir);
		expect(await readPrivateJson({ dir }, "0".repeat(64))).toEqual({
			attempted: true,
		});
	} finally {
		spy.mockRestore();
		await rm(root, { recursive: true, force: true });
	}
});
