import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintLinkId } from "../modules/modems/physical-identity.ts";
import {
	claimCellularSource,
	resetCellularSourcesForTest,
	setCellularSourceBinding,
	setCellularSourceReady,
	withdrawCellularSource,
} from "../modules/network/cellular-source-state.ts";
import {
	getNetworkInterfaces,
	processIfconfigOutput,
	resetBondOptOut,
} from "../modules/network/network-interfaces.ts";
import { setup } from "../modules/setup.ts";
import {
	drainSrtlaBondPublication,
	genSrtlaBondEntries,
	genSrtlaBondEntriesForLocalIpAddress,
	getLastPublishedBond,
	publishSrtlaBond,
	restrictSrtlaBond,
	setBondIdentityResolverForTest,
} from "../modules/streaming/srtla.ts";
import { prepareSrtlaIpAddresses } from "../modules/streaming/streamloop/srtla-ip-preparation.ts";

const owner = "1".repeat(64),
	epoch = "usb-one",
	iface = "wwan0";
const source = "198.18.255.1",
	parentId = mintLinkId("synthetic:physical-modem");
function stanza(name: string, ip?: string) {
	return `${name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n${ip ? `        inet ${ip}  netmask 255.255.255.0\n` : ""}        RX packets 1  bytes 100\n        TX packets 1  bytes 100`;
}
beforeEach(() => {
	resetBondOptOut();
	processIfconfigOutput("");
	resetCellularSourcesForTest();
	setBondIdentityResolverForTest((name) => ({
		identityKey: `synthetic:${name}`,
		anchor: "id-path",
		linkId: name === iface ? parentId : mintLinkId(`synthetic:${name}`),
		ifname: name,
		idPath: `/synthetic/${name}`,
		displayName: "Synthetic modem",
	}));
});
afterEach(() => {
	resetCellularSourcesForTest();
	processIfconfigOutput("");
	setBondIdentityResolverForTest(null);
});
test("translation publishes on the physical parent, binds its TUN, and withdraws before kernel teardown", () => {
	const output = [
		stanza("eth0", "192.0.2.10"),
		stanza(iface),
		stanza("cclat1", source),
	].join("\n\n");
	claimCellularSource(owner, epoch, iface);
	setCellularSourceBinding(owner, epoch, iface, {
		source,
		device: "cclat1",
		translated: true,
		generation: "grant-one",
	});
	processIfconfigOutput(output);
	expect(getNetworkInterfaces().cclat1).toBeUndefined();
	expect(genSrtlaBondEntries().map((row) => row.iface)).toEqual(["eth0"]);
	setCellularSourceReady(owner, epoch, iface, "grant-one", true);
	processIfconfigOutput(output);
	expect(getNetworkInterfaces()[iface]?.ip).toBe(source);
	expect(
		genSrtlaBondEntries().find((row) => row.linkId === parentId),
	).toMatchObject({
		ip: source,
		iface: "cclat1",
		linkId: parentId,
		idPath: `/synthetic/${iface}`,
	});
	withdrawCellularSource(owner, epoch, iface);
	// The old address and translator still exist in the OS snapshot here.
	expect(genSrtlaBondEntries().map((row) => row.iface)).toEqual(["eth0"]);
});
test("a native grant uses the same readiness gate for ordinary and local-receiver collection", () => {
	const native = "198.51.100.2";
	claimCellularSource(owner, epoch, iface);
	setCellularSourceBinding(owner, epoch, iface, {
		source: native,
		device: iface,
		translated: false,
		generation: "native-one",
	});
	processIfconfigOutput(stanza(iface, native));
	expect(genSrtlaBondEntries()).toEqual([]);
	expect(genSrtlaBondEntriesForLocalIpAddress("198.51.100.5")).toEqual([]);
	setCellularSourceReady(owner, epoch, iface, "native-one", true);
	expect(genSrtlaBondEntries()).toHaveLength(1);
	expect(genSrtlaBondEntriesForLocalIpAddress("198.51.100.5")).toHaveLength(1);
	withdrawCellularSource(owner, epoch, iface);
	expect(genSrtlaBondEntriesForLocalIpAddress("198.51.100.5")).toEqual([]);
});

