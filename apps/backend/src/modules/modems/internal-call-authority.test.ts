import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readPrivateJson,
	writePrivateJson,
} from "../../helpers/private-json-state.ts";
import { cellularHandoffSteps } from "../network/cellular-host-handoff.ts";
import { resetRecoveryBarrier } from "../streaming/recovery-barrier.ts";
import {
	inventoryCellularAuthority,
	inventoryCellularMigration,
} from "./cellular-authority-inventory.ts";
import {
	accessInternalCallAuthority,
	internalCallAuthorityKey,
	listInternalCallAuthorities,
	parseInternalCallAuthority,
} from "./internal-call-authority.ts";
import {
	internalContextAuthorityKey,
	planInternalContextAuthority,
} from "./internal-context-authority.ts";

const unit = "a".repeat(64),
	owner = "b".repeat(64),
	epoch = "c".repeat(64),
	subscription = "d".repeat(64),
	bootId = "11111111-1111-4111-8111-111111111111",
	key = internalCallAuthorityKey(unit);
const physical = {
	ifname: "wwan0",
	ifindex: "17",
	usbDevice: "synthetic-usb",
	netDevice: "synthetic-net",
	generation: "one",
};
function record() {
	const plan = {
		version: 1 as const,
		bootId,
		link: { ...physical },
		nmOwner: ":1.17",
		device: {
			path: "/org/freedesktop/NetworkManager/Devices/1",
			udi: "synthetic-net",
			iface: "wwan0",
			ipIface: "",
			managed: true,
		},
		raDefault: "1" as const,
		up: false,
	};
	return {
		version: 1 as const,
		key,
		unit,
		owner,
		epoch,
		bootId,
		stableKey: "synthetic-key",
		physical: { ...physical },
		identity: {
			model: "FM350-GL",
			firmware: "81600.0000.00.29.18.01",
			mode: "rndis" as const,
		},
		subscription,
		cid: 1,
		contextKey: internalContextAuthorityKey(unit, 1),
		contextExpected: true,
		contextReleased: false,
		phase: "holding" as const,
		handoff: {
			version: 1 as const,
			owner,
			epoch,
			plan,
			steps: cellularHandoffSteps(plan),
			cursor: 2,
			phase: "applying" as const,
		},
	};
}

test("the whole-owner record binds its unit, slot, boot and host inverse without carrier allocation", () => {
	const value = record(),
		parsed = parseInternalCallAuthority(value, key);
	expect(parsed.physical).toEqual(physical);
	expect(parsed.handoff?.cursor).toBe(2);
	expect(parsed.contextExpected).toBe(true);
	expect("apn" in parsed).toBe(false);
	value.physical.ifindex = "18";
	value.handoff.plan.device.managed = false;
	expect(parsed.physical.ifindex).toBe("17");
	expect(parsed.handoff?.plan.device.managed).toBe(true);
	expect(
		parseInternalCallAuthority(
			{ ...record(), handoff: null, contextExpected: false },
			key,
		).handoff,
	).toBeNull();
});

test("wrong units, slots, boot, physical links and inverse cursors cannot select a recovery effect", () => {
	for (const change of [
		{ unit: "e".repeat(64) },
		{ contextKey: internalContextAuthorityKey(unit, 3) },
		{ cid: 3 },
		{ bootId: "22222222-2222-4222-8222-222222222222" },
		{ owner: "e".repeat(64) },
		{ epoch: "e".repeat(64) },
		{ physical: { ...physical, ifindex: "18" } },
		{ physical: { ...physical, generation: "two" } },
		{ handoff: { ...record().handoff, cursor: 4 } },
		{ handoff: { ...record().handoff, steps: ["nm-unmanaged", "ra-default"] } },
		{ handoff: { ...record().handoff, phase: "active" } },
		{ handoff: { ...record().handoff, phase: "withdrawing" } },
		{ identity: { ...record().identity, firmware: "unknown" } },
		{ stableKey: "bad\nkey" },
		{ extra: true },
		{ contextReleased: true },
	])
		expect(() =>
			parseInternalCallAuthority({ ...record(), ...change }, key),
		).toThrow();
	const foreign = record();
	foreign.handoff.plan.device.iface = "other0";
	expect(() => parseInternalCallAuthority(foreign, key)).toThrow(
		"another device",
	);
	const mm = record();
	mm.handoff.plan.device.udi = "/org/freedesktop/ModemManager1/Modem/1";
	expect(() => parseInternalCallAuthority(mm, key)).toThrow("another device");
	expect(() => parseInternalCallAuthority(record(), "e".repeat(64))).toThrow(
		"another unit",
	);
});

