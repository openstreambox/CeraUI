import { expect, test } from "bun:test";
import { observeCellularNativeBearer } from "./cellular-network-observation.ts";
import type { CellularNetworkTarget } from "./modems.ts";

const original: CellularNetworkTarget = {
	id: 3,
	key: "synthetic-key",
	deviceId: "synthetic-device",
	simId: "synthetic-sim",
	subscriber: "synthetic-subscription",
	equipment: "synthetic-unit",
	ifname: "wwan0",
	ifindex: "17",
	usbDevice: "synthetic-usb",
	netDevice: "synthetic-link",
	generation: "one",
	identity: { model: "Unlisted", firmware: "unlisted", mode: "mbim" },
	sim: {} as never,
};
test("unlisted native bearers are read without vendor control; recycled identities discard observations", async () => {
	let target = original,
		calls = 0;
	const deps = {
		target: async () => target,
		bearer: async (
			_id: number,
			_iface: string,
			current: () => Promise<boolean>,
		) => {
			calls++;
			expect(await current()).toBe(true);
			return {
				path: "/org/freedesktop/ModemManager1/Bearer/1",
				iface: "wwan0",
			};
		},
	};
	expect(await observeCellularNativeBearer(original, deps)).toBeDefined();
	for (const changed of [
		{ simId: "other-sim" },
		{ subscriber: "other-subscription" },
		{ generation: "two" },
		{ ifindex: "18" },
		{ deviceId: "other-unit" },
	]) {
		target = { ...original, ...changed };
		expect(await observeCellularNativeBearer(original, deps)).toBeUndefined();
	}
	expect(calls).toBe(1);
	target = original;
	expect(
		await observeCellularNativeBearer(original, {
			...deps,
			bearer: async () => {
				target = { ...original, simId: "changed-during-read" };
				return {
					path: "/org/freedesktop/ModemManager1/Bearer/1",
					iface: "wwan0",
				};
			},
		}),
	).toBeUndefined();
});
