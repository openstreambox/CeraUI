import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readPrivateJson,
	writePrivateJson,
} from "../../helpers/private-json-state.ts";
import {
	cellularNativeHostSteps,
	cellularUplinkSlotKey,
	parseCellularNativeHostPlan,
} from "../network/cellular-native-host-plan.ts";
import {
	CellularHostRecovery,
	cellularHostStore,
} from "./cellular-host-recovery.ts";
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