test("withdrawal survives host inverse retirement while retaining the context witness", () => {
	const value = record();
	const withdrawing = parseInternalCallAuthority(
		{
			...value,
			phase: "withdrawing",
			contextReleased: true,
			handoff: { ...value.handoff, phase: "withdrawing" },
		},
		key,
	);
	expect(withdrawing.phase).toBe("withdrawing");
	const tail = parseInternalCallAuthority(
		{ ...withdrawing, handoff: null },
		key,
	);
	expect(tail.contextExpected).toBe(true);
	expect(tail.contextKey).toBe(internalContextAuthorityKey(unit, 1));
});

test("whole-owner storage and startup census require its witnessed context baseline", async () => {
	const root = await mkdtemp(join(tmpdir(), "internal-owner-")),
		dir = join(root, "owners"),
		contextDir = join(root, "contexts"),
		settings = {
			CERALIVE_CELLULAR_INTERNAL_OWNER_STATE_DIR: dir,
			CERALIVE_CELLULAR_INTERNAL_CONTEXT_STATE_DIR: contextDir,
			CERALIVE_AUTOMATIC_CARRIER_STATE_DIR: join(root, "intent"),
			CERALIVE_CELLULAR_PREPARATION_STATE_DIR: join(root, "preparation"),
		},
		saved = new Map(
			Object.keys(settings).map((name) => [name, process.env[name]]),
		);
	Object.assign(process.env, settings);
	resetRecoveryBarrier();
	try {
		await accessInternalCallAuthority(unit, async (value, write) => {
			expect(value).toBeUndefined();
			await write(
				parseInternalCallAuthority(
					{ ...record(), contextExpected: false },
					key,
				),
			);
		});
		const meta = await stat(join(dir, `${key}.json`));
		expect(meta.mode & 0o777).toBe(0o600);
		expect((await listInternalCallAuthorities())[0]?.contextExpected).toBe(
			false,
		);
		await accessInternalCallAuthority(unit, async (_value, write) => {
			await write(parseInternalCallAuthority(record(), key));
		});
		await expect(listInternalCallAuthorities()).rejects.toThrow(
			"context authority is missing",
		);
		await expect(inventoryCellularAuthority("verify")).rejects.toThrow(
			"context authority is missing",
		);
		const context = planInternalContextAuthority(
			{
				unit,
				subscription,
				cid: 1,
				desired: { apn: "current.invalid", family: "ipv4v6" },
			},
			{ apn: "baseline.invalid", family: "ipv4" },
			false,
		);
		if (!context) throw new Error("Synthetic baseline unavailable");
		await writePrivateJson({ dir: contextDir }, context.key, context);
		expect(await listInternalCallAuthorities()).toEqual([
			parseInternalCallAuthority(record(), key),
		]);
		const before = await stat(join(dir, `${key}.json`));
		await inventoryCellularAuthority("verify");
		const after = await stat(join(dir, `${key}.json`));
		expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
		await writePrivateJson({ dir }, "e".repeat(64), record());
		await expect(listInternalCallAuthorities()).rejects.toThrow("another unit");
		expect(await readPrivateJson({ dir }, "e".repeat(64))).toEqual(record());
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		resetRecoveryBarrier();
		await rm(root, { recursive: true, force: true });
	}
});

test("startup migration covers retained whole owners before later read-only verification", async () => {
	const root = await mkdtemp(join(tmpdir(), "internal-owner-migrate-")),
		migration = {
			source: { dir: join(root, "old") },
			destination: { dir: join(root, "data") },
			receipts: { dir: join(root, "receipts") },
			parse: parseInternalCallAuthority,
		};
	try {
		await writePrivateJson(migration.source, key, record());
		await expect(
			inventoryCellularMigration(migration, "verify"),
		).rejects.toThrow("incomplete");
		await inventoryCellularMigration(migration, "migrate");
		expect(await readPrivateJson(migration.destination, key)).toEqual(record());
		await inventoryCellularMigration(migration, "verify");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
