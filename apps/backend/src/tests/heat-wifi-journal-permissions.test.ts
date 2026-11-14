import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveHeatWifiJournal } from "../modules/wifi/heat-wifi-runtime.ts";

test("Wi-Fi recovery journal stays private on creation and replacement", async () => {
	const dir = await mkdtemp(join(tmpdir(), "wifi-journal-"));
	const previous = process.umask(0o022);
	try {
		const file = join(dir, "recovery.json");
		await saveHeatWifiJournal([], file);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		await chmod(file, 0o644);
		await saveHeatWifiJournal([], file);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
	} finally {
		process.umask(previous);
		await rm(dir, { recursive: true, force: true });
	}
});
