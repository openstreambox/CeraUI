import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomicSync } from "./config-loader.ts";

test("config writes replace legacy broad permissions with owner-only access", () => {
	const dir = mkdtempSync(join(tmpdir(), "config-permissions-"));
	try {
		const file = join(dir, "config.json");
		writeFileSync(file, '{"srt_streamid":"dummy-legacy-key"}', { mode: 0o644 });
		writeFileAtomicSync(file, '{"srt_streamid":"dummy-key"}');
		expect(statSync(file).mode & 0o777).toBe(0o600);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
