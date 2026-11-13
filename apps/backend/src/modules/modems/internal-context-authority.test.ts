import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readPrivateJson,
	writePrivateJson,
} from "../../helpers/private-json-state.ts";
import {
	isRecoveryPending,
	resetRecoveryBarrier,
} from "../streaming/recovery-barrier.ts";
import { inventoryCellularMigration } from "./cellular-authority-inventory.ts";
import {
	accessInternalContextAuthority,
	internalContextAuthorityKey,
	parkInternalContextAuthority,
	parseInternalContextAuthority,
	planInternalContextAuthority,
} from "./internal-context-authority.ts";
import { mutationJournalRevision } from "./mutation-journal-revision.ts";
import type { InternalContext } from "./transport-policy.ts";

const unit = "a".repeat(64),
	firstSim = "b".repeat(64),
	secondSim = "c".repeat(64),
	original: InternalContext = {
		apn: "baseline.invalid",
		family: "ipv4",
		settings: ["0.0.0.0", "0", "0"],
	},
	first = {
		unit,
		subscription: firstSim,
		cid: 1,
		desired: { apn: "first.invalid", family: "ipv4v6" as const },
	},
	second = {
		...first,
		subscription: secondSim,
		desired: { apn: "second.invalid", family: "ipv4" as const },
	};
function baseline() {
	const record = planInternalContextAuthority(first, original, false);
	if (!record) throw new Error("Missing context fixture");
	return record;
}

test("baseline precedes a definition and includes complete reversible settings without inferring carrier", () => {
	const record = baseline();
	expect(record.original).toEqual({
		subscription: firstSim,
		context: original,
		active: false,
	});
	expect(record.before).toEqual(original);
	expect(record.desired).toEqual({
		...first.desired,
		settings: original.settings,
	});
	expect(record).toMatchObject({
		phase: "baseline",
		activationOwned: false,
		adoptedActive: false,
	});
	expect(planInternalContextAuthority(first, original, true)).toBeUndefined();
	const adopted = planInternalContextAuthority(first, record.desired, true);
	expect(adopted).toMatchObject({
		phase: "baseline",
		activationOwned: false,
		adoptedActive: true,
	});
});

test("definition recovery accepts only its prior baseline or exact desired definition", () => {
	const record = baseline();
	for (const phase of ["baseline", "defining"] as const) {
		const pending = { ...record, phase };
		expect(
			planInternalContextAuthority(first, original, false, pending),
		).toEqual(pending);
		expect(
			planInternalContextAuthority(first, record.desired, false, pending),
		).toEqual(pending);
		expect(
			planInternalContextAuthority(
				first,
				{ ...original, apn: "foreign.invalid" },
				false,
				pending,
			),
		).toBeUndefined();
		expect(
			planInternalContextAuthority(first, original, true, pending),
		).toBeUndefined();
	}
	expect(
		planInternalContextAuthority(first, original, false, {
			...record,
			phase: "defined",
		}),
	).toBeUndefined();
});

test("a different SIM requires inactive exact-owned parking and keeps the original unit baseline", () => {
	const record = baseline(),
		active = { ...record, phase: "active" as const, activationOwned: true };
	expect(
		planInternalContextAuthority(second, record.desired, false, active),
	).toBeUndefined();
	expect(
		parkInternalContextAuthority(active, record.desired, true),
	).toBeUndefined();
	expect(
		parkInternalContextAuthority(
			active,
			{ ...record.desired, family: "ipv4" },
			false,
		),
	).toBeUndefined();
	const parked = parkInternalContextAuthority(active, record.desired, false);
	expect(parked).toMatchObject({
		phase: "parked",
		activationOwned: false,
		adoptedActive: false,
	});
	if (!parked) throw new Error("Missing parked fixture");
	expect(
		planInternalContextAuthority(second, parked.desired, true, parked),
	).toBeUndefined();
	const transferred = planInternalContextAuthority(
		second,
		parked.desired,
		false,
		parked,
	);
	expect(transferred?.original).toEqual(record.original);
	expect(transferred?.subscription).toBe(secondSim);
	expect(transferred?.before).toEqual(record.desired);
	expect(transferred?.desired.apn).toBe("second.invalid");
	expect(transferred?.desired.apn).not.toBe(record.original.context.apn);
	expect(transferred?.desired.family).toBe("ipv4");
});

test("same-SIM policy changes also require parking and cannot replace an active definition", () => {
	const record = baseline(),
		changed = { ...first, desired: second.desired };
	expect(
		planInternalContextAuthority(changed, record.desired, false, record),
	).toBeUndefined();
	const parked = parkInternalContextAuthority(record, record.desired, false);
	if (!parked) throw new Error("Missing parked fixture");
	expect(
		planInternalContextAuthority(changed, record.desired, false, parked)
			?.desired.apn,
	).toBe("second.invalid");
});

