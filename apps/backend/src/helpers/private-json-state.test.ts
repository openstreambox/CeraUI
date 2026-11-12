import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	readPrivateJson,
	readPrivateText,
	writePrivateJson,
	writePrivateText,
} from "./private-json-state.ts";

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

test("generated text has independent private authority and preserves previous content on invalid writes", async () => {
	const root = await mkdtemp(join(tmpdir(), "private-translator-text-")),
		store = { dir: join(root, "state") },
		key = "a".repeat(64);
	try {
		await writePrivateJson(store, key, { version: 1, marker: "json" });
		await writePrivateText(store, key, "tun-device cclat1\n");
		expect(await readPrivateText(store, key)).toBe("tun-device cclat1\n");
		expect(await readPrivateJson(store, key)).toEqual({
			version: 1,
			marker: "json",
		});
		await expect(writePrivateText(store, key, "invalid\0text")).rejects.toThrow(
			"configuration text",
		);
		await expect(
			writePrivateText(store, key, "x".repeat(4097)),
		).rejects.toThrow("limit");
		expect(await readPrivateText(store, key)).toBe("tun-device cclat1\n");
		expect(fs.statSync(join(store.dir, `${key}.conf`)).mode & 0o777).toBe(
			0o600,
		);
		await writePrivateText(store, key, undefined);
		expect(await readPrivateText(store, key)).toBeUndefined();
		expect(await readPrivateJson(store, key)).toEqual({
			version: 1,
			marker: "json",
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
