import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readPrivateJson,
	writePrivateJson,
} from "../../helpers/private-json-state.ts";
import { acquirePrivateStateLease } from "../../helpers/private-state-lease.ts";
import * as hostInventory from "../network/cellular-host-inventory.ts";
import {
	CellularNativeHost,
	type CellularNativeHostDeps,
} from "../network/cellular-native-host.ts";
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
	isLifecycleHeld,
	resetLifecycleInterlock,
} from "../streaming/lifecycle-admission.ts";
import {
	beginRecoveryBarrier,
	isRecoveryPending,
	resetRecoveryBarrier,
} from "../streaming/recovery-barrier.ts";
import {
	CellularHostRecovery,
	cellularHostStore,
	cellularRecoveryExcludes,
	cellularRecoveryReservedSlots,
	cellularRecoveryStartBlock,
	isolateCellularHostAuthority,
	retainCellularHostInverse,
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
		// The record is gone by this slot's own cleanup. That is progress, not a
		// change of authority: the check that lowers the barrier passes, and the
		// slot stays fenced and reserved until its tail settles.
		await owner.verify();
		expect(cellularRecoveryReservedSlots()).toContain(1);
		expect(cellularRecoveryExcludes("wwan0", "192.0.2.2")).toBe(true);
		expect(cellularRecoveryStartBlock()).toBeUndefined();
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
		now += 1000;
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

test("event storms respect the retry floor and a wake during cleanup survives", async () => {
	const f = await fixture();
	let now = 0,
		calls = 0,
		clean = false;
	let wake: (() => void) | undefined;
	initCellularRuntimeAdmission();
	const owner = new CellularHostRecovery({
		store: f.store,
		bootId: async () => bootId,
		now: () => now,
		isolate: isolateCellularHostAuthority,
		retain: async () => ({
			cleanup: async () => {
				calls++;
				wake?.();
				if (clean) {
					await writePrivateJson(f.store, f.key, undefined);
					return true;
				}
				return false;
			},
		}),
	});
	try {
		await owner.replay();
		for (let i = 0; i < 10; i++) {
			owner.changed("wwan0");
			await owner.retry();
		}
		expect(calls).toBe(1);
		now = 1000;
		await owner.retry();
		expect(calls).toBe(2);
		wake = () => owner.changed("wwan0");
		now = 2000;
		owner.changed("wwan0");
		await owner.retry();
		wake = undefined;
		now = 3000;
		await owner.retry();
		expect(calls).toBe(4);
	} finally {
		clean = true;
		await owner.replay();
		resetCellularSourcesForTest();
		await f.close();
	}
});

test("real retained recovery owns cleanup across the barrier and releases runtime interlocks on false and throw", async () => {
	const f = await fixture();
	let now = 0;
	let outcome: "false" | "throw" | "true" = "false";
	let runtimeChecks = 0;
	// Kernel I/O is replaced here; the actual retain function, slot lease,
	// owned predicate, census callback, attempt wrapper and recovery class run.
	const kernel = spyOn(
		CellularNativeHost.prototype,
		"cleanup",
	).mockImplementation(async function (this: CellularNativeHost) {
		const deps = Reflect.get(this, "deps") as CellularNativeHostDeps;
		if (!deps.owned() || !(await deps.consumersReleased())) return false;
		await writePrivateJson(f.store, f.key, undefined);
		return true;
	});
	resetRecoveryBarrier();
	resetLifecycleInterlock();
	beginRecoveryBarrier();
	initCellularRuntimeAdmission();
	const owner = new CellularHostRecovery({
		store: f.store,
		now: () => now,
		bootId: async () => bootId,
		isolate: isolateCellularHostAuthority,
		retain: (row, boot) =>
			retainCellularHostInverse(row, boot, f.store, async () => {
				if (!isRecoveryPending()) {
					runtimeChecks++;
					expect(isLifecycleHeld()).toBe(true);
				}
				if (outcome === "throw") throw new Error("transient census failure");
				return outcome === "true";
			}),
	});
	try {
		await owner.replay();
		resetRecoveryBarrier();
		now = 1000;
		await owner.retry();
		expect(isLifecycleHeld()).toBe(false);
		outcome = "throw";
		now = 3000;
		await owner.retry();
		expect(isLifecycleHeld()).toBe(false);
		expect(isRecoveryPending()).toBe(false);
		outcome = "true";
		now = 7000;
		await owner.retry();
		expect(runtimeChecks).toBe(3);
		expect(await readPrivateJson(f.store, f.key)).toBeUndefined();
		expect(cellularRecoveryReservedSlots()).not.toContain(1);
		expect(isLifecycleHeld()).toBe(false);
	} finally {
		outcome = "true";
		resetRecoveryBarrier();
		await owner.replay();
		kernel.mockRestore();
		resetLifecycleInterlock();
		resetCellularSourcesForTest();
		await f.close();
	}
});

test("retry read faults stay scoped and back off", async () => {
	const f = await fixture();
	let now = 0,
		clean = false,
		calls = 0;
	resetRecoveryBarrier();
	initCellularRuntimeAdmission();
	const owner = new CellularHostRecovery({
		store: f.store,
		now: () => now,
		bootId: async () => bootId,
		isolate: isolateCellularHostAuthority,
		retain: async () => ({
			cleanup: async () => {
				calls++;
				if (!clean) throw new Error("transient cleanup I/O");
				await writePrivateJson(f.store, f.key, undefined);
				return true;
			},
		}),
	});
	try {
		await owner.replay();
		const io = spyOn(
			hostInventory,
			"inventoryCellularHosts",
		).mockRejectedValueOnce(new Error("transient inventory read"));
		try {
			now = 1000;
			await owner.retry();
		} finally {
			io.mockRestore();
		}
		expect(isRecoveryPending()).toBe(false);
		expect(calls).toBe(1);
		now = 3000;
		await owner.retry();
		expect(isRecoveryPending()).toBe(false);
		expect(calls).toBe(2);
		await owner.retry();
		expect(calls).toBe(2);
	} finally {
		clean = true;
		resetRecoveryBarrier();
		await owner.replay();
		resetCellularSourcesForTest();
		await f.close();
	}
});

/*
    The barrier invariants for a quarantined slot:

    B1  The slot's own cleanup progress (cursor, phase, a removed record) is
        never read as a change of authority, by a retry or by the check that
        lowers the barrier, whatever reads failed in between.
    B2  A replaced authority is a verdict about that slot. The slot stays
        fenced under both identities, its cleanup is held, new streams are
        refused, and the global barrier stays down.
    B3  A barrier raised for any other reason can be lowered while a slot is
        quarantined: nothing it waits for is held back by the barrier itself.
*/
test("B1: a cleanup that advanced its record and threw, then one unreadable inventory, raises nothing", async () => {
	const f = await fixture();
	let now = 0,
		mode: "refuse" | "advance-and-throw" | "finish" = "refuse",
		failNextRead = false;
	resetRecoveryBarrier();
	initCellularRuntimeAdmission();
	const owner = new CellularHostRecovery({
		store: f.store,
		now: () => now,
		bootId: async () => bootId,
		isolate: isolateCellularHostAuthority,
		retain: async () => ({
			cleanup: async () => {
				if (mode === "refuse") return false;
				if (mode === "finish") {
					await writePrivateJson(f.store, f.key, undefined);
					return true;
				}
				// A real withdrawal records its progress before each kernel step.
				const record = (await readPrivateJson(f.store, f.key)) as {
					cursor: number;
				};
				await writePrivateJson(f.store, f.key, {
					...record,
					cursor: record.cursor - 1,
					phase: "withdrawing",
				});
				failNextRead = true;
				throw new Error("kernel step timed out");
			},
		}),
	});
	const read = hostInventory.inventoryCellularHosts;
	const inventory = spyOn(
		hostInventory,
		"inventoryCellularHosts",
	).mockImplementation(async (store) => {
		if (failNextRead) {
			failNextRead = false;
			throw Object.assign(new Error("EIO"), { code: "EIO" });
		}
		return read(store);
	});
	try {
		await owner.replay();
		mode = "advance-and-throw";
		now = 1000;
		await owner.retry();
		mode = "refuse";
		for (const at of [10_000, 100_000, 200_000]) {
			now = at;
			await owner.retry();
			expect(isRecoveryPending()).toBe(false);
			expect(cellularRecoveryStartBlock()).toBeUndefined();
		}
		// An unrelated fault raised the barrier; this slot must not keep it up.
		await owner.verify();
		expect(owner.status("wwan0")?.reason).toBe("withdrawal-incomplete");
		expect(cellularRecoveryExcludes("wwan0", "192.0.2.2")).toBe(true);
		mode = "finish";
		now = 300_000;
		await owner.retry();
		expect(cellularRecoveryReservedSlots()).not.toContain(1);
		expect(isRecoveryPending()).toBe(false);
	} finally {
		inventory.mockRestore();
		mode = "finish";
		resetRecoveryBarrier();
		await owner.replay();
		resetCellularSourcesForTest();
		await f.close();
	}
});

test("B2: a replaced authority stays a slot verdict — fenced twice, cleanup held, starts refused, barrier down", async () => {
	const f = await fixture();
	let now = 0,
		clean = false,
		calls = 0;
	resetRecoveryBarrier();
	initCellularRuntimeAdmission();
	const owner = new CellularHostRecovery({
		store: f.store,
		now: () => now,
		bootId: async () => bootId,
		isolate: isolateCellularHostAuthority,
		retain: async () => ({
			cleanup: async () => {
				calls++;
				if (!clean) return false;
				await writePrivateJson(f.store, f.key, undefined);
				return true;
			},
		}),
	});
	const raw = (await readPrivateJson(f.store, f.key)) as Record<
		string,
		unknown
	>;
	const replacement = parseCellularNativeHostPlan({
		...f.plan,
		input: { ...f.plan.input, epoch: "another", iface: "wwan7" },
	});
	try {
		await owner.replay();
		expect(calls).toBe(1);
		await writePrivateJson(f.store, f.key, {
			...raw,
			epoch: "another",
			plan: replacement,
			steps: cellularNativeHostSteps(replacement),
		});
		now = 1000;
		await owner.retry();
		// The retained owner has no authority over the record it found.
		expect(calls).toBe(1);
		expect(isRecoveryPending()).toBe(false);
		expect(cellularRecoveryStartBlock()?.stableKey).toContain("slot-1");
		expect(owner.status("wwan0")?.reason).toBe("authority-changed");
		expect(owner.status("wwan7")?.reason).toBe("authority-changed");
		expect(cellularRecoveryExcludes("wwan0", "192.0.2.2")).toBe(true);
		expect(cellularRecoveryExcludes("wwan7", "192.0.2.2")).toBe(true);
		expect(cellularRecoveryExcludes("wwanOther", "192.0.2.9")).toBe(false);
		expect(cellularSourceReady("wwanOther", "192.0.2.9")).toBe(true);
		expect(cellularRecoveryReservedSlots()).toContain(1);
		// The lowering check reaches the same verdict and still passes.
		await owner.verify();
		expect(isRecoveryPending()).toBe(false);
		expect(cellularRecoveryStartBlock()).toBeDefined();
		now = 10_000;
		await owner.retry();
		expect(calls).toBe(1);
		// Its own authority again: the hold ends and cleanup resumes.
		await writePrivateJson(f.store, f.key, raw);
		now = 100_000;
		await owner.retry();
		expect(calls).toBe(2);
		expect(cellularRecoveryStartBlock()).toBeUndefined();
		expect(cellularRecoveryExcludes("wwan7", "192.0.2.2")).toBe(false);
		expect(owner.status("wwan0")?.reason).toBe("withdrawal-incomplete");
		clean = true;
		now = 200_000;
		await owner.retry();
		expect(cellularRecoveryReservedSlots()).not.toContain(1);
		expect(cellularRecoveryExcludes("wwan0", "192.0.2.2")).toBe(false);
	} finally {
		clean = true;
		await writePrivateJson(f.store, f.key, raw).catch(() => {});
		resetRecoveryBarrier();
		await owner.replay();
		resetCellularSourcesForTest();
		await f.close();
	}
	expect(cellularRecoveryStartBlock()).toBeUndefined();
});

test("B3: a verdict first reached by the lowering check does not need a retry to stand or to clear", async () => {
	const f = await fixture();
	const now = 0;
	resetRecoveryBarrier();
	initCellularRuntimeAdmission();
	const owner = new CellularHostRecovery({
		store: f.store,
		now: () => now,
		bootId: async () => bootId,
		isolate: isolateCellularHostAuthority,
		retain: async () => ({ cleanup: async () => false }),
	});
	const raw = (await readPrivateJson(f.store, f.key)) as Record<
		string,
		unknown
	>;
	const replacement = parseCellularNativeHostPlan({
		...f.plan,
		input: { ...f.plan.input, epoch: "another" },
	});
	try {
		await owner.replay();
		// The barrier is up for an unrelated fault, which also holds the retries.
		beginRecoveryBarrier();
		await writePrivateJson(f.store, f.key, {
			...raw,
			epoch: "another",
			plan: replacement,
			steps: cellularNativeHostSteps(replacement),
		});
		await owner.verify();
		expect(cellularRecoveryStartBlock()).toBeDefined();
		await writePrivateJson(f.store, f.key, raw);
		await owner.verify();
		expect(cellularRecoveryStartBlock()).toBeUndefined();
		expect(cellularRecoveryReservedSlots()).toContain(1);
		// Unreadable authority is still what this check refuses on.
		await writePrivateJson(f.store, f.key, { invalid: true });
		await expect(owner.verify()).rejects.toThrow();
		await writePrivateJson(f.store, f.key, raw);
	} finally {
		resetRecoveryBarrier();
		await writePrivateJson(f.store, f.key, undefined);
		await owner.replay().catch(() => {});
		resetCellularSourcesForTest();
		await f.close();
	}
});
