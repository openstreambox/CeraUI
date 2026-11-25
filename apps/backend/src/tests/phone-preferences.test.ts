import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readPhoneWay,
	writePhoneWay,
} from "../modules/system/phone-preferences";

test("remembers only the way, survives a new read and rejects identity fields", async () => {
	const dir = mkdtempSync(join(tmpdir(), "phone-way-"));
	const path = join(dir, "way.json");
	try {
		expect(await readPhoneWay(path)).toBeNull();
		for (const way of ["moblin", "srt", "internet"] as const) {
			await writePhoneWay(way, path);
			expect(await readPhoneWay(path)).toBe(way);
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ way });
		}
		await expect(writePhoneWay("phone-name" as never, path)).rejects.toThrow();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
