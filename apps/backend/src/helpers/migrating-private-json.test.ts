import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	type PrivateJsonMigrationIO,
	withMigratedPrivateJson,
} from "./migrating-private-json.ts";
import { readPrivateJson, writePrivateJson } from "./private-json-state.ts";
import { acquirePrivateStateLease } from "./private-state-lease.ts";

const key = "a".repeat(64);
const schema = z
	.object({
		version: z.literal(1),
		key: z.literal(key),
		attempted: z.boolean(),
		phase: z.enum(["baseline", "blocked", "verified"]),
	})
	.strict();
const spent = {
	version: 1 as const,
	key,
	attempted: true,
	phase: "blocked" as const,
};
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "private-authority-migration-"));
	const migration = {
		source: { dir: join(root, "slot") },
		destination: { dir: join(root, "shared") },
		receipts: { dir: join(root, "receipts") },
		parse: (raw: unknown, slot: string) => {
			if (slot !== key) throw new Error("misplaced slot");
			return schema.parse(raw);
		},
	};
	return {
		migration,
		read: (io?: PrivateJsonMigrationIO) =>
			withMigratedPrivateJson(migration, key, async (value) => value, io),
		write: (value: z.infer<typeof schema> | undefined) =>
			withMigratedPrivateJson(migration, key, async (_current, write) =>
				write(value),
			),
		close: () => rm(root, { recursive: true, force: true }),
	};
}
test("spent authority survives a new reader and migration never modifies the old slot", async () => {
	const f = await fixture();
	try {
		await writePrivateJson(f.migration.source, key, spent);
		const original = await readFile(
			join(f.migration.source.dir, `${key}.json`),
		);
		expect(await f.read()).toEqual(spent);
		expect(await f.read()).toEqual(spent);
		expect(await readPrivateJson(f.migration.destination, key)).toEqual(spent);
		expect(await readFile(join(f.migration.source.dir, `${key}.json`))).toEqual(
			original,
		);
		await f.write({ ...spent, phase: "verified" });
		expect((await f.read())?.phase).toBe("verified");
		await f.write(undefined);
		expect(await f.read()).toBeUndefined(); // A retained baseline must not resurrect.
		await rm(f.migration.source.dir, { recursive: true }); // OS slot switch.
		expect(await f.read()).toBeUndefined();
	} finally {
		await f.close();
	}
});
test("lost copy or receipt acknowledgement retains authority and retries the same copy", async () => {
	for (const failedStore of ["destination", "receipts"] as const) {
		const f = await fixture();
		try {
			await writePrivateJson(f.migration.source, key, spent);
			let effects = 0;
			const io: PrivateJsonMigrationIO = {
				read: readPrivateJson,
				acquire: acquirePrivateStateLease,
				write: async (store, slot, value) => {
					await writePrivateJson(store, slot, value);
					if (store.dir === f.migration[failedStore].dir)
						throw new Error("lost durable acknowledgement");
				},
			};
			await expect(
				withMigratedPrivateJson(
					f.migration,
					key,
					async () => {
						effects++;
					},
					io,
				),
			).rejects.toThrow("acknowledgement");
			await expect(
				withMigratedPrivateJson(
					f.migration,
					key,
					async () => {
						effects++;
					},
					io,
				),
			).rejects.toThrow("acknowledgement");
			expect(effects).toBe(0);
			expect(await f.read()).toEqual(spent);
			expect(await readPrivateJson(f.migration.source, key)).toEqual(spent);
		} finally {
			await f.close();
		}
	}
});
test("a conflicting copy, changed legacy decision or damaged receipt cannot authorize work", async () => {
	const f = await fixture();
	try {
		await writePrivateJson(f.migration.source, key, spent);
		await writePrivateJson(f.migration.destination, key, {
			...spent,
			attempted: false,
			phase: "baseline",
		});
		await expect(f.read()).rejects.toThrow("conflict");
		await writePrivateJson(f.migration.destination, key, spent);
		expect(await f.read()).toEqual(spent);
		await writePrivateJson(f.migration.source, key, {
			...spent,
			phase: "verified",
		});
		await expect(f.read()).rejects.toThrow("changed");
		await writePrivateJson(f.migration.source, key, spent);
		await writeFile(
			join(f.migration.receipts.dir, `${key}.json`),
			'{"version":1,"version":1}',
			{ mode: 0o600 },
		);
		await expect(f.read()).rejects.toThrow();
		expect(await readPrivateJson(f.migration.destination, key)).toEqual(spent);
	} finally {
		await f.close();
	}
});
test("a contended slot and malformed old authority are unknown, never a fresh baseline", async () => {
	const f = await fixture();
	try {
		const held = await acquirePrivateStateLease(f.migration.receipts, key);
		expect(held).toBeDefined();
		try {
			await expect(f.read()).rejects.toThrow("busy");
		} finally {
			held?.release();
		}
		await writePrivateJson(f.migration.source, key, { ...spent, extra: true });
		await expect(f.read()).rejects.toThrow();
		expect(await readPrivateJson(f.migration.destination, key)).toBeUndefined();
		await writeFile(
			join(f.migration.source.dir, `${key}.json`),
			'{"version":1,"version":1}',
			{ mode: 0o600 },
		);
		await expect(f.read()).rejects.toThrow();
	} finally {
		await f.close();
	}
});
