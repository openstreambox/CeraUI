import { afterEach, expect, test } from "bun:test";
import { isLocalIp } from "../helpers/ip-addresses.ts";
import {
	setDnsCacheEntryForTest,
	setDnsResolverFactoryForTest,
} from "../modules/network/dns.ts";
import {
	parseIpAddrShow,
	processIfconfigOutput,
} from "../modules/network/network-interfaces.ts";
import type { BondEntry } from "../modules/streaming/bind-map.ts";
import type { ReceiverProbe } from "../modules/streaming/receiver-target.ts";
import {
	configuredReceiver,
	genSrtlaBondEntries,
	genSrtlaBondEntriesForLocalIpAddress,
	resolveSrtla,
	setReceiverProbeForTest,
} from "../modules/streaming/srtla.ts";
import { prepareSrtlaIpAddresses } from "../modules/streaming/streamloop/srtla-ip-preparation.ts";

/*
  The stream start asks every usable answer of the receiver name. A live
  first answer keeps the name (the sender dials it anyway and keeps its own
  DNS re-home); a dead first answer with a live later one hands the sender
  that live address. Synthetic addresses only.
*/

const PORT = 5000;
const originalRandom = Math.random;

afterEach(async () => {
	setDnsResolverFactoryForTest(null);
	setReceiverProbeForTest(null);
	Math.random = originalRandom;
	// Leave no inventory or receiver family behind for later files.
	processIfconfigOutput("", new Map());
	await resolveSrtla("192.0.2.2");
});

function twoLinks() {
	processIfconfigOutput(
		"wwan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n\n" +
			"wwan1: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n",
		parseIpAddrShow(
			"2: wwan0: <UP,LOWER_UP> mtu 1500\n    inet 198.51.100.1/24 scope global\n" +
				"3: wwan1: <UP,LOWER_UP> mtu 1500\n    inet 203.0.113.1/24 scope global\n",
		),
	);
}

function v6OnlyLink() {
	processIfconfigOutput(
		"wwan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n",
		parseIpAddrShow(
			"2: wwan0: <UP,LOWER_UP> mtu 1500\n    inet6 fd51::9/64 scope global\n",
		),
	);
}

function liveDns(a: string[], aaaa: string[] = []) {
	setDnsResolverFactoryForTest(() => ({
		cancel() {},
		resolve4(name, cb) {
			queueMicrotask(() =>
				name === "wellknown.belabox.net"
					? cb(null, ["127.1.33.7"])
					: a.length > 0
						? cb(null, [...a])
						: cb(Object.assign(new Error("ENODATA"), { code: "ENODATA" }), []),
			);
		},
		resolve6(_name, cb) {
			queueMicrotask(() =>
				aaaa.length > 0
					? cb(null, [...aaaa])
					: cb(Object.assign(new Error("ENODATA"), { code: "ENODATA" }), []),
			);
		},
	}));
}

function offlineDns() {
	setDnsResolverFactoryForTest(() => ({
		cancel() {},
		resolve4(_name, cb) {
			queueMicrotask(() => cb(new Error("offline"), []));
		},
		resolve6(_name, cb) {
			queueMicrotask(() => cb(new Error("offline"), []));
		},
	}));
}

/** Probe double: `live` addresses answer at once, the rest stay silent. */
function probeAnswering(...live: string[]) {
	const asked: string[] = [];
	const probe: ReceiverProbe = async ({ address, source, signal }) => {
		asked.push(`${address} via ${source}`);
		if (live.includes(address)) return true;
		await new Promise((resolve) => signal.addEventListener("abort", resolve));
		return false;
	};
	setReceiverProbeForTest(probe, 100);
	return asked;
}

test("a dead first answer starts the bond on the live one", async () => {
	twoLinks();
	const name = "dead-first.test.invalid";
	liveDns(["192.0.2.10", "192.0.2.20"]);
	const asked = probeAnswering("192.0.2.20");
	try {
		expect(await resolveSrtla(name, PORT)).toBe("192.0.2.20");
		// Every bond uplink asked both answers.
		expect(asked.sort()).toEqual([
			"192.0.2.10 via 198.51.100.1",
			"192.0.2.10 via 203.0.113.1",
			"192.0.2.20 via 198.51.100.1",
			"192.0.2.20 via 203.0.113.1",
		]);
		// The launch still knows which receiver was configured.
		expect(configuredReceiver("192.0.2.20")).toBe(name);
	} finally {
		setDnsCacheEntryForTest(name, null);
	}
});

test("a live first answer keeps the name, whatever the order is", async () => {
	twoLinks();
	const name = "both-live.test.invalid";
	try {
		probeAnswering("192.0.2.10", "192.0.2.20");
		liveDns(["192.0.2.10", "192.0.2.20"]);
		expect(await resolveSrtla(name, PORT)).toBe(name);
		liveDns(["192.0.2.20", "192.0.2.10"]);
		expect(await resolveSrtla(name, PORT)).toBe(name);
		// Only the second answer live, and listed first: still the name.
		probeAnswering("192.0.2.20");
		expect(await resolveSrtla(name, PORT)).toBe(name);
	} finally {
		setDnsCacheEntryForTest(name, null);
	}
});

