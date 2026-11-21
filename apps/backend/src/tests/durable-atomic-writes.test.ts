import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	loadCacheFile,
	loadJsonConfig,
	writeFileAtomicSync,
} from "../helpers/config-loader.ts";
import {
	type AuthTokens,
	authTokensSchema,
	RELAYS_CACHE_DEFAULTS,
	type RelaysCache,
	relaysCacheSchema,
} from "../helpers/config-schemas.ts";
import { writeTextFileAtomic } from "../helpers/text-files.ts";

const sampleTokens: AuthTokens = {
	"token-a": true,
	"token-b": true,
};

const sampleRelays: RelaysCache = {
	servers: {
		s1: { type: "srtla", name: "Frankfurt", addr: "de.example.tv", port: 5000 },
	},
	accounts: {
		a1: { name: "Primary", ingest_key: "abc123" },
	},
};

describe("durable/cache atomic writers", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-atomic-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("flushes the temp file before rename and its parent directory after rename", () => {
		const filePath = path.join(tempDir, "config.json");
		const tmpPath = path.join(tempDir, `.config.json.${process.pid}.tmp`);
		fs.writeFileSync(filePath, "{}");
		const contents = '{"bitrate":5000}';
		const fsync = fs.fsyncSync;
		const syncedPaths: string[] = [];
		const sync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
			const { dev, ino } = fs.fstatSync(fd);
			const target = fs.readFileSync(filePath, "utf8");
			expect(target).toBe(syncedPaths.length === 0 ? "{}" : contents);
			const syncedPath = target === contents ? tempDir : tmpPath;
			const expected = fs.statSync(syncedPath);
			expect({ dev, ino }).toEqual({ dev: expected.dev, ino: expected.ino });
			syncedPaths.push(syncedPath);
			fsync(fd);
		});

		try {
			writeFileAtomicSync(filePath, contents);
			expect(syncedPaths).toEqual([tmpPath, tempDir]);
			expect(fs.readFileSync(filePath, "utf8")).toBe(contents);
		} finally {
			sync.mockRestore();
		}
	});

	it("closes the directory and reports a failed sync after publishing the file", () => {
		const filePath = path.join(tempDir, "config.json");
		const error = Object.assign(new Error("directory sync failed"), {
			code: "EIO",
		});
		const fsync = fs.fsyncSync;
		let directoryFd = -1;
		const sync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
			if (fs.fstatSync(fd).isDirectory()) {
				directoryFd = fd;
				throw error;
			}
			fsync(fd);
		});

		try {
			expect(() => writeFileAtomicSync(filePath, "{}")).toThrow(error);
			expect(directoryFd).toBeGreaterThanOrEqual(0);
			expect(() => fs.fstatSync(directoryFd)).toThrow(
				expect.objectContaining({ code: "EBADF" }),
			);
			expect(fs.readFileSync(filePath, "utf8")).toBe("{}");
			expect(fs.readdirSync(tempDir)).toEqual(["config.json"]);
		} finally {
			sync.mockRestore();
		}
	});

	describe("auth_tokens.json", () => {
		it("round-trips through an atomic write with no surviving temp artifact", async () => {
			const filePath = path.join(tempDir, "auth_tokens.json");
			writeFileAtomicSync(filePath, JSON.stringify(sampleTokens));

			const loaded = await loadCacheFile(filePath, authTokensSchema);

			expect(loaded).toEqual(sampleTokens);
			expect(fs.readdirSync(tempDir)).toEqual(["auth_tokens.json"]);
		});

		it("leaves the original file intact when a write is interrupted before rename", () => {
			const filePath = path.join(tempDir, "auth_tokens.json");
			writeFileAtomicSync(filePath, JSON.stringify(sampleTokens));

			// Simulate a crash mid-write: new bytes land in the sibling temp file and
			// fsync, but the process dies before the atomic rename runs.
			const tmpPath = path.join(
				tempDir,
				`.auth_tokens.json.${process.pid}.tmp`,
			);
			const fd = fs.openSync(tmpPath, "w");
			fs.writeFileSync(fd, '{"token-a":true,"token-');
			fs.fsyncSync(fd);
			fs.closeSync(fd);

			const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
			expect(onDisk).toEqual(sampleTokens);
			expect(authTokensSchema.safeParse(onDisk).success).toBe(true);
		});
	});

	describe("relays_cache.json", () => {
		it("round-trips through the atomic wrapper with no surviving temp artifact", async () => {
			const filePath = path.join(tempDir, "relays_cache.json");
			expect(writeTextFileAtomic(filePath, JSON.stringify(sampleRelays))).toBe(
				true,
			);

			const result = await loadJsonConfig(
				filePath,
				relaysCacheSchema,
				RELAYS_CACHE_DEFAULTS,
			);

			expect(result.data).toEqual(sampleRelays);
			expect(fs.readdirSync(tempDir)).toEqual(["relays_cache.json"]);
		});

		it("leaves the original file intact when a write is interrupted before rename", () => {
			const filePath = path.join(tempDir, "relays_cache.json");
			writeTextFileAtomic(filePath, JSON.stringify(sampleRelays));

			// Simulate a crash mid-write: new bytes land in the sibling temp file and
			// fsync, but the process dies before the atomic rename runs.
			const tmpPath = path.join(
				tempDir,
				`.relays_cache.json.${process.pid}.tmp`,
			);
			const fd = fs.openSync(tmpPath, "w");
			fs.writeFileSync(fd, '{"servers":{"s1":{"type":"srtla","na');
			fs.fsyncSync(fd);
			fs.closeSync(fd);

			const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
			expect(onDisk).toEqual(sampleRelays);
			expect(relaysCacheSchema.safeParse(onDisk).success).toBe(true);
		});
	});
});
