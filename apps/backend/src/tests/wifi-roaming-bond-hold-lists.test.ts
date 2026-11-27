import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { resetPhysicalIdentityRegistry } from "../modules/modems/physical-identity.ts";
import {
	getNetworkInterfaces,
	isBondCandidate,
	resetNetifSnapshotForTest,
	updateNetif,
} from "../modules/network/network-interfaces.ts";
import { resetUsbNetMarkers } from "../modules/network/router-cellular-scan.ts";
import {
	holdOutOfBond,
	releaseBondHold,
	resetBondHoldsForTest,
} from "../modules/network/wifi-roaming/bond-hold.ts";
import {
	genSrtlaBondEntries,
	genSrtlaBondEntriesForLocalIpAddress,
} from "../modules/streaming/srtla.ts";
import { stopWifiUpdateLoopForTest } from "../modules/wifi/wifi-interfaces.ts";
import {
	firstSightIfconfig,
	firstSightScan,
	FIRST_SIGHT_IP as IP,
	FIRST_SIGHT_IFACE as LINK,
} from "./helpers/bond-first-sight-fixture.ts";

/*
  The roaming search takes its radio out of the bond while it scans or joins
  another access point. Every sender list must leave it out: the bonded list,
  and the same-subnet list a LAN receiver gets, which has its own membership
  rule. The hold is by interface name, so any bondable link shows the rule.
*/

const OTHER = "wwu1u4c2";
const output = [
	firstSightIfconfig(LINK, IP),
	firstSightIfconfig(OTHER, "100.64.2.2"),
].join("\n\n");
// FIRST_SIGHT_IP is on 100.64.1.0/24: a receiver there is same-subnet.
const RECEIVER = "100.64.1.1";
let scan: ReturnType<typeof firstSightScan>;

const bonded = () => genSrtlaBondEntries().map((e) => e.iface);
const local = () =>
	genSrtlaBondEntriesForLocalIpAddress(RECEIVER).map((e) => e.iface);

beforeEach(async () => {
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
	resetPhysicalIdentityRegistry();
	resetBondHoldsForTest();
	jest.useFakeTimers();
	scan = firstSightScan(output, {
		blocked: [],
		buses: { [LINK]: "usb", [OTHER]: "usb" },
	});
	await scan.settle();
	await updateNetif();
});

afterEach(() => {
	scan.release();
	stopWifiUpdateLoopForTest();
	jest.restoreAllMocks();
	jest.useRealTimers();
	resetBondHoldsForTest();
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
	resetPhysicalIdentityRegistry();
});

test("a held link leaves the bonded and the same-subnet lists, and returns on release", () => {
	expect(bonded()).toContain(LINK);
	expect(local()).toEqual([LINK]);

	holdOutOfBond(LINK);
	expect(bonded()).not.toContain(LINK);
	expect(bonded()).toContain(OTHER);
	expect(local()).toEqual([]);

	releaseBondHold(LINK);
	expect(bonded()).toContain(LINK);
	expect(local()).toEqual([LINK]);
});

test("a hold on another link leaves the same-subnet list alone", () => {
	holdOutOfBond(OTHER);
	expect(local()).toEqual([LINK]);
	expect(bonded()).toEqual([LINK]);
});

test("the hold is part of bond admission itself", () => {
	const entry = getNetworkInterfaces()[LINK];
	expect(entry).toBeDefined();
	if (!entry) return;
	expect(isBondCandidate(LINK, entry)).toBe(true);
	holdOutOfBond(LINK);
	expect(isBondCandidate(LINK, entry)).toBe(false);
});
