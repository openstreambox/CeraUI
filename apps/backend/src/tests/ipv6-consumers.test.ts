import { afterEach, expect, test } from "bun:test";
import {
	dnsCacheResolve,
	setDnsCacheEntryForTest,
	setDnsResolverFactoryForTest,
} from "../modules/network/dns.ts";
import {
	getNetworkInterfaces,
	netIfBuildMsg,
	parseIpAddrShow,
	processIfconfigOutput,
} from "../modules/network/network-interfaces.ts";
import { genSrtlaIpList, resolveSrtla } from "../modules/streaming/srtla.ts";

afterEach(() => setDnsResolverFactoryForTest(null));
const inventory = `2: wwan0: <UP,LOWER_UP> mtu 1500
    inet6 fe80::1/64 scope link
    inet6 fd51::9/64 scope global tentative
    inet6 fd51::8/64 scope global deprecated
    inet6 fd51::7/64 scope global temporary
    inet6 fd51::1/64 scope global
`;
test("IPv6 inventory selects a stable usable source and publishes a v6-only bond", () => {
	const selected = parseIpAddrShow(inventory);
	expect(selected.get("wwan0")?.ipv6).toBe("fd51::1");
	processIfconfigOutput(
		"wwan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n        TX packets 1  bytes 100\n",
		selected,
	);
	expect(getNetworkInterfaces().wwan0?.ip).toBeUndefined();
	expect(genSrtlaIpList()).toContain("fd51::1");
});
test("withdraws IPv6 sources when all addresses become unusable", () => {
	processIfconfigOutput(
		"wwan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n",
		parseIpAddrShow(
			inventory
				.replace("scope global\n", "scope global dadfailed\n")
				.replace("scope global temporary", "scope global tentative"),
		),
	);
	expect(genSrtlaIpList()).not.toContain("fd51::1");
});
test("IPv6 literals bypass DNS", async () => {
	setDnsResolverFactoryForTest(() => {
		throw new Error("unexpected DNS");
	});
	expect((await dnsCacheResolve("fd51::2")).addrs).toEqual(["fd51::2"]);
});
test("receiver queries both families and accepts an AAAA-only answer", async () => {
	const queries: string[] = [];
	setDnsResolverFactoryForTest(() => ({
		cancel() {},
		resolve4(name, cb) {
			queries.push(`A ${name}`);
			queueMicrotask(() =>
				cb(null, name === "wellknown.belabox.net" ? ["127.1.33.7"] : []),
			);
		},
		resolve6(name, cb) {
			queries.push(`AAAA ${name}`);
			queueMicrotask(() => cb(null, ["fd51::2"]));
		},
	}));
	await expect(resolveSrtla("receiver.test.invalid")).resolves.toBe(
		"receiver.test.invalid",
	);
	expect(queries).toContain("AAAA receiver.test.invalid");
});

test("dual stack keeps IPv4 compatibility and exposes IPv6 in the wire snapshot", async () => {
	await resolveSrtla("192.0.2.2");
	const selected = parseIpAddrShow(
		inventory + "    inet 192.0.2.1/24 scope global\n",
	);
	processIfconfigOutput(
		"wwan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n",
		selected,
	);
	expect(genSrtlaIpList()).toEqual(["192.0.2.1"]);
	expect(netIfBuildMsg().wwan0?.ipv6).toBe("fd51::1");
	expect(netIfBuildMsg().wwan0?.addresses).toEqual(["192.0.2.1", "fd51::1"]);
	expect(
		eligibleProbeCandidates(getNetworkInterfaces()).some(
			(row) => row.name === "wwan0",
		),
	).toBe(true);
});

test("IPv6-only inventory changes reconcile even when IPv4 and counters are unchanged", () => {
	const base = { up: true, tp: 0, txb: 0, error: 0 };
	expect(
		reconcileNetif(
			{ wwan0: { ...base, ipv6: "fd51::2" } },
			{ wwan0: { ...base, ipv6: "fd51::1" } },
		).changed,
	).toHaveLength(1);
});

import { eligibleProbeCandidates } from "../modules/network/connectivity-candidates.ts";
import { reconcileNetif } from "../modules/network/state/netif-state.ts";

test("an AAAA-only receiver selects the native source on a dual-stack link", async () => {
	processIfconfigOutput(
		"wwan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n",
		parseIpAddrShow(inventory + "    inet 192.0.2.1/24 scope global\n"),
	);
	await resolveSrtla("fd51::2");
	expect(genSrtlaIpList()).toEqual(["fd51::1"]);
});

test("expired IPv6 preferred lifetime is not published", () => {
	expect(
		parseIpAddrShow(
			"2: wwan0: <UP>\n    inet6 fd51::1/64 scope global\n       valid_lft 30sec preferred_lft 0sec\n",
		).get("wwan0")?.ipv6,
	).toBeUndefined();
});

test("cached receiver fallback matches an IPv6-only source instead of a cached A record", async () => {
	processIfconfigOutput(
		"wwan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n",
		parseIpAddrShow(inventory),
	);
	getNetworkInterfaces().wlan0 = {
		ip: "10.42.0.1",
		enabled: false,
		error: 2,
		tp: 0,
		txb: 0,
		rxb: 0,
	};
	setDnsCacheEntryForTest("cached-receiver.test.invalid", [
		"192.0.2.2",
		"fd51::2",
	]);
	setDnsResolverFactoryForTest(() => ({
		cancel() {},
		resolve4(_name, cb) {
			queueMicrotask(() => cb(new Error("offline"), []));
		},
		resolve6(_name, cb) {
			queueMicrotask(() => cb(new Error("offline"), []));
		},
	}));
	try {
		await expect(resolveSrtla("cached-receiver.test.invalid")).resolves.toBe(
			"fd51::2",
		);
	} finally {
		setDnsCacheEntryForTest("cached-receiver.test.invalid", null);
	}
});

import { createConnectivityTargetResolver } from "../modules/network/uplink-health/connectivity-target.ts";

test("health probes resolve a target matching each source family", async () => {
	const resolve = createConnectivityTargetResolver({
		now: () => 0,
		resolve: async () => ({
			addrs: ["192.0.2.2", "fd51::2"],
			fromCache: false,
		}),
	});
	expect(await resolve(6)).toBe("fd51::2");
	expect(await resolve(4)).toBe("192.0.2.2");
});
