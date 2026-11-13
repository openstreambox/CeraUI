import { expect, test } from "bun:test";
import type { ReadyModemSim } from "./modem-registration.ts";
import {
	type CellularNetworkTarget,
	findCellularNetworkTarget,
} from "./modems.ts";

const pair = { deviceId: "synthetic-device", simId: "synthetic-sim" },
	key = "synthetic-key";
test("fresh target lookup follows the exact pair across MM renumbering and refuses ambiguous or changed identity", async () => {
	const calls: number[] = [];
	let ids: readonly number[] | undefined = [9],
		changed = false;
	const deps = {
		list: async () => ids,
		sim: async () =>
			({
				modemInfo: { "modem.generic.device-identifier": pair.deviceId },
				simInfo: { "sim.properties.iccid": pair.simId },
			}) as unknown as ReadyModemSim,
		target: async (id: number, stableKey: string) => {
			calls.push(id);
			return {
				id,
				key: stableKey,
				...pair,
				...(changed ? { simId: "replacement" } : {}),
			} as unknown as CellularNetworkTarget;
		},
	};
	expect((await findCellularNetworkTarget(key, pair, deps))?.id).toBe(9);
	expect(calls).toEqual([9]);
	ids = [12];
	expect((await findCellularNetworkTarget(key, pair, deps))?.id).toBe(12);
	ids = [9, 12];
	expect(await findCellularNetworkTarget(key, pair, deps)).toBeUndefined();
	ids = [9, 9];
	expect(await findCellularNetworkTarget(key, pair, deps)).toBeUndefined();
	ids = [9];
	changed = true;
	expect(await findCellularNetworkTarget(key, pair, deps)).toBeUndefined();
	ids = undefined;
	expect(await findCellularNetworkTarget(key, pair, deps)).toBeUndefined();
});
