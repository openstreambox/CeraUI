import { expect, test } from "bun:test";
import {
	findInternalCallUnit,
	type InternalCallUnitLookupDeps,
	internalCallSubscriptionKey,
	internalCallUnitKey,
} from "./internal-call-unit.ts";
import type { CellularControlTarget } from "./modems.ts";

const equipment = "000000000000001",
	other = "000000000000002";
const physical = {
	ifname: "wwan0",
	ifindex: "17",
	usbDevice: "synthetic-usb",
	netDevice: "synthetic-net",
	generation: "one",
};
const unit = internalCallUnitKey(equipment);
if (!unit) throw new Error("Synthetic unit unavailable");
const reference = { stableKey: "synthetic-key", unit, physical };
function fixture() {
	let ids: readonly number[] | undefined = [7, 12],
		second: readonly number[] | undefined = ids,
		lists = 0;
	const target = {
		id: 12,
		key: reference.stableKey,
		equipment,
		...physical,
		subscriber: "000000000000003",
		simId: "synthetic-new-sim",
		identity: {
			model: "FM350-GL",
			firmware: "81600.0000.00.29.18.01",
			mode: "rndis",
		},
	} as CellularControlTarget;
	const calls: number[] = [];
	const deps: InternalCallUnitLookupDeps = {
		list: async () => (++lists === 1 ? ids : second),
		info: async (id) => ({
			uid: id === 7 ? "unrelated-without-sim" : "current-unit",
			equipment: id === 7 ? other : equipment,
		}),
		resolveUid: async (uid) =>
			uid === "current-unit" ? physical.usbDevice : "unrelated-usb",
		target: async (id, key) => {
			calls.push(id);
			expect(key).toBe(reference.stableKey);
			return target;
		},
	};
	return {
		deps,
		target,
		calls,
		set: (first: readonly number[] | undefined, next = first) => {
			ids = first;
			second = next;
		},
	};
}
test("fresh unit lookup uses current identity, not the former MM index or SIM allocation", async () => {
	const f = fixture();
	expect(await findInternalCallUnit(reference, f.deps)).toEqual(f.target);
	expect(f.calls).toEqual([12]);
});
test("duplicate, invalid or changing rosters cannot select a remembered object", async () => {
	for (const ids of [
		undefined,
		[12, 12],
		[-1],
		[1.5],
		Array.from({ length: 33 }, (_v, i) => i),
	]) {
		const f = fixture();
		f.set(ids);
		expect(await findInternalCallUnit(reference, f.deps)).toBeUndefined();
		expect(f.calls).toEqual([]);
	}
	const changed = fixture();
	changed.set([7, 12], [7, 13]);
	expect(await findInternalCallUnit(reference, changed.deps)).toBeUndefined();
	const duplicate = fixture();
	duplicate.set([12, 13]);
	expect(
		await findInternalCallUnit(reference, {
			...duplicate.deps,
			target: async (id) => ({ ...duplicate.target, id }),
		}),
	).toBeUndefined();
});
test("unit replacement, missing identity and wrong generation or firmware issue no control command", async () => {
	for (const update of [
		{ equipment: other },
		{ generation: "two" },
		{ ifindex: "18" },
		{ key: "other-key" },
		{
			identity: {
				model: "FM350-GL",
				firmware: "unknown",
				mode: "rndis" as const,
			},
		},
	]) {
		const f = fixture();
		expect(
			await findInternalCallUnit(reference, {
				...f.deps,
				target: async () => ({ ...f.target, ...update }),
			}),
		).toBeUndefined();
	}
	for (const info of [
		undefined,
		{ equipment: equipment },
		{
			equipment: other,
			uid: "current-unit",
		},
	]) {
		const f = fixture();
		f.set([12]);
		expect(
			await findInternalCallUnit(reference, {
				...f.deps,
				info: async () => info,
			}),
		).toBeUndefined();
		expect(f.calls).toEqual([]);
	}
});
test("caller mutation after lookup starts cannot change the captured physical generation", async () => {
	const f = fixture(),
		frame = { ...reference, physical: { ...physical } },
		list = f.deps.list;
	const result = await findInternalCallUnit(frame, {
		...f.deps,
		list: async () => {
			frame.physical.generation = "two";
			return list();
		},
	});
	expect(result?.generation).toBe("one");
});
test("opaque identity helpers reject unobserved identifiers without becoming carrier selectors", () => {
	expect(internalCallUnitKey(equipment)).toMatch(/^[a-f0-9]{64}$/);
	expect(internalCallSubscriptionKey(equipment)).toMatch(/^[a-f0-9]{64}$/);
	expect(internalCallSubscriptionKey(equipment)).not.toBe(
		internalCallUnitKey(equipment),
	);
	for (const value of [
		"",
		"unknown",
		`${equipment}\n`,
		"123",
		`${equipment}tail`,
	]) {
		expect(internalCallUnitKey(value)).toBeUndefined();
		expect(internalCallSubscriptionKey(value)).toBeUndefined();
	}
});
