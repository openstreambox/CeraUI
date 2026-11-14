import { expect, test } from "bun:test";
import {
	cellularTunAlias,
	createCellularTun,
	inspectCellularTun,
} from "./cellular-tun.ts";

const owner = "a".repeat(64),
	epoch = "one";
test("a TUN requires the full owner marker and kernel type; a renamed or reused slot is foreign", () => {
	const row = {
		ifname: "cclat1",
		ifindex: 17,
		ifalias: cellularTunAlias(owner, epoch),
		linkinfo: {
			info_kind: "tun",
			info_data: { type: "tun", pi: true, persist: true, multi_queue: false },
		},
	};
	expect(inspectCellularTun([row], 1, owner, epoch)).toMatchObject({
		index: 17,
		persistent: true,
	});
	expect(
		inspectCellularTun([{ ...row, ifname: "changed" }], 1, owner, epoch),
	).toBe("foreign");
	expect(
		inspectCellularTun(
			[{ ...row, ifalias: cellularTunAlias(owner, "two") }],
			1,
			owner,
			epoch,
		),
	).toBe("foreign");
	expect(
		inspectCellularTun(
			[{ ...row, linkinfo: { info_kind: "dummy" } }],
			1,
			owner,
			epoch,
		),
	).toBe("foreign");
	expect(inspectCellularTun([], 1, owner, epoch)).toBe("absent");
});
test("invalid and occupied births do not open the kernel TUN device", async () => {
	const io = {
		current: async () => true,
		links: async () => [{ ifname: "cclat1", ifindex: 99 }],
	};
	await expect(createCellularTun(33, owner, epoch, io)).rejects.toThrow("slot");
	await expect(createCellularTun(1, owner, epoch, io)).rejects.toThrow(
		"occupied",
	);
});

test("incomplete or ambiguous link inventories cannot authorize TUN birth or absence", () => {
	for (const inventory of [
		[null],
		[{}],
		[
			{ ifname: "other0", ifindex: 1 },
			{ ifname: "other0", ifindex: 2 },
		],
		[
			{ ifname: "other0", ifindex: 1 },
			{ ifname: "other1", ifindex: 1 },
		],
	])
		expect(() => inspectCellularTun(inventory, 1, owner, epoch)).toThrow(
			"inventory",
		);
	const row = {
		ifname: "cclat1",
		ifindex: 7,
		ifalias: cellularTunAlias(owner, epoch),
		linkinfo: {
			info_kind: "tun",
			info_data: { type: "tun", pi: true, persist: true, multi_queue: false },
		},
	};
	expect(
		inspectCellularTun(
			[row, { ...row, ifname: "other0", ifindex: 8 }],
			1,
			owner,
			epoch,
		),
	).toBe("foreign");
});
