import { afterEach, beforeEach, expect, test } from "bun:test";
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
import {
	genSrtlaBondEntries,
	genSrtlaBondEntriesForLocalIpAddress,
	setBondIdentityResolverForTest,
} from "../modules/streaming/srtla.ts";

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
