import { expect, test } from "bun:test";
import {
	type CellularAllocationInventory,
	inspectCellularClatAllocation,
} from "./cellular-clat-allocation.ts";
import { planCellularRoutes } from "./cellular-route-plan.ts";

const candidate = planCellularRoutes({
	owner: "a".repeat(64),
	epoch: "one",
	slot: 1,
	iface: "wwan0",
	mtu: 1428,
	ipv6: "2001:db8:1::2",
	ipv6PrefixLength: 64,
	ipv6Gateway: "fe80::1",
	nat64: "2001:db8:64::/96",
});
if (!candidate) throw new Error("Missing allocation fixture");
const plan = candidate;
function inventory(): CellularAllocationInventory {
	return {
		addresses: [
			{
				ifname: "wwan0",
				ifindex: 7,
				addr_info: [{ family: "inet6", local: "2001:db8:1::2", prefixlen: 64 }],
			},
			{
				ifname: "lan0",
				ifindex: 8,
				addr_info: [{ family: "inet", local: "192.0.2.2", prefixlen: 24 }],
			},
		],
		routes4: [
			{ dst: "default", dev: "lan0", gateway: "192.0.2.1" },
			{ dst: "192.0.2.0/24", dev: "lan0" },
		],
		routes6: [
			{ dst: "2001:db8:1::/64", dev: "wwan0", protocol: "2" },
			{ dst: "default", dev: "wwan0", gateway: "fe80::1" },
		],
		proxies6: [],
	};
}
test("the carrier /64 and unrelated LAN/default are clear; source/subnet/host-route/proxy collisions are occupied", () => {
	expect(inspectCellularClatAllocation(plan, "wwan0", inventory())).toBe(
		"clear",
	);
	for (const patch of [
		{ routes4: [{ dst: "198.18.0.0/15", dev: "lan0" }] },
		{ routes4: [{ dst: "default", dev: "other0", prefsrc: plan.source }] },
		{ routes6: [{ dst: `${plan.mapped}/128`, dev: "other0" }] },
		{ routes6: [{ dst: "2001:db8:1::/64", dev: "lan0", protocol: 2 }] },
		{ routes6: [{ dst: "default", gateway: plan.mapped }] },
		{ proxies6: [{ dst: plan.mapped, dev: "other0", proxy: null }] },
		{
			addresses: [
				{
					ifname: "lan0",
					ifindex: 8,
					addr_info: [{ family: "inet", local: "198.18.0.1", prefixlen: 15 }],
				},
			],
		},
		{
			addresses: [
				{
					ifname: "other0",
					ifindex: 8,
					addr_info: [
						{ family: "inet6", local: "2001:db8:1::99", prefixlen: 64 },
					],
				},
			],
		},
		{ addresses: [{ ifname: "cclat1", ifindex: 8, addr_info: [] }] },
	])
		expect(
			inspectCellularClatAllocation(plan, "wwan0", {
				...inventory(),
				...patch,
			}),
		).toBe("occupied");
});
test("malformed or incomplete inventory is unknown, never an absent allocation", () => {
	for (const patch of [
		{ addresses: {} },
		{ addresses: [] },
		{ addresses: [{ ifname: "wwan0", ifindex: 7, addr_info: [] }] },
		{ addresses: [{ ifname: "lan0", ifindex: 7 }] },
		{ routes4: [{ dst: "bad" }] },
		{ routes6: [{ dst: "fe80::1%other0/64" }] },
		{ proxies6: [{ dst: plan.mapped }] },
	])
		expect(
			inspectCellularClatAllocation(plan, "wwan0", {
				...inventory(),
				...patch,
			}),
		).toBe("unknown");
});
