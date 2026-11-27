import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as leases from "../../helpers/private-state-lease.ts";
import {
	isRecoveryPending,
	resetRecoveryBarrier,
} from "../streaming/recovery-barrier.ts";
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

test("migration lease contention on a slot does not close admission on the other links", async () => {
	const dir = await mkdtemp(join(tmpdir(), "slot-migration-"));
	const key = "c".repeat(64);
	const acquire = leases.acquirePrivateStateLease;
	const held = await acquire({ dir }, key);
	if (!held) throw new Error("fixture lease busy");
	// Redirect only the kernel lock's directory. The second open uses the
	// production migration path and must refuse before reading any host store.
	const lock = spyOn(leases, "acquirePrivateStateLease").mockImplementation(
		(_store, slot) => acquire({ dir }, slot),
	);
	try {
		const revision = mutationJournalRevision();
		await expect(
			accessCellularAuthority(
				"cellular-preparation",
				key,
				(v) => v,
				async (v) => v,
				undefined,
				true,
				"slot",
			),
		).rejects.toThrow("busy");
		expect(isRecoveryPending()).toBe(false);
		expect(mutationJournalRevision()).toBe(revision);
	} finally {
		lock.mockRestore();
		held.release();
		resetRecoveryBarrier();
		await rm(dir, { recursive: true, force: true });
	}
});
