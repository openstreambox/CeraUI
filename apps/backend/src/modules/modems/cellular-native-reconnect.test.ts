import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getMutationBlocks,
	resetLifecycleInterlock,
	tryAcquireLifecycle,
	tryAcquireModemMutation,
} from "../streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../streaming/recovery-barrier.ts";
import {
	type CellularNativeReconnectDeps,
	type CellularNativeReconnectObservation,
	parseCellularNativeReconnectBaseline,
	reconnectCellularNative,
	restoreCellularNativeReconnect,
} from "./cellular-native-reconnect.ts";
import {
	readMutationEntry,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "./mutation-journal.ts";
import { withJournaledModemMutation } from "./mutation-lease.ts";

const baseline = parseCellularNativeReconnectBaseline({
	format: "cellular-native-reconnect-v1",
	uuid: "00000000-0000-4000-8000-000000000001",
	deviceId: "synthetic-device",
	simId: "synthetic-sim",
	subscriber: "synthetic-subscription",
	equipment: "synthetic-unit",
	model: "synthetic-native",
	firmware: "admitted",
	mode: "mbim",
	homeDigest: "a".repeat(64),
	profileDigest: "b".repeat(64),
});
function fixture() {
	let observation: CellularNativeReconnectObservation | undefined = {
			baseline,
			physicalGeneration: "one",
			state: "active",
			prepared: true,
		},
		withdrawn = true,
		now = 0,
		throwReplies = false,
		afterArm = () => {},
		afterExecuting = () => {},
		afterDown = () => {},
		afterUp = () => {};
	const events: string[] = [];
	const deps: CellularNativeReconnectDeps = {
		now: () => now,
		read: async () => {
			events.push("read");
			return observation;
		},
		disconnect: async () => {
			events.push("down");
			if (observation) observation = { ...observation, state: "idle" };
			afterDown();
			if (throwReplies) throw new Error("lost down reply");
		},
		connect: async () => {
			events.push("up");
			if (observation) observation = { ...observation, state: "active" };
			afterUp();
			if (throwReplies) throw new Error("lost up reply");
		},
		journal: async (_key, _kind, state, run) => {
			expect(state).toEqual(baseline);
			events.push("armed");
			afterArm();
			const result = await run({
				entry: {} as never,
				markExecuting: async () => {
					events.push("executing");
					afterExecuting();
				},
				markFailed: async () => {},
			});
			events.push(result.confirmed ? "retired" : "retained");
			return { ok: true, value: result.value };
		},
	};
	return {
		deps,
		events,
		run: () =>
			reconnectCellularNative("synthetic-key", baseline, () => withdrawn, deps),
		set: (value: {
			observation?: CellularNativeReconnectObservation | null;
			withdrawn?: boolean;
			now?: number;
			throwReplies?: boolean;
			afterArm?: () => void;
			afterExecuting?: () => void;
			afterDown?: () => void;
			afterUp?: () => void;
		}) => {
			if (value.observation !== undefined)
				observation = value.observation ?? undefined;
			if (value.withdrawn !== undefined) withdrawn = value.withdrawn;
			if (value.now !== undefined) now = value.now;
			if (value.throwReplies !== undefined) throwReplies = value.throwReplies;
			if (value.afterArm) afterArm = value.afterArm;
			if (value.afterExecuting) afterExecuting = value.afterExecuting;
			if (value.afterDown) afterDown = value.afterDown;
			if (value.afterUp) afterUp = value.afterUp;
		},
	};
}
test("native reconnect journals before either host call and confirms the same fresh active profile", async () => {
	const f = fixture();
	expect(await f.run()).toBe(true);
	expect(f.events.filter((event) => event !== "read")).toEqual([
		"armed",
		"executing",
		"down",
		"up",
		"retired",
	]);
	const lost = fixture();
	lost.set({ throwReplies: true });
	expect(await lost.run()).toBe(true);
	expect(lost.events.at(-1)).toBe("retired");
});
test("unknown presence, missing preparation, wrong profile and missing withdrawal cannot arm or dispatch", async () => {
	for (const observation of [
		null,
		{
			baseline,
			physicalGeneration: "one",
			state: "active" as const,
			prepared: false,
		},
		{
			baseline: { ...baseline, simId: "replacement" },
			physicalGeneration: "one",
			state: "active" as const,
			prepared: true,
		},
		{
			baseline,
			physicalGeneration: "one",
			state: "idle" as const,
			prepared: true,
		},
	]) {
		const f = fixture();
		f.set({ observation });
		expect(await f.run()).toBe(false);
		expect(f.events).not.toContain("armed");
	}
	const f = fixture();
	f.set({ withdrawn: false });
	expect(await f.run()).toBe(false);
	expect(f.events).toEqual([]);
});
test("late pair or permit change before dispatch retires only an unused journal", async () => {
	for (const point of ["afterArm", "afterExecuting"] as const) {
		const f = fixture();
		f.set({ [point]: () => f.set({ withdrawn: false }) });
		expect(await f.run()).toBe(false);
		expect(f.events).not.toContain("down");
		expect(f.events.at(-1)).toBe("retired");
	}
});
test("USB loss, SIM change, unknown reply or deadline after down retains the inverse and never sends up", async () => {
	for (const change of [
		{ observation: null },
		{
			observation: {
				baseline,
				physicalGeneration: "replacement-usb",
				state: "idle" as const,
				prepared: true,
			},
		},
		{
			observation: {
				baseline: { ...baseline, homeDigest: "c".repeat(64) },
				physicalGeneration: "one",
				state: "idle" as const,
				prepared: true,
			},
		},
		{
			observation: {
				baseline,
				physicalGeneration: "one",
				state: "active" as const,
				prepared: true,
			},
		},
		{ withdrawn: false },
		{ now: 90_000 },
	]) {
		const f = fixture();
		f.set({ afterDown: () => f.set(change) });
		expect(await f.run()).toBe(false);
		expect(f.events).toContain("down");
		expect(f.events).not.toContain("up");
		expect(f.events.at(-1)).toBe("retained");
	}
});
test("an unconfirmed up stays journaled; a lease refusal dispatches nothing", async () => {
	const f = fixture();
	f.set({ afterUp: () => f.set({ observation: null }) });
	expect(await f.run()).toBe(false);
	expect(f.events.at(-1)).toBe("retained");
	const refused = fixture();
	expect(
		await reconnectCellularNative("synthetic-key", baseline, () => true, {
			...refused.deps,
			journal: async () => ({ ok: false, refusal: "mutation_in_progress" }),
		}),
	).toBe(false);
	expect(refused.events).not.toContain("down");
});
test("startup restoration never disconnects and needs positive preparation before a new call", async () => {
	const active = fixture();
	expect(
		await restoreCellularNativeReconnect(
			"synthetic-key",
			baseline,
			active.deps,
		),
	).toBe("restored");
	expect(active.events).not.toContain("up");
	const idle = fixture();
	idle.set({
		observation: {
			baseline,
			physicalGeneration: "new-boot",
			state: "idle",
			prepared: true,
		},
	});
	expect(
		await restoreCellularNativeReconnect("synthetic-key", baseline, idle.deps),
	).toBe("restored");
	expect(idle.events).toEqual(["read", "up", "read"]);
	const unprepared = fixture();
	unprepared.set({
		observation: {
			baseline,
			physicalGeneration: "new-boot",
			state: "idle",
			prepared: false,
		},
	});
	expect(
		await restoreCellularNativeReconnect(
			"synthetic-key",
			baseline,
			unprepared.deps,
		),
	).toBe("failed");
	expect(unprepared.events).not.toContain("up");
	expect(
		await restoreCellularNativeReconnect(
			"synthetic-key",
			{ ...baseline, unexpected: true },
			active.deps,
		),
	).toBe("failed");
});

test("the actual journal is executing on disk before down, excludes admission, and retains an uncertain effect", async () => {
	const directory = await mkdtemp(
			join(tmpdir(), "cellular-reconnect-journal-"),
		),
		key = "synthetic-key";
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	setMutationJournalDeps({ dir: directory });
	try {
		const first = fixture();
		const actual: CellularNativeReconnectDeps = {
			...first.deps,
			journal: withJournaledModemMutation,
			disconnect: async (uuid) => {
				const entry = await readMutationEntry(key);
				expect(entry?.state).toBe("executing");
				expect(entry?.preState).toEqual(baseline);
				expect(tryAcquireLifecycle("streaming").admitted).toBe(false);
				await first.deps.disconnect(uuid);
			},
		};
		expect(
			await reconnectCellularNative(key, baseline, () => true, actual),
		).toBe(true);
		expect(await readMutationEntry(key)).toBeUndefined();
		const held = tryAcquireModemMutation(key);
		expect(held.admitted).toBe(true);
		try {
			const refused = fixture();
			expect(
				await reconnectCellularNative(key, baseline, () => true, {
					...refused.deps,
					journal: withJournaledModemMutation,
				}),
			).toBe(false);
			expect(refused.events).not.toContain("down");
			expect(await readMutationEntry(key)).toBeUndefined();
		} finally {
			if (held.admitted) held.lease.release();
		}
		const uncertain = fixture();
		uncertain.set({ afterDown: () => uncertain.set({ observation: null }) });
		expect(
			await reconnectCellularNative(key, baseline, () => true, {
				...uncertain.deps,
				journal: withJournaledModemMutation,
			}),
		).toBe(false);
		expect((await readMutationEntry(key))?.state).toBe("failed");
		expect(getMutationBlocks().some((block) => block.stableKey === key)).toBe(
			true,
		);
		expect(uncertain.events).not.toContain("up");
	} finally {
		resetMutationJournalDeps();
		resetLifecycleInterlock();
		resetRecoveryBarrier();
		await rm(directory, { recursive: true, force: true });
	}
});