test("the real publisher rejects old captured translated rows after withdrawal and an identical-address successor", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cellular-bond-publication-")),
		oldIps = setup.ips_file,
		oldMap = setup.bind_map_file;
	setup.ips_file = join(dir, "ips");
	setup.bind_map_file = join(dir, "map");
	try {
		claimCellularSource(owner, epoch, iface);
		setCellularSourceBinding(owner, epoch, iface, {
			source,
			device: "cclat1",
			translated: true,
			generation: "first",
		});
		setCellularSourceReady(owner, epoch, iface, "first", true);
		processIfconfigOutput(
			[stanza(iface), stanza("cclat1", source)].join("\n\n"),
		);
		const captured = genSrtlaBondEntries();
		expect(captured).toHaveLength(1);
		expect((await publishSrtlaBond(captured)).ok).toBe(true);
		expect(await Bun.file(setup.ips_file).text()).toBe(source);
		withdrawCellularSource(owner, epoch, iface);
		expect(getLastPublishedBond()).toBeUndefined();
		await Promise.all([publishSrtlaBond([]), publishSrtlaBond(captured)]);
		expect(await Bun.file(setup.ips_file).text()).toBe("");
		setCellularSourceBinding(owner, epoch, iface, {
			source,
			device: "cclat1",
			translated: true,
			generation: "successor",
		});
		setCellularSourceReady(owner, epoch, iface, "successor", true);
		await publishSrtlaBond(captured);
		expect(await Bun.file(setup.ips_file).text()).toBe("");
		expect((await Bun.file(setup.bind_map_file).json()).links).toEqual([]);
		await publishSrtlaBond(genSrtlaBondEntries());
		expect(await Bun.file(setup.ips_file).text()).toBe(source);
	} finally {
		await drainSrtlaBondPublication();
		setup.ips_file = oldIps;
		setup.bind_map_file = oldMap;
		await rm(dir, { recursive: true, force: true });
	}
});

test("launch refuses when withdrawal empties the actual queued publication after a nonempty collection", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cellular-bond-launch-")),
		oldIps = setup.ips_file,
		oldMap = setup.bind_map_file;
	setup.ips_file = join(dir, "ips");
	setup.bind_map_file = join(dir, "map");
	try {
		claimCellularSource(owner, epoch, iface);
		setCellularSourceBinding(owner, epoch, iface, {
			source,
			device: "cclat1",
			translated: true,
			generation: "first",
		});
		setCellularSourceReady(owner, epoch, iface, "first", true);
		processIfconfigOutput(
			[stanza(iface), stanza("cclat1", source)].join("\n\n"),
		);
		const preparing = prepareSrtlaIpAddresses("relay.example");
		withdrawCellularSource(owner, epoch, iface);
		await expect(preparing).rejects.toThrow("no_available_network_connections");
		expect(await Bun.file(setup.ips_file).text()).toBe("");
		expect((await Bun.file(setup.bind_map_file).json()).links).toEqual([]);
	} finally {
		await drainSrtlaBondPublication();
		setup.ips_file = oldIps;
		setup.bind_map_file = oldMap;
		await rm(dir, { recursive: true, force: true });
	}
});

test("restricting one withdrawn source preserves another managed row's original observation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cellular-bond-survivor-")),
		oldIps = setup.ips_file,
		oldMap = setup.bind_map_file;
	setup.ips_file = join(dir, "ips");
	setup.bind_map_file = join(dir, "map");
	try {
		for (const [name, device, ip] of [
			[iface, "cclat1", source],
			["wwan1", "cclat2", "198.18.255.2"],
		]) {
			if (!name || !device || !ip) throw new Error("Incomplete source fixture");
			claimCellularSource(owner, epoch, name);
			setCellularSourceBinding(owner, epoch, name, {
				source: ip,
				device,
				translated: true,
				generation: "current",
			});
			setCellularSourceReady(owner, epoch, name, "current", true);
		}
		processIfconfigOutput(
			[
				stanza(iface),
				stanza("wwan1"),
				stanza("cclat1", source),
				stanza("cclat2", "198.18.255.2"),
			].join("\n\n"),
		);
		expect((await publishSrtlaBond(genSrtlaBondEntries())).ok).toBe(true);
		withdrawCellularSource(owner, epoch, iface);
		expect(
			(await restrictSrtlaBond(parentId, [iface, "cclat1"], () => true)).ok,
		).toBe(true);
		expect(await Bun.file(setup.ips_file).text()).toBe("198.18.255.2");
		expect((await Bun.file(setup.bind_map_file).json()).links).toMatchObject([
			{ iface: "cclat2" },
		]);
	} finally {
		await drainSrtlaBondPublication();
		setup.ips_file = oldIps;
		setup.bind_map_file = oldMap;
		await rm(dir, { recursive: true, force: true });
	}
});
