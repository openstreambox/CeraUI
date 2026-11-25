import { expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getConfigFilePath,
	loadConfig,
	saveConfig,
	setConfigFilePath,
} from "../modules/config.ts";

// The saved config holds the Stream ID, so saving it must leave the file
// owner-only even when an older release left it world-readable. This goes
// through saveConfig rather than the atomic writer, so it holds whichever
// layer applies the mode.
test("config writes replace legacy broad permissions with owner-only access", async () => {
	const dir = mkdtempSync(join(tmpdir(), "config-permissions-"));
	const previous = getConfigFilePath();
	try {
		const file = join(dir, "config.json");
		writeFileSync(file, '{"srt_streamid":"dummy-legacy-key"}', { mode: 0o644 });
		chmodSync(file, 0o644);
		setConfigFilePath(file);
		await loadConfig();
		saveConfig();
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(file, "utf8")).srt_streamid).toBe(
			"dummy-legacy-key",
		);
	} finally {
		setConfigFilePath(previous);
		rmSync(dir, { recursive: true, force: true });
	}
});
