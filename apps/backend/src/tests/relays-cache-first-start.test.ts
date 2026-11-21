import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { logger } from "../helpers/logger.ts";

test("a first start without relays_cache.json logs the missing cache at info, not warn", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relays-cache-"));
	const previous = process.cwd();
	const warn = spyOn(logger, "warn").mockImplementation(() => logger);
	const info = spyOn(logger, "info").mockImplementation(() => logger);
	try {
		process.chdir(dir);
		const relays = await import("../modules/remote/remote-relays.ts");
		expect(relays.getRelays()).toBeUndefined();
		const notFound = (calls: unknown[][]) =>
			calls.filter(([message]) =>
				String(message).startsWith("Config file not found: relays_cache.json"),
			).length;
		expect(notFound(warn.mock.calls)).toBe(0);
		expect(notFound(info.mock.calls)).toBe(1);
	} finally {
		process.chdir(previous);
		warn.mockRestore();
		info.mockRestore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
