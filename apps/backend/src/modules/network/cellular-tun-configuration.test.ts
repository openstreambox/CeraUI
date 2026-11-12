import { expect, test } from "bun:test";
import { type CellularTunIO, cellularTunAlias } from "./cellular-tun.ts";
import {
	configureCellularTun,
	quiesceCellularTun,
	verifyCellularTunConfiguration,
} from "./cellular-tun-configuration.ts";

const plan = {
	slot: 1,
	owner: "a".repeat(64),
	epoch: "one",
	index: 7,
	linkMtu: 1280,
};
test("retirement, a replacement index and a down interface cannot grant configured readiness", async () => {
	let index = 7,
		reads = 0;
	const io: CellularTunIO = {
		current: async () => true,
		links: async () => {
			reads++;
			return [
				{
					ifname: "cclat1",
					ifindex: index,
					ifalias: cellularTunAlias(plan.owner, plan.epoch),
					mtu: 1280,
					flags: [],
					linkinfo: {
						info_kind: "tun",
						info_data: {
							type: "tun",
							pi: true,
							persist: true,
							multi_queue: false,
						},
					},
				},
			];
		},
	};
	expect(await configureCellularTun(plan, io, () => false)).toBe(false);
	expect(await quiesceCellularTun(plan, io, () => false)).toBe(false);
	expect(reads).toBe(0);
	index = 8;
	expect(await configureCellularTun(plan, io, () => true)).toBe(false);
	expect(await quiesceCellularTun(plan, io, () => true)).toBe(false);
	index = 7;
	expect(await verifyCellularTunConfiguration(plan, io, () => true)).toBe(
		false,
	);
	await expect(
		configureCellularTun({ ...plan, linkMtu: 1260 }, io, () => true),
	).rejects.toThrow("identity");
});
