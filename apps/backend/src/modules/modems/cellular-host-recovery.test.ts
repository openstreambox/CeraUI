import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readPrivateJson,
	writePrivateJson,
} from "../../helpers/private-json-state.ts";
import { acquirePrivateStateLease } from "../../helpers/private-state-lease.ts";
import {
	cellularNativeHostSteps,
	cellularUplinkSlotKey,
	parseCellularNativeHostPlan,
} from "../network/cellular-native-host-plan.ts";
import {
	cellularSourceReady,
	resetCellularSourcesForTest,
} from "../network/cellular-source-state.ts";
import {
	CellularHostRecovery,
	cellularHostStore,
	cellularRecoveryExcludes,
	cellularRecoveryReservedSlots,
	isolateCellularHostAuthority,
} from "./cellular-host-recovery.ts";
import { initCellularRuntimeAdmission } from "./cellular-runtime-host.ts";
import {
	isMutationJournalRevisionCurrent,
	mutationJournalRevision,
} from "./mutation-journal-revision.ts";

const bootId = "11111111-1111-1111-1111-111111111111";
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "cellular-host-recovery-")),
		store = { dir },
		key = cellularUplinkSlotKey(1),
		plan = parseCellularNativeHostPlan({
			input: {
				owner: "a".repeat(64),
				epoch: "one",
				slot: 1,
				iface: "wwan0",
				mtu: 1428,
				ipv4: "192.0.2.2",
			},
			bootId,
			ifindex: 17,
			dns: [],
		}),
		steps = cellularNativeHostSteps(plan);
	await writePrivateJson(store, key, {
		version: 1,
		owner: plan.input.owner,
		epoch: plan.input.epoch,
		plan,
		steps,
		cursor: steps.length,
		phase: "active",
	});
	return {
		store,
		key,
		plan,
		close: () => rm(dir, { recursive: true, force: true }),
	};
}
test("startup retries retain the same cleanup owner and runtime verification never repeats hardware", async () => {
	const f = await fixture();
	let retained = 0,
		cleaned = 0,
		released = false;
	try {
		const owner = new CellularHostRecovery({
			store: f.store,
			bootId: async () => bootId,
			retain: async (authority, capturedBoot) => {
				retained++;
				expect(authority.kind).toBe("native");
				expect(capturedBoot).toBe(bootId);
				return {
					cleanup: async () => {
						cleaned++;
						if (!released) return false;
						await writePrivateJson(f.store, f.key, undefined);
						return true;
					},
				};
			},
		});
		await expect(owner.replay()).rejects.toThrow("incomplete");
		await owner.verify();
		expect(retained).toBe(1);
		expect(cleaned).toBe(1);
		await expect(owner.replay()).rejects.toThrow("incomplete");
		expect(retained).toBe(1);
		expect(cleaned).toBe(2);
		released = true;
		await owner.replay();
		expect(retained).toBe(1);
		expect(cleaned).toBe(3);
		expect(await readPrivateJson(f.store, f.key)).toBeUndefined();
		await owner.replay();
		expect(cleaned).toBe(3);
	} finally {
		await f.close();
	}
});
test("a contended slot never gets a cleanup owner and bad boot or malformed authority dispatches nothing", async () => {
	const f = await fixture();
	let called = 0;
	try {
		const retain = async () => {
			called++;
			return undefined;
		};
		const owner = new CellularHostRecovery({
			store: f.store,
			bootId: async () => bootId,
			retain,
		});
		await expect(owner.replay()).rejects.toThrow("incomplete");
		expect(called).toBe(1);
		await expect(
			new CellularHostRecovery({
				store: f.store,
				bootId: async () => "unknown",
				retain,
			}).replay(),
		).rejects.toThrow("boot identity");
		expect(called).toBe(1);
		await writePrivateJson(f.store, f.key, { invalid: true });
		await expect(owner.replay()).rejects.toThrow();
		expect(called).toBe(1);
	} finally {
		await f.close();
	}
});
test("host writes join the existing mutation revision including failed operations", async () => {
	const dir = process.env.CERALIVE_CELLULAR_HOST_STATE_DIR;
	if (!dir) throw new Error("Private host fixture required");
	const store = cellularHostStore(),
		key = "d".repeat(64),
		before = mutationJournalRevision();
	await writePrivateJson(store, key, { synthetic: true });
	expect(isMutationJournalRevisionCurrent(before)).toBe(false);
	const stable = mutationJournalRevision();
	expect(isMutationJournalRevisionCurrent(stable)).toBe(true);
	await expect(
		writePrivateJson(store, key, { oversize: "x".repeat(4097) }),
	).rejects.toThrow("limit");
	expect(isMutationJournalRevisionCurrent(stable)).toBe(false);
	await writePrivateJson(store, key, undefined);
});

test("a lease-owned uncertain inverse stays quarantined without blocking independent source publication", async () => {
	const f = await fixture();
	let clean = false;
	const lease = await acquirePrivateStateLease(f.store, f.key);
	if (!lease) throw new Error("Synthetic slot lease unavailable");
	initCellularRuntimeAdmission();
	const owner = new CellularHostRecovery({
		store: f.store,
		bootId: async () => bootId,
		retain: async () => ({
			cleanup: async () => {
				if (!clean) return false;
				await writePrivateJson(f.store, f.key, undefined);
				lease.release();
				return true;
			},
		}),
		isolate: isolateCellularHostAuthority,
	});
	try {
		await owner.replay();
		expect(cellularRecoveryReservedSlots()).toContain(1);
		expect(cellularRecoveryExcludes("wwan0", "192.0.2.2")).toBe(true);
		expect(cellularRecoveryExcludes("wwanOther", "192.0.2.2")).toBe(false);
		expect(cellularSourceReady("wwanOther", "192.0.2.2")).toBe(true);
		expect(cellularSourceReady("wwanOther", "192.0.2.10")).toBe(true);
		expect(cellularSourceReady("wwan0", "192.0.2.2")).toBe(false);
		expect(await acquirePrivateStateLease(f.store, f.key)).toBeUndefined();
		expect(await readPrivateJson(f.store, f.key)).toBeDefined();
		await owner.verify();
		expect(await readPrivateJson(f.store, f.key)).toBeDefined();
	} finally {
		clean = true;
		await owner.replay();
		lease.release();
		resetCellularSourcesForTest();
		await f.close();
	}
	expect(cellularRecoveryReservedSlots()).not.toContain(1);
});