test("authority keys, phases and definitions reject foreign or malformed state", () => {
	const record = baseline();
	for (const changed of [
		{ ...record, unit: "d".repeat(64) },
		{ ...record, cid: 3 },
		{ ...record, phase: "parked", activationOwned: true },
		{ ...record, phase: "parked", adoptedActive: true },
		{ ...record, phase: "activating", activationOwned: false },
		{ ...record, phase: "active", activationOwned: false },
		{ ...record, desired: { ...record.desired, apn: 'bad"\nAT' } },
		{
			...record,
			desired: { ...record.desired, settings: ["unknown-address"] },
		},
		{ ...record, subscription: "unresolved" },
		{ ...record, extra: true },
	])
		expect(() => parseInternalContextAuthority(changed, record.key)).toThrow();
	expect(() =>
		planInternalContextAuthority(
			{ ...first, unit: "d".repeat(64) },
			original,
			false,
			record,
		),
	).toThrow();
	expect(internalContextAuthorityKey(unit, 1)).not.toBe(
		internalContextAuthorityKey(unit, 3),
	);
});

test("new SIM planning cannot mutate a retained baseline supplied by its previous owner", () => {
	const source = { ...original, settings: [...(original.settings ?? [])] },
		record = planInternalContextAuthority(first, source, false);
	source.apn = "later.invalid";
	source.settings[1] = "1";
	expect(record?.original.context).toEqual(original);
});

test("shared authority migration inventories the unit context and retains its original SIM baseline", async () => {
	const root = await mkdtemp(join(tmpdir(), "context-authority-migration-")),
		record = baseline(),
		migration = {
			source: { dir: join(root, "old") },
			destination: { dir: join(root, "shared") },
			receipts: { dir: join(root, "receipts") },
			parse: parseInternalContextAuthority,
		};
	try {
		await writePrivateJson(migration.source, record.key, record);
		await inventoryCellularMigration(migration, "migrate");
		await rm(migration.source.dir, { recursive: true });
		await inventoryCellularMigration(migration, "verify");
		expect(await readPrivateJson(migration.destination, record.key)).toEqual(
			record,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("context storage participates in the existing mutation revision before read-back", async () => {
	const root = await mkdtemp(join(tmpdir(), "context-authority-state-")),
		previous = process.env.CERALIVE_CELLULAR_INTERNAL_CONTEXT_STATE_DIR,
		record = baseline(),
		revision = mutationJournalRevision();
	process.env.CERALIVE_CELLULAR_INTERNAL_CONTEXT_STATE_DIR = root;
	try {
		await accessInternalContextAuthority(unit, 1, async (value, write) => {
			expect(value).toBeUndefined();
			await write(record);
		});
		expect(mutationJournalRevision()).toBeGreaterThan(revision);
		expect(
			await accessInternalContextAuthority(unit, 1, async (value) => value),
		).toEqual(record);
	} finally {
		if (previous === undefined)
			delete process.env.CERALIVE_CELLULAR_INTERNAL_CONTEXT_STATE_DIR;
		else process.env.CERALIVE_CELLULAR_INTERNAL_CONTEXT_STATE_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test("an unknown activity read never proves a context inactive for parking or transfer", () => {
	const record = baseline(),
		parked = parkInternalContextAuthority(record, record.desired, false);
	if (!parked) throw new Error("Missing parked fixture");
	for (const value of [undefined, null, 0, "false"]) {
		expect(
			parkInternalContextAuthority(record, record.desired, value as boolean),
		).toBeUndefined();
		expect(
			planInternalContextAuthority(
				second,
				record.desired,
				value as boolean,
				parked,
			),
		).toBeUndefined();
	}
});

test("damaged context authority raises the existing recovery barrier and cannot become absence", async () => {
	const root = await mkdtemp(join(tmpdir(), "context-authority-fault-")),
		previous = process.env.CERALIVE_CELLULAR_INTERNAL_CONTEXT_STATE_DIR,
		record = baseline(),
		broken = { ...record, version: 99 };
	process.env.CERALIVE_CELLULAR_INTERNAL_CONTEXT_STATE_DIR = root;
	resetRecoveryBarrier();
	try {
		await writePrivateJson({ dir: root }, record.key, broken);
		const revision = mutationJournalRevision();
		await expect(
			accessInternalContextAuthority(unit, 1, async (value) => value),
		).rejects.toThrow();
		expect(mutationJournalRevision()).toBeGreaterThan(revision);
		expect(isRecoveryPending()).toBe(true);
		expect(await readPrivateJson({ dir: root }, record.key)).toEqual(broken);
	} finally {
		if (previous === undefined)
			delete process.env.CERALIVE_CELLULAR_INTERNAL_CONTEXT_STATE_DIR;
		else process.env.CERALIVE_CELLULAR_INTERNAL_CONTEXT_STATE_DIR = previous;
		resetRecoveryBarrier();
		await rm(root, { recursive: true, force: true });
	}
});
