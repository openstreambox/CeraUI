/**
 * Source selection for uplinks that have an IPv6 address, or only one.
 */
import { describe, expect, test } from "bun:test";
import {
	chooseUplinkSource,
	ipv6SourcesByInterface,
	type KernelAddress,
	selectIpv6Source,
} from "../modules/network/ipv6-source.ts";
import { parseNat64Prefix } from "../modules/network/nat64.ts";

function v6(over: Partial<KernelAddress>): KernelAddress {
	return { family: "inet6", scope: "global", prefixlen: 64, ...over };
}

describe("the IPv6 source of an interface", () => {
	test("a global address is selected", () => {
		expect(
			selectIpv6Source([
				v6({ local: "fe80::1", scope: "link" }),
				v6({ local: "2001:db8:1::10" }),
			]),
		).toBe("2001:db8:1::10");
	});

	test("an interface with only link-local or unique-local has none", () => {
		expect(
			selectIpv6Source([
				v6({ local: "fe80::1", scope: "link" }),
				v6({ local: "fd00:1::10" }),
			]),
		).toBeUndefined();
	});

	test("addresses the kernel will not source from are skipped", () => {
		expect(
			selectIpv6Source([
				v6({ local: "2001:db8:1::1", tentative: true }),
				v6({ local: "2001:db8:1::2", dadfailed: true }),
				v6({ local: "2001:db8:1::3", deprecated: true }),
				v6({ local: "2001:db8:1::4", preferred_life_time: 0 }),
			]),
		).toBeUndefined();
	});

	test("a stable address beats a temporary one", () => {
		expect(
			selectIpv6Source([
				v6({ local: "2001:db8:1::aaaa", temporary: true }),
				v6({ local: "2001:db8:1::ffff" }),
			]),
		).toBe("2001:db8:1::ffff");
	});

	test("a temporary address is still better than none", () => {
		expect(
			selectIpv6Source([v6({ local: "2001:db8:1::aaaa", temporary: true })]),
		).toBe("2001:db8:1::aaaa");
	});

	test("the choice does not depend on listing order", () => {
		const a = v6({ local: "2001:db8:1::a" });
		const b = v6({ local: "2001:db8:1::b" });
		expect(selectIpv6Source([a, b])).toBe(selectIpv6Source([b, a]));
	});

	test("IPv4 records are ignored", () => {
		expect(
			selectIpv6Source([
				{ family: "inet", local: "10.0.0.2", scope: "global" },
			]),
		).toBeUndefined();
	});

	test("sources are keyed by interface, omitting those without one", () => {
		expect(
			ipv6SourcesByInterface([
				{ ifname: "lo", addr_info: [v6({ local: "::1", scope: "host" })] },
				{ ifname: "wwan0", addr_info: [v6({ local: "2001:db8:2::5" })] },
				{ ifname: "eth0", addr_info: [] },
			]),
		).toEqual({ wwan0: "2001:db8:2::5" });
	});
});

describe("one source and destination per uplink", () => {
	const nat64 = parseNat64Prefix("64:ff9b::/96");
	const dualStackReceiver = { ipv4: "192.0.2.10", ipv6: "2001:db8:f::10" };

	test("an uplink with IPv4 behaves as it always did", () => {
		expect(
			chooseUplinkSource(
				{ ipv4: "10.0.0.2", ipv6: "2001:db8:1::2", nat64 },
				dualStackReceiver,
			),
		).toEqual({
			source: "10.0.0.2",
			destination: "192.0.2.10",
			family: "ipv4",
			path: "native",
		});
	});

	test("an IPv6-only uplink reaches a dual-stack receiver natively", () => {
		expect(
			chooseUplinkSource({ ipv6: "2001:db8:1::2", nat64 }, dualStackReceiver),
		).toEqual({
			source: "2001:db8:1::2",
			destination: "2001:db8:f::10",
			family: "ipv6",
			path: "native",
		});
	});

	test("an IPv6-only uplink reaches an IPv4-only receiver through its NAT64", () => {
		expect(
			chooseUplinkSource(
				{ ipv6: "2001:db8:1::2", nat64 },
				{ ipv4: "192.0.2.10" },
			),
		).toEqual({
			source: "2001:db8:1::2",
			destination: "64:ff9b::c000:20a",
			family: "ipv6",
			path: "nat64",
		});
	});

	test("without a NAT64 prefix of its own it is left out", () => {
		expect(
			chooseUplinkSource({ ipv6: "2001:db8:1::2" }, { ipv4: "192.0.2.10" }),
		).toBeUndefined();
	});

	test("a dual-stack uplink falls to IPv6 for an IPv6-only receiver", () => {
		expect(
			chooseUplinkSource(
				{ ipv4: "10.0.0.2", ipv6: "2001:db8:1::2" },
				{ ipv6: "2001:db8:f::10" },
			)?.family,
		).toBe("ipv6");
	});

	test("an IPv4-only uplink cannot reach an IPv6-only receiver", () => {
		expect(
			chooseUplinkSource({ ipv4: "10.0.0.2" }, { ipv6: "2001:db8:f::10" }),
		).toBeUndefined();
	});
});
