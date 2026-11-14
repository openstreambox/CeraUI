import { expect, test } from "bun:test";
import {
	type CellularBudgetDeps,
	type CellularBudgetRecord,
	CellularProbeBudget,
} from "./cellular-probe-budget.ts";

function fixture() {
	let disk: unknown,
		now = 86_400_000,
		writeFails = false,
		acquired = true;
	const events: string[] = [];
	const deps: CellularBudgetDeps = {
		now: () => now,
		acquire: async () =>
			acquired
				? {
						release: () => {
							events.push("release");
						},
					}
				: undefined,
		read: async () => structuredClone(disk),
		write: async (record) => {
			events.push("reserve");
			if (writeFails) throw new Error("durability");
			disk = structuredClone(record);
		},
	};
	const budget = () => new CellularProbeBudget("a".repeat(64), 100, deps);
	return {
		budget,
		events,
		record: () => disk as CellularBudgetRecord,
		set: (value: {
			now?: number;
			writeFails?: boolean;
			acquired?: boolean;
			disk?: unknown;
		}) => {
			if (value.now !== undefined) now = value.now;
			if (value.writeFails !== undefined) writeFails = value.writeFails;
			if (value.acquired !== undefined) acquired = value.acquired;
			if ("disk" in value) disk = value.disk;
		},
	};
}
test("probe reservations survive owner restart and refuse before dispatch when spent", async () => {
	const f = fixture();
	expect(await f.budget().reserve(60)).toEqual({ remaining: 40 });
	expect(await f.budget().reserve(60)).toBeUndefined();
	expect(await f.budget().reserve(40)).toEqual({ remaining: 0 });
	expect(f.record().used).toBe(100);
	expect(f.events.filter((event) => event === "release")).toHaveLength(3);
});
test("clock changes and a brief calendar boundary cannot refill a budget", async () => {
	const f = fixture();
	await f.budget().reserve(100);
	f.set({ now: 86_400_000 - 1 });
	expect(await f.budget().reserve(1)).toBeUndefined();
	f.set({ now: 2 * 86_400_000 });
	expect(await f.budget().reserve(100)).toEqual({ remaining: 0 });
	f.set({ now: 3 * 86_400_000 - 1 });
	expect(await f.budget().reserve(1)).toBeUndefined();
	const g = fixture();
	g.set({ now: 2 * 86_400_000 - 100 });
	await g.budget().reserve(100);
	g.set({ now: 2 * 86_400_000 + 100 });
	expect(await g.budget().reserve(1)).toBeUndefined();
});
test("unknown records, failed persistence and contended locks grant no allowance", async () => {
	const f = fixture();
	f.set({ writeFails: true });
	await expect(f.budget().reserve(1)).rejects.toThrow("durability");
	expect(f.events.at(-1)).toBe("release");
	f.set({ acquired: false });
	expect(await f.budget().reserve(1)).toBeUndefined();
	f.set({ acquired: true, disk: { version: 2 } });
	await expect(f.budget().reserve(1)).rejects.toThrow();
});
