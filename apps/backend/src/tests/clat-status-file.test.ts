import { expect, test } from "bun:test";

test("status files reject FIFOs without waiting for a writer", async () => {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const files = await import("../modules/streaming/clat-status.ts");
	const dir = await mkdtemp(join(tmpdir(), "clat-status-"));
	try {
		const path = join(dir, "status");
		expect(await Bun.spawn(["mkfifo", path]).exited).toBe(0);
		await expect(files.readClatStatusFile(path)).rejects.toThrow(
			"regular file",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a stalled file read times out, closes its handle and permits later reads", async () => {
	const fs = await import("node:fs/promises");
	const { constants } = await import("node:fs");
	const { spyOn } = await import("bun:test");
	const files = await import("../modules/streaming/clat-status.ts");
	let closed = 0,
		stalled = true;
	const open = spyOn(fs, "open").mockImplementation(async (_path, flags) => {
		expect(Number(flags) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
		return {
			stat: async () => ({ isFile: () => true }),
			readFile: async () =>
				stalled ? await new Promise<string>(() => {}) : "ready",
			close: async () => {
				closed++;
			},
		} as never;
	});
	try {
		await expect(files.readClatStatusFile("status", 10)).rejects.toThrow(
			"timeout",
		);
		expect(closed).toBe(1);
		stalled = false;
		expect(await files.readClatStatusFile("status", 10)).toBe("ready");
		expect(closed).toBe(2);
	} finally {
		open.mockRestore();
	}
});

test("an open that finishes after its deadline closes without reading", async () => {
	const fs = await import("node:fs/promises");
	const { spyOn } = await import("bun:test");
	const { readClatStatusFile } = await import(
		"../modules/streaming/clat-status.ts"
	);
	let deliver!: (handle: never) => void;
	let closed = 0,
		stats = 0;
	const open = spyOn(fs, "open").mockImplementation(
		() =>
			new Promise((resolve) => {
				deliver = resolve;
			}),
	);
	try {
		await expect(readClatStatusFile("status", 10)).rejects.toThrow("timeout");
		deliver({
			close: async () => {
				closed++;
			},
			stat: async () => {
				stats++;
			},
		} as never);
		await Promise.resolve();
		await Promise.resolve();
		expect(closed).toBe(1);
		expect(stats).toBe(0);
	} finally {
		open.mockRestore();
	}
});
