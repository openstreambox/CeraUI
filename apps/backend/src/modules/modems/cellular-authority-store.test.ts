import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CellularAuthorityBusy,
	readCellularSlot,
	writeCellularSlot,
} from "./cellular-authority-revision.ts";
import { accessCellularAuthority } from "./cellular-authority-store.ts";
import { mutationJournalRevision } from "./mutation-journal-revision.ts";

test("slot-scoped durable cursor writes preserve another modem's global journal revision", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cellular-slot-")),
		key = "a".repeat(64);
	const parse = (value: unknown) => value as { cursor: number };
	const revision = mutationJournalRevision();
	try {
		for (const cursor of [1, 2, 1, 0]) {
			await accessCellularAuthority(
				"cellular-preparation",
				key,
				parse,
				async (_, write) => write({ cursor }),
				dir,
				true,
				"slot",
			);
			expect(mutationJournalRevision()).toBe(revision);
		}
		expect(
			await accessCellularAuthority(
				"cellular-preparation",
				key,
				parse,
				async (value) => value,
				dir,
				true,
				"slot",
			),
		).toEqual({ cursor: 0 });
		await accessCellularAuthority(
			"cellular-preparation",
			key,
			parse,
			async (_, write) => write({ cursor: 1 }),
			dir,
		);
		expect(mutationJournalRevision()).toBeGreaterThan(revision);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("a reader defers a slot write without raising the global journal barrier", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cellular-slot-race-")),
		key = "b".repeat(64),
		revision = mutationJournalRevision();
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		const write = writeCellularSlot(
			{
				dir,
				change: async (operation) => {
					await held;
					return operation();
				},
			},
			key,
			{ cursor: 2 },
		);
		await expect(readCellularSlot({ dir }, key)).rejects.toBeInstanceOf(
			CellularAuthorityBusy,
		);
		await expect(
			accessCellularAuthority(
				"cellular-preparation",
				key,
				(value) => value,
				async (value) => value,
				dir,
				true,
				"slot",
			),
		).rejects.toBeInstanceOf(CellularAuthorityBusy);
		expect(mutationJournalRevision()).toBe(revision);
		release();
		await write;
		expect(await readCellularSlot({ dir }, key)).toEqual({ cursor: 2 });
	} finally {
		release();
		await rm(dir, { recursive: true, force: true });
	}
});
