import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("production subsystem gates do not call the legacy board classifier", async () => {
	const violations: string[] = [];
	for await (const path of new Bun.Glob("**/*.ts").scan(root)) {
		if (
			path.includes("tests/") ||
			path.endsWith(".test.ts") ||
			path === "modules/system/device-detection.ts" ||
			path === "modules/system/board-capabilities.ts"
		) {
			continue;
		}
		const source = await readFile(join(root, path), "utf8");
		if (/\.\s*isRealDevice\s*\(/.test(source)) {
			violations.push(path);
		}
		for (const match of source.matchAll(
			/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g,
		)) {
			if (
				/\bisRealDevice\b/.test(match[1] ?? "") &&
				/(?:device-detection|kiosk)\.ts$/.test(match[2] ?? "")
			) {
				violations.push(path);
			}
		}
	}
	expect(violations).toEqual([]);
});
