/*
  A RECEIVER GIVEN AS A PRIVATE IPV4 LITERAL NARROWS THE BOND, NEVER WIDENS IT.

  A private or link-local receiver address is only reachable through a link on
  its subnet (or one routed there), so the launch bond prefers the bonded links
  on that subnet. It is still the user's bond: a link toggled out of the bond
  stays out even when it shares the receiver's subnet, and a receiver on a
  subnet no bonded link shares (a routed venue VLAN, a /32 route) gets the whole
  bond rather than zero links. Zero links is reported only when the bond itself
  is empty.

  Seen on a device: a same-subnet private literal put eth0 in the bond with
  its toggle off, and a routed private literal refused the start with
  `no_available_network_connections` while both Wi-Fi links could reach it.
*/

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLocalIp } from "../helpers/ip-addresses.ts";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import * as netif from "../modules/network/network-interfaces.ts";
import type { BondEntry } from "../modules/streaming/bind-map.ts";
import type { BindMapPublication } from "../modules/streaming/bind-map-writer.ts";
import {
	genSrtlaBondEntries,
	genSrtlaBondEntriesForLocalIpAddress,
	interfacesOnSubnet,
	resolveSrtla,
} from "../modules/streaming/srtla.ts";
import {
	maskMacDerivedIfname,
	prepareSrtlaIpAddresses,
	type SrtlaIpPreparationDeps,
} from "../modules/streaming/streamloop/srtla-ip-preparation.ts";
import { resetBondFixture } from "./helpers/bond-toggle-fixture.ts";

const PUBLISHED: BindMapPublication = {
	ok: true,
	generation: 1,
	changed: true,
	sidecarPath: "/tmp/ips.bindmap.json",
};

function add(
	name: string,
	ip: string,
	changes: Partial<netif.NetworkInterface> = {},
) {
	netif.getNetworkInterfaces()[name] = {
		ip,
		netmask: "255.255.255.0",
		enabled: true,
		error: 0,
		tp: 0,
		txb: 0,
		rxb: 0,
		...changes,
	};
}

/** The bench box: wired + two Wi-Fi radios on the home LAN, one modem. */
function seedBench() {
	add("eth0", "192.168.50.11");
	add("wlan0", "192.168.50.12");
	add("wlx0", "192.168.50.13");
	add("enx0", "10.64.0.10");
}

type Prepared = {
	readonly writes: number;
	readonly ifaces: readonly string[];
	readonly localReceiver: string | undefined;
	readonly warnings: readonly string[];
};

async function prepare(
	receiver: string,
	purpose: "launch" | "refresh" = "launch",
): Promise<Prepared> {
	let writes = 0;
	let published: readonly BondEntry[] = [];
	let localReceiver: string | undefined;
	const warnings: string[] = [];
	const deps: SrtlaIpPreparationDeps = {
		isLocal: isLocalIp,
		localList: genSrtlaBondEntriesForLocalIpAddress,
		bondedList: genSrtlaBondEntries,
		writeList: async (entries, receiverForRevalidation) => {
			writes += 1;
			published = entries;
			localReceiver = receiverForRevalidation;
			return PUBLISHED;
		},
		onSubnet: interfacesOnSubnet,
		warn: (message) => warnings.push(message),
	};
	await prepareSrtlaIpAddresses(receiver, deps, purpose);
	return {
		writes,
		ifaces: published.map((entry) => entry.iface),
		localReceiver,
		warnings,
	};
}

let dir: string | undefined;
let savedConfigPath = "";

