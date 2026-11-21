import { expect, test } from "bun:test";
import { changeLinkByIndex } from "../../helpers/netlink-link.ts";
import { changeCellularIndexedIp } from "./cellular-indexed-ip.ts";

test("indexed writes reject scoped, non-unicast and non-host selectors before dispatch", async () => {
	for (const address of [
		"::",
		"ff02::1",
		"fe80::1%wwan0",
		"2001:db8::1/128",
		"bad",
	])
		await expect(
			changeCellularIndexedIp(7, { kind: "proxy", family: 6, address }, "add"),
		).rejects.toThrow("address");
	for (const address of ["0.0.0.0", "127.0.0.1", "224.0.0.1", "1.2.3.999"])
		await expect(
			changeCellularIndexedIp(
				7,
				{ kind: "address", family: 4, address, prefix: 32 },
				"add",
			),
		).rejects.toThrow("address");
	await expect(
		changeCellularIndexedIp(
			7,
			{ kind: "address", family: 6, address: "2001:db8::1", prefix: 64 },
			"add",
		),
	).rejects.toThrow("host prefix");
	await expect(
		changeCellularIndexedIp(
			0,
			{ kind: "proxy", family: 6, address: "2001:db8::1" },
			"del",
		),
	).rejects.toThrow("index");
});
test("a retired dispatch permit submits no address, proxy or link request", async () => {
	for (const effect of [
		{ kind: "address", family: 4, address: "198.18.255.1", prefix: 32 },
		{ kind: "proxy", family: 6, address: "2001:db8::1" },
	] as const)
		expect(await changeCellularIndexedIp(7, effect, "add", () => false)).toBe(
			false,
		);
	expect(
		await changeLinkByIndex(7, { kind: "mtu", mtu: 1408 }, () => false),
	).toBe(false);
});