test("quarantine cannot substitute for a contended lease or unreadable scope", async () => {
	const f = await fixture();
	let isolated = 0;
	const owner = new CellularHostRecovery({
		store: f.store,
		bootId: async () => bootId,
		retain: async () => undefined,
		isolate: async () => {
			isolated++;
			return true;
		},
	});
	try {
		await expect(owner.replay()).rejects.toThrow("isolation");
		expect(isolated).toBe(0);
		await writePrivateJson(f.store, f.key, { invalid: true });
		await expect(owner.replay()).rejects.toThrow();
		expect(isolated).toBe(0);
	} finally {
		await f.close();
	}
});

test("a quarantined inverse's lost removal acknowledgement releases only after its retained tail settles", async () => {
	const f = await fixture();
	let phase = 0;
	initCellularRuntimeAdmission();
	const owner = new CellularHostRecovery({
		store: f.store,
		bootId: async () => bootId,
		retain: async () => ({
			cleanup: async () => {
				if (phase === 0) return false;
				if (phase === 1) {
					await writePrivateJson(f.store, f.key, undefined);
					phase = 2;
					return false;
				}
				return true;
			},
		}),
		isolate: isolateCellularHostAuthority,
	});
	try {
		await owner.replay();
		expect(cellularRecoveryReservedSlots()).toContain(1);
		phase = 1;
		await expect(owner.replay()).rejects.toThrow("incomplete");
		await expect(owner.verify()).rejects.toThrow("changed");
		expect(cellularRecoveryReservedSlots()).toContain(1);
		await owner.replay();
		expect(cellularRecoveryReservedSlots()).not.toContain(1);
	} finally {
		phase = 2;
		await owner.replay();
		resetCellularSourcesForTest();
		await f.close();
	}
});

test("isolated transient cleanup is visible and retried after the barrier lowers with capped backoff", async () => {
	const f = await fixture();
	let now = 0,
		attempts = 0,
		clean = false;
	initCellularRuntimeAdmission();
	const owner = new CellularHostRecovery({
		store: f.store,
		bootId: async () => bootId,
		now: () => now,
		retain: async () => ({
			cleanup: async () => {
				attempts++;
				if (!clean) return false;
				await writePrivateJson(f.store, f.key, undefined);
				return true;
			},
		}),
		isolate: isolateCellularHostAuthority,
	});
	try {
		await owner.replay();
		expect(owner.status("wwan0")?.reason).toBe("withdrawal-incomplete");
		await owner.retry();
		expect(attempts).toBe(1);
		for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
			now += delay;
			await owner.retry();
		}
		expect(attempts).toBe(9);
		expect(cellularSourceReady("wwanOther", "192.0.2.2")).toBe(true);
		clean = true;
		owner.changed("wwan0");
		await owner.retry();
		expect(attempts).toBe(10);
		expect(owner.status("wwan0")).toBeUndefined();
		expect(cellularRecoveryReservedSlots()).not.toContain(1);
	} finally {
		clean = true;
		await owner.replay();
		resetCellularSourcesForTest();
		await f.close();
	}
});

test("one stalled retry cannot hold another slot and runtime retry never adopts active hosts", async () => {
	const f = await fixture();
	const original = (await readPrivateJson(f.store, f.key)) as Record<
		string,
		unknown
	>;
	const writeSlot = async (slot: number) => {
		const plan = parseCellularNativeHostPlan({
			...f.plan,
			input: { ...f.plan.input, slot, iface: `wwan${slot}` },
		});
		await writePrivateJson(f.store, cellularUplinkSlotKey(slot), {
			...original,
			plan,
		});
	};
	await writeSlot(2);
	let now = 0,
		retrying = false;
	let release!: () => void, secondDone!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const done = new Promise<void>((resolve) => {
		secondDone = resolve;
	});
	const retained: number[] = [];
	initCellularRuntimeAdmission();
	const owner = new CellularHostRecovery({
		store: f.store,
		bootId: async () => bootId,
		now: () => now,
		isolate: isolateCellularHostAuthority,
		retain: async (row) => {
			retained.push(row.slot);
			return {
				cleanup: async () => {
					if (!retrying) return false;
					if (row.slot === 1) await held;
					await writePrivateJson(
						f.store,
						cellularUplinkSlotKey(row.slot),
						undefined,
					);
					if (row.slot === 2) secondDone();
					return true;
				},
			};
		},
	});
	try {
		await owner.replay();
		await writeSlot(3); // a newly installed runtime host, outside quarantine
		retrying = true;
		now = 1000;
		const pending = owner.retry();
		await done;
		expect(
			await readPrivateJson(f.store, cellularUplinkSlotKey(2)),
		).toBeUndefined();
		expect(await readPrivateJson(f.store, f.key)).toBeDefined();
		expect(retained).toEqual([1, 2]);
		release();
		await pending;
		expect(
			await readPrivateJson(f.store, cellularUplinkSlotKey(3)),
		).toBeDefined();
	} finally {
		release();
		resetCellularSourcesForTest();
		await f.close();
	}
});
