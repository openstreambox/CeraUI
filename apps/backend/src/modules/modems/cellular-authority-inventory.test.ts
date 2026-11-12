import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	listPrivateJsonKeys,
	readPrivateJson,
	writePrivateJson,
} from "../../helpers/private-json-state.ts";
import { inventoryCellularMigration } from "./cellular-authority-inventory.ts";
import { parsePreparationRecord } from "./cellular-preparation-state.ts";

const record = (key: string) => ({
	version: 1,
	kind: "eps",
	key,
	original: { apn: "original.invalid", family: "ipv4" },
	desired: { apn: "automatic.invalid", family: "ipv4v6" },
	attempted: true,
	phase: "blocked",
	epoch: "previous-usb",
	started: 1,
});
test("startup migrates every remembered pair and later verification performs no writes", async () => {
	const root = await mkdtemp(join(tmpdir(), "cellular-authority-inventory-")),
		migration = {
			source: { dir: join(root, "old-slot") },
			destination: { dir: join(root, "shared-data") },
			receipts: { dir: join(root, "receipts") },
			parse: parsePreparationRecord,
		};
	const keys = ["a".repeat(64), "b".repeat(64)];
	try {
		for (const key of keys)
			await writePrivateJson(migration.source, key, record(key));
		await expect(
			inventoryCellularMigration(migration, "verify"),
		).rejects.toThrow("incomplete");
		await inventoryCellularMigration(migration, "migrate");
		expect(await listPrivateJsonKeys(migration.destination)).toEqual(keys);
		await rm(migration.source.dir, { recursive: true });
		const before = await Promise.all(
			keys.map((key) => stat(join(migration.receipts.dir, `${key}.json`))),
		);
		await inventoryCellularMigration(migration, "verify");
		for (const [index, key] of keys.entries()) {
			expect(await readPrivateJson(migration.destination, key)).toEqual(
				record(key),
			);
			const after = await stat(join(migration.receipts.dir, `${key}.json`));
			expect([after.ino, after.mtimeMs]).toEqual([
				before[index]?.ino,
				before[index]?.mtimeMs,
			]);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("a misplaced or symlink authority slot prevents a complete census and preserves its bytes", async () => {
	const root = await mkdtemp(join(tmpdir(), "cellular-authority-damage-")),
		migration = {
			source: { dir: join(root, "old-slot") },
			destination: { dir: join(root, "shared-data") },
			receipts: { dir: join(root, "receipts") },
			parse: parsePreparationRecord,
		},
		key = "a".repeat(64);
	try {
		await writePrivateJson(migration.source, key, record("b".repeat(64)));
		await expect(
			inventoryCellularMigration(migration, "migrate"),
		).rejects.toThrow("another identity");
		expect(await readPrivateJson(migration.source, key)).toEqual(
			record("b".repeat(64)),
		);
		await rm(join(migration.source.dir, `${key}.json`));
		await symlink("missing", join(migration.source.dir, `${key}.json`));
		await expect(
			inventoryCellularMigration(migration, "migrate"),
		).rejects.toThrow();
		expect(await listPrivateJsonKeys(migration.destination)).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
