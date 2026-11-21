import { afterEach, expect, test } from "bun:test";

import {
	setDnsCacheEntryForTest,
	setDnsResolverFactoryForTest,
} from "../modules/network/dns.ts";
import {
	parseIpAddrShow,
	processIfconfigOutput,
} from "../modules/network/network-interfaces.ts";
import type { ReceiverProbe } from "../modules/streaming/receiver-target.ts";
import {
	resolveSrtla,
	setReceiverProbeForTest,
} from "../modules/streaming/srtla.ts";

/*
  The stream start hands the sender one receiver address for the whole bond
  when the name has several usable answers: the first in DNS order that a
  bonding receiver answers on. Synthetic addresses only.
*/

const PORT = 5000;
const originalRandom = Math.random;

afterEach(() => {
	setDnsResolverFactoryForTest(null);
	setReceiverProbeForTest(null);
	Math.random = originalRandom;
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

for (const name of ["dead-first.test.invalid", "rotated.test.invalid"]) {
	test(`a dead first answer starts the bond on the live one (${name})`, async () => {
		twoLinks();
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
		} finally {
			setDnsCacheEntryForTest(name, null);
		}
	});
}

test("both answering: the first in DNS order, whatever the order is", async () => {
	twoLinks();
	const name = "both-live.test.invalid";
	try {
		probeAnswering("192.0.2.10", "192.0.2.20");
		liveDns(["192.0.2.10", "192.0.2.20"]);
		expect(await resolveSrtla(name, PORT)).toBe("192.0.2.10");
		liveDns(["192.0.2.20", "192.0.2.10"]);
		expect(await resolveSrtla(name, PORT)).toBe("192.0.2.20");
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