beforeEach(() => {
	savedConfigPath = getConfigFilePath();
	dir = mkdtempSync(join(tmpdir(), "private-receiver-bond-"));
	setConfigFilePath(join(dir, "config.json"));
	resetBondFixture();
	getConfig().bond_opt_out = {};
});
afterEach(async () => {
	// Back to an IPv4 receiver for the next file in this process.
	await resolveSrtla("192.0.2.2");
	resetBondFixture();
	getConfig().bond_opt_out = {};
	setConfigFilePath(savedConfigPath);
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

describe("same-subnet private receiver", () => {
	test("a link toggled out of the bond stays out", async () => {
		seedBench();
		netif.setBondOptOut("eth0", true);
		netif.setBondOptOut("enx0", true);

		const result = await prepare("192.168.50.20");

		expect(result.ifaces).toEqual(["wlan0", "wlx0"]);
		expect(result.localReceiver).toBe("192.168.50.20");
		expect(genSrtlaBondEntriesForLocalIpAddress("192.168.50.20")).toEqual(
			genSrtlaBondEntries().filter((e) => e.iface !== "enx0"),
		);
	});

	test("bonded links off the receiver's subnet are left out", async () => {
		seedBench();

		const result = await prepare("192.168.50.20");

		expect(result.ifaces).toEqual(["eth0", "wlan0", "wlx0"]);
		expect(result.warnings).toEqual([]);
	});

	test("a disabled link stays out even without an explicit opt-out", async () => {
		seedBench();
		add("eth0", "192.168.50.11", { enabled: false });

		expect((await prepare("192.168.50.20")).ifaces).toEqual(["wlan0", "wlx0"]);
	});

	test("an excluded hotspot or shared-LAN port on the subnet stays out", async () => {
		add("wlan0", "10.42.0.1", { error: netif.NETIF_ERR_HOTSPOT });
		add("eth0", "10.42.1.1", { error: netif.NETIF_ERR_SHAREDLAN });
		add("wlx0", "192.168.50.13");

		expect(genSrtlaBondEntriesForLocalIpAddress("10.42.0.5")).toEqual([]);
		expect(genSrtlaBondEntriesForLocalIpAddress("10.42.1.5")).toEqual([]);
		const result = await prepare("10.42.0.5");
		expect(result.ifaces).toEqual(["wlx0"]);
	});
});

describe("receiver family", () => {
	test("an IPv4 LAN receiver after an IPv6-only one still gets IPv4 sources", async () => {
		add("wlan0", "192.168.50.12", { ipv6: "2001:db8:50::12" });
		add("enx0", "10.64.0.10", { ipv6: "2001:db8:64::10" });
		await resolveSrtla("2001:db8:2::10");
		expect(genSrtlaBondEntries().map((e) => e.ip)).toEqual([
			"2001:db8:50::12",
			"2001:db8:64::10",
		]);

		expect(
			genSrtlaBondEntriesForLocalIpAddress("192.168.50.20").map((e) => [
				e.iface,
				e.ip,
			]),
		).toEqual([["wlan0", "192.168.50.12"]]);
	});
});

describe("private receiver no bonded link shares a subnet with", () => {
	test("a routed private receiver gets the whole bond, not zero links", async () => {
		seedBench();
		netif.setBondOptOut("eth0", true);
		netif.setBondOptOut("enx0", true);

		const result = await prepare("10.20.30.1");

		expect(result.ifaces).toEqual(["wlan0", "wlx0"]);
		// Revalidation follows the bond rule, not the subnet rule.
		expect(result.localReceiver).toBeUndefined();
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("10.20.30.1");
	});

	test("the only same-subnet link toggled off: the bond stands and the log names the link", async () => {
		add("eth0", "192.168.50.11");
		add("enx0", "10.64.0.10");
		netif.setBondOptOut("eth0", true);

		const result = await prepare("192.168.50.20");

		expect(result.ifaces).toEqual(["enx0"]);
		expect(result.localReceiver).toBeUndefined();
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("eth0");
	});

	test("the warning masks the MAC an interface name carries", async () => {
		add("enx00e04c680a1b", "192.168.50.11");
		add("enx0", "10.64.0.10");
		netif.setBondOptOut("enx00e04c680a1b", true);

		const result = await prepare("192.168.50.20");

		expect(result.warnings[0]).toContain("enx00e04c******");
		expect(result.warnings[0]).not.toContain("680a1b");
		expect(maskMacDerivedIfname("wlx0200005e0001")).toBe("wlx020000******");
		expect(maskMacDerivedIfname("wlan0")).toBe("wlan0");
	});

	test("an empty bond is still refused at launch", async () => {
		seedBench();
		for (const name of ["eth0", "wlan0", "wlx0", "enx0"])
			netif.setBondOptOut(name, true);

		await expect(prepare("192.168.50.20")).rejects.toThrow(
			"no_available_network_connections",
		);
	});

	test("an empty bond on refresh publishes the withdrawal", async () => {
		seedBench();
		for (const name of ["eth0", "wlan0", "wlx0", "enx0"])
			netif.setBondOptOut(name, true);

		const result = await prepare("192.168.50.20", "refresh");
		expect(result.writes).toBe(1);
		expect(result.ifaces).toEqual([]);
	});
});

describe("public receiver", () => {
	test("a hostname that starts like a private range is not a LAN receiver", async () => {
		seedBench();

		const result = await prepare("10.relay.example");

		expect(result.ifaces).toEqual(["eth0", "wlan0", "wlx0", "enx0"]);
		expect(result.localReceiver).toBeUndefined();
		expect(result.warnings).toEqual([]);
	});

	test("is unchanged: the whole bond", async () => {
		seedBench();
		netif.setBondOptOut("eth0", true);

		const result = await prepare("198.51.100.7");

		expect(result.ifaces).toEqual(["wlan0", "wlx0", "enx0"]);
		expect(result.localReceiver).toBeUndefined();
		expect(result.warnings).toEqual([]);
	});
});
