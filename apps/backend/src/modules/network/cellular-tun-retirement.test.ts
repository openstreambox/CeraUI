import { expect, test } from "bun:test";
import {
	type CellularTunReferences,
	cellularTunUnreferenced,
} from "./cellular-tun-retirement.ts";

const tun = { name: "cclat1", index: 42, alias: "owned", persistent: true };
function baseline(): CellularTunReferences {
	return {
		addresses: [{ ifname: tun.name, ifindex: tun.index, addr_info: [] }],
		routes4: [{ dst: "default", dev: "lan0" }],
		routes6: [],
		rules4: [{ priority: 0, table: 255 }],
		rules6: [],
		nexthops: [],
		firewall: { nftables: [{ metainfo: { json_schema_version: 1 } }] },
	};
}
test("TUN deletion refuses residual addresses, indirect routes, selectors and numeric nft references", () => {
	expect(cellularTunUnreferenced(tun, baseline())).toBe(true);
	for (const patch of [
		{
			addresses: [
				{
					ifname: tun.name,
					ifindex: tun.index,
					addr_info: [{ local: "192.0.2.2" }],
				},
			],
		},
		{ addresses: [{ ifname: tun.name, ifindex: 43, addr_info: [] }] },
		{ routes4: [{ dst: "default", multipath: [{ dev: tun.name }] }] },
		{ rules4: [{ iif: tun.name }] },
		{ rules6: [{ oif: String(tun.index) }] },
		{ nexthops: [{ id: 1, dev: tun.name }] },
		{
			firewall: {
				nftables: [
					{
						rule: {
							expr: [
								{
									match: {
										left: { meta: { key: "oif" } },
										op: "==",
										right: tun.index,
									},
								},
							],
						},
					},
				],
			},
		},
		{
			firewall: {
				nftables: [
					{
						rule: {
							expr: [
								{
									match: {
										left: { meta: { key: "iifname" } },
										op: "==",
										right: tun.name,
									},
								},
							],
						},
					},
				],
			},
		},
		{
			firewall: {
				nftables: [
					{
						rule: {
							expr: [
								{
									match: {
										left: { meta: { key: "oif" } },
										op: "==",
										right: { set: [tun.index, 2] },
									},
								},
							],
						},
					},
				],
			},
		},
		{ routes6: null },
		{ rules4: {} },
		{ firewall: {} },
	])
		expect(cellularTunUnreferenced(tun, { ...baseline(), ...patch })).toBe(
			false,
		);
});

test("only the kernel's exact per-link IPv6 multicast route is implicit TUN state", () => {
	const row = {
		type: "5",
		dst: "ff00::/8",
		dev: tun.name,
		table: "255",
		protocol: "2",
		metric: 256,
		pref: "medium",
		flags: [] as string[],
	};
	for (const flags of [[], ["linkdown"]])
		expect(
			cellularTunUnreferenced(tun, {
				...baseline(),
				routes6: [{ ...row, flags }],
			}),
		).toBe(true);
	for (const patch of [
		{ protocol: "4" },
		{ dst: "2001:db8::/32" },
		{ metric: 100 },
		{ flags: ["onlink"] },
		{ gateway: "fe80::1" },
	])
		expect(
			cellularTunUnreferenced(tun, {
				...baseline(),
				routes6: [{ ...row, ...patch }],
			}),
		).toBe(false);
});
