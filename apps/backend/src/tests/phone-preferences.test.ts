import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readPhoneWay,
	writePhoneWay,
} from "../modules/system/phone-preferences";

test("a damaged way file reads as no saved choice and can be replaced", async () => {
	const dir = mkdtempSync(join(tmpdir(), "phone-way-"));
	const path = join(dir, "way.json");
	try {
		for (const damaged of [
			"",
			"{",
			'{"way":"srt"',
			"null",
			"[]",
			"5",
			'"srt"',
			'{"way":null}',
			'{"way":"nonsense"}',
			Buffer.from([0x7b, 0xff, 0xfe, 0x7d]),
		]) {
			writeFileSync(path, damaged);
			expect(await readPhoneWay(path)).toBeNull();
		}
		await writePhoneWay("srt", path);
		expect(await readPhoneWay(path)).toBe("srt");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

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
