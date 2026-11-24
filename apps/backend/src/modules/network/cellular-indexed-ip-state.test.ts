import { expect, test } from "bun:test";
import {
	type CellularIndexedIpIO,
	CellularIndexedIpState,
} from "./cellular-indexed-ip-state.ts";

test("a duplicate proxy, foreign attribute or uncertain identity never grants write authority", async () => {
	const effect = { kind: "proxy", family: 6, address: "2001:db8::1" } as const;
	let inventory: unknown = [],
		identity: Awaited<ReturnType<CellularIndexedIpIO["identity"]>> = "present",
		writes = 0;
	const state = new CellularIndexedIpState(
		{ name: "wwan0", index: 7 },
		[effect],
		{
			identity: async () => identity,
			read: async () => JSON.stringify(inventory),
			write: async (_index, _effect, op) => {
				writes++;
				inventory =
					op === "add"
						? [{ dst: effect.address, dev: "wwan0", proxy: null }]
						: [];
				return true;
			},
		},
	);
	await state.apply(effect);
	expect(await state.inspect(effect)).toBe("owned");
	await expect(state.apply(effect)).rejects.toThrow("birth changed");
	expect(writes).toBe(1);
	inventory = [
		{ dst: effect.address, dev: "wwan0", proxy: null, flags: ["extern_learn"] },
	];
	expect(await state.remove(effect)).toBe(false);
	expect(writes).toBe(1);
	inventory = [{ dst: effect.address, dev: "wwan0", proxy: true }];
	expect(await state.remove(effect)).toBe(false);
	identity = "unknown";
	inventory = [];
	expect(await state.remove(effect)).toBe(false);
	identity = "absent";
	expect(await state.remove(effect)).toBe(true);
	expect(writes).toBe(1);
});

test("address cleanup requires an exact permanent host address and current index, never a changed prefix or lifetime", async () => {
	const effect = {
			kind: "address",
			family: 4,
			address: "198.18.255.1",
			prefix: 32,
		} as const,
		row = {
			family: "inet",
			local: effect.address,
			prefixlen: 32,
			scope: "global",
			label: "cclat1",
			noprefixroute: true,
			valid_life_time: 0xffffffff,
			preferred_life_time: 0xffffffff,
		};
	let address: unknown = row,
		index = 7,
		writes = 0;
	const state = new CellularIndexedIpState(
		{ name: "cclat1", index: 7 },
		[effect],
		{
			identity: async () => "present",
			read: async () =>
				JSON.stringify([
					{ ifindex: index, ifname: "cclat1", addr_info: [address] },
				]),
			write: async () => {
				writes++;
				return true;
			},
		},
	);
	expect(await state.inspect(effect)).toBe("owned");
	for (const patch of [
		{ prefixlen: 24 },
		{ preferred_life_time: 30 },
		{ peer: "198.18.255.2" },
		{ dynamic: true },
	]) {
		address = { ...row, ...patch };
		expect(await state.remove(effect)).toBe(false);
	}
	address = row;
	index = 8;
	expect(await state.remove(effect)).toBe(false);
	expect(writes).toBe(0);
});
test("removing one recorded address preserves another address on the same interface", async () => {
	const effect = {
			kind: "address",
			family: 4,
			address: "198.18.255.1",
			prefix: 32,
		} as const,
		mine = {
			family: "inet",
			local: effect.address,
			prefixlen: 32,
			scope: "global",
			label: "cclat1",
			noprefixroute: true,
			valid_life_time: 0xffffffff,
			preferred_life_time: 0xffffffff,
		},
		foreign = {
			family: "inet6",
			local: "2001:db8::99",
			prefixlen: 64,
			scope: "global",
			dynamic: true,
			valid_life_time: 30,
			preferred_life_time: 20,
		};
	let addresses = [mine, foreign];
	const state = new CellularIndexedIpState(
		{ name: "cclat1", index: 7 },
		[effect],
		{
			identity: async () => "present",
			read: async () =>
				JSON.stringify([
					{ ifindex: 7, ifname: "cclat1", addr_info: addresses },
				]),
			write: async (index, selected, op) => {
				expect([index, selected, op]).toEqual([7, effect, "del"]);
				addresses = [foreign];
				return true;
			},
		},
	);
	expect(await state.remove(effect)).toBe(true);
	expect(addresses).toEqual([foreign]);
});