test("a chosen private address is admitted as the bonded receiver it stands for", async () => {
	// Uplinks on 198.51.100.0/24 and 203.0.113.0/24 reach a private receiver
	// pool. The chosen literal is private, but it is not on a local subnet.
	twoLinks();
	const name = "private-pool.test.invalid";
	liveDns(["10.66.9.9", "10.66.9.10"]);
	probeAnswering("10.66.9.10");
	const written: (readonly BondEntry[])[] = [];
	const deps = {
		isLocal: isLocalIp,
		localList: genSrtlaBondEntriesForLocalIpAddress,
		bondedList: genSrtlaBondEntries,
		writeList: async (entries: readonly BondEntry[]) => {
			written.push(entries);
			return { ok: true, changed: false } as never;
		},
	};
	try {
		const address = await resolveSrtla(name, PORT);
		expect(address).toBe("10.66.9.10");
		await prepareSrtlaIpAddresses(address, deps);
		expect(written[0]?.map((e) => e.ip).sort()).toEqual([
			"198.51.100.1",
			"203.0.113.1",
		]);
		// The same literal configured directly is a local-subnet receiver again.
		expect(await resolveSrtla("10.66.9.10", PORT)).toBe("10.66.9.10");
		expect(configuredReceiver("10.66.9.10")).toBe("10.66.9.10");
		await expect(prepareSrtlaIpAddresses("10.66.9.10", deps)).rejects.toThrow(
			"no_available_network_connections",
		);
	} finally {
		setDnsCacheEntryForTest(name, null);
	}
});

test("dual-stack links choose among the A answers", async () => {
	processIfconfigOutput(
		"wwan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n",
		parseIpAddrShow(
			"2: wwan0: <UP,LOWER_UP> mtu 1500\n    inet 198.51.100.1/24 scope global\n    inet6 fd51::9/64 scope global\n",
		),
	);
	const name = "dual-stack.test.invalid";
	liveDns(["192.0.2.10", "192.0.2.20"], ["fd51::10"]);
	const asked = probeAnswering("192.0.2.20");
	try {
		expect(await resolveSrtla(name, PORT)).toBe("192.0.2.20");
		expect(asked.sort()).toEqual([
			"192.0.2.10 via 198.51.100.1",
			"192.0.2.20 via 198.51.100.1",
		]);
	} finally {
		setDnsCacheEntryForTest(name, null);
	}
});

test("nothing answering keeps handing the sender the name", async () => {
	twoLinks();
	const name = "silent.test.invalid";
	liveDns(["192.0.2.10", "192.0.2.20"]);
	probeAnswering();
	try {
		expect(await resolveSrtla(name, PORT)).toBe(name);
	} finally {
		setDnsCacheEntryForTest(name, null);
	}
});

test("one answer, or no port, is never probed", async () => {
	twoLinks();
	const asked = probeAnswering("192.0.2.10");
	try {
		liveDns(["192.0.2.10"]);
		expect(await resolveSrtla("single.test.invalid", PORT)).toBe(
			"single.test.invalid",
		);
		liveDns(["192.0.2.10", "192.0.2.20"]);
		expect(await resolveSrtla("no-port.test.invalid")).toBe(
			"no-port.test.invalid",
		);
		expect(asked).toEqual([]);
	} finally {
		setDnsCacheEntryForTest("single.test.invalid", null);
		setDnsCacheEntryForTest("no-port.test.invalid", null);
	}
});

test("an IP literal receiver is never probed", async () => {
	twoLinks();
	const asked = probeAnswering("192.0.2.10");
	expect(await resolveSrtla("192.0.2.10", PORT)).toBe("192.0.2.10");
	expect(asked).toEqual([]);
});

test("after a failed lookup the cached answer that answers wins over a random pick", async () => {
	twoLinks();
	const name = "cached-two.test.invalid";
	setDnsCacheEntryForTest(name, ["192.0.2.10", "192.0.2.20"]);
	offlineDns();
	probeAnswering("192.0.2.20");
	Math.random = () => 0; // the random pick would be the dead first answer
	try {
		expect(await resolveSrtla(name, PORT)).toBe("192.0.2.20");
	} finally {
		setDnsCacheEntryForTest(name, null);
	}
});

test("after a failed lookup with nothing answering the random pick stays", async () => {
	twoLinks();
	const name = "cached-silent.test.invalid";
	setDnsCacheEntryForTest(name, ["192.0.2.10", "192.0.2.20"]);
	offlineDns();
	probeAnswering();
	Math.random = () => 0.99;
	try {
		expect(await resolveSrtla(name, PORT)).toBe("192.0.2.20");
	} finally {
		setDnsCacheEntryForTest(name, null);
	}
});

test("an IPv6-only bond probes the AAAA answers over its IPv6 source", async () => {
	v6OnlyLink();
	const name = "v6-two.test.invalid";
	liveDns([], ["fd51::10", "fd51::20"]);
	const asked = probeAnswering("fd51::20");
	try {
		expect(await resolveSrtla(name, PORT)).toBe("fd51::20");
		expect(asked.sort()).toEqual([
			"fd51::10 via fd51::9",
			"fd51::20 via fd51::9",
		]);
	} finally {
		setDnsCacheEntryForTest(name, null);
	}
});
