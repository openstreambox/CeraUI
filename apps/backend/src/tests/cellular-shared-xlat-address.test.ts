/*
  TWO MODEMS BEHIND THEIR OWN 464XLAT HOLD THE SAME IPv4 ADDRESS.

  A Quectel RM520 on an IPv6-only grant translates inside the module and hands
  the host `192.0.0.2/27` from the 464XLAT range (RFC 7335), on a raw-IP
  `qmi_wwan` netdev. Every such modem picks the same address, so two of them in
  one box are a duplicate-IP pair that no DHCP or MAC change can separate.

  The duplicate-IP policy split was written for, and only exercised with, two
  HiLink Ethernet tethers on `192.168.8.100`. This file pins the same contract
  for two modem netdevs on the production scan, USB descriptor and bind-map
  paths:

    * address-steered checks still refuse both, because a source address
      cannot tell them apart;
    * both are admitted to the bond, each under its own netdev and link id;
    * the published map names each netdev, so the sender pins each socket to its
      own device rather than to the shared address;
    * status shows two separate links, and the duplicate-IP band stays quiet
      while both are mapped;
    * unplugging either modem leaves the other bonded and clears its flag.
*/

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Telemetry } from "@ceraui/srtla-send/telemetry";
import { probeExclusionReason } from "../modules/network/connectivity-candidates.ts";
import {
	decideDupIpNotice,
	duplicateIpGroups,
	getNetworkInterfaces,
	isBondCandidate,
	NETIF_ERR_DUPIPV4,
	netIfBuildMsg,
	resetBondOptOut,
	setBondOptOut,
} from "../modules/network/network-interfaces.ts";
import { getUsbPhysicalDescriptor } from "../modules/network/router-cellular-scan.ts";
import { renderIpsFile } from "../modules/streaming/bind-map.ts";
import {
	defaultBindMapWriterDeps,
	defaultSidecarPath,
	publishBondMapping,
	resetBindMapWriter,
} from "../modules/streaming/bind-map-writer.ts";
import { resetBondIdentities } from "../modules/streaming/link-registry.ts";
import { registerSrtlaBond } from "../modules/streaming/link-telemetry.ts";
import { buildLinkRows } from "../modules/streaming/link-telemetry-rows.ts";
import {
	genSrtlaBondEntries,
	isBondLinkMappable,
} from "../modules/streaming/srtla.ts";
import {
	type BoxLink,
	ETHERNET,
	type RealisticBox,
	realisticBox,
} from "./fixtures/realistic-box.ts";

const XLAT_IP = "192.0.0.2";
const XLAT_MASK = "255.255.255.224";

function rm520(ifname: string, port: string): BoxLink {
	return {
		ifname,
		ip: XLAT_IP,
		netmask: XLAT_MASK,
		qmi: true,
		vid: "2c7c",
		pid: "0801",
		idPath: `platform-xhci-hcd.0.auto-usb-0:${port}:1.4`,
	};
}

const RM520_A = rm520("wwu1u3i4", "1.3");
const RM520_B = rm520("wwu1u4i4", "1.4");
const PAIR = [RM520_A.ifname, RM520_B.ifname];

let box: RealisticBox | undefined;

async function boxWithPair(): Promise<RealisticBox> {
	box = await realisticBox();
	await box.scan([ETHERNET, RM520_A, RM520_B]);
	return box;
}

function xlatEntries() {
	return genSrtlaBondEntries().filter((entry) => entry.ip === XLAT_IP);
}

afterEach(() => {
	box?.close();
	box = undefined;
	resetBindMapWriter();
	resetBondIdentities();
	resetBondOptOut();
});

describe("two RM520s on the module's own 464XLAT address", () => {
	test("both netdevs are read as /27 raw-IP links on the shared address", async () => {
		await boxWithPair();
		const netif = getNetworkInterfaces();
		for (const name of PAIR) {
			expect(netif[name]).toMatchObject({
				ip: XLAT_IP,
				netmask: XLAT_MASK,
				usb: true,
			});
			// A modem by its control interface (the fixture gives it QMI), not by bus alone.
			expect(getUsbPhysicalDescriptor(name)?.deviceClass).toBe("mm-managed");
		}
	});

	test("address-steered checks still refuse both", async () => {
		await boxWithPair();
		const netif = getNetworkInterfaces();
		for (const name of PAIR) {
			expect(netif[name]?.error).toBe(NETIF_ERR_DUPIPV4);
			expect(probeExclusionReason(netif[name])).toBe("duplicate IPv4 addr");
		}
		expect(duplicateIpGroups(netif)).toEqual([{ ip: XLAT_IP, ifaces: PAIR }]);
	});

	test("both are admitted to the bond under their own netdev and link id", async () => {
		const pair = await boxWithPair();
		expect(pair.bonded()).toEqual(["eth0", ...PAIR]);

		const netif = getNetworkInterfaces();
		for (const name of PAIR) {
			const int = netif[name];
			if (!int) throw new Error(`missing ${name}`);
			expect(isBondCandidate(name, int)).toBe(true);
			expect(isBondLinkMappable(name, XLAT_IP)).toBe(true);
		}

		const entries = xlatEntries();
		expect(entries.map((entry) => entry.iface).sort()).toEqual(PAIR);
		const linkIds = entries.map((entry) => entry.linkId);
		expect(linkIds.every((id) => typeof id === "string")).toBe(true);
		expect(new Set(linkIds).size).toBe(2);
		expect(renderIpsFile(entries)).toBe(`${XLAT_IP}\n${XLAT_IP}`);
	});

	test("the published map pins each line to its own netdev", async () => {
		await boxWithPair();
		const dir = mkdtempSync(join(tmpdir(), "xlat-bindmap-"));
		const ipsFile = join(dir, "srtla_ips");
		const deps = defaultBindMapWriterDeps(ipsFile, defaultSidecarPath(ipsFile));

		const entries = genSrtlaBondEntries();
		const published = await publishBondMapping(entries, deps);
		expect(published.ok).toBe(true);

		const lines = readFileSync(deps.ipsFile, "utf8").split("\n");
		expect(lines.filter((line) => line === XLAT_IP)).toHaveLength(2);

		// The sender reads the sidecar by position: row N describes line N. The
		// two same-address lines must each name a different device, which is what
		// the sender's SO_BINDTODEVICE pins the socket to.
		const sidecar = JSON.parse(readFileSync(deps.sidecarFile, "utf8")) as {
			links: { link_id: string; ip: string; iface: string }[];
		};
		expect(sidecar.links.map((row) => row.ip)).toEqual(lines);
		const xlatRows = sidecar.links.filter((row) => row.ip === XLAT_IP);
		expect(xlatRows.map((row) => row.iface).sort()).toEqual(PAIR);
		expect(new Set(xlatRows.map((row) => row.link_id)).size).toBe(2);
	});

	test("status shows two links and the duplicate band stays quiet while mapped", async () => {
		await boxWithPair();
		const msg = netIfBuildMsg();
		for (const name of PAIR) {
			expect(msg[name]).toMatchObject({ ip: XLAT_IP, enabled: true });
		}

		const groups = duplicateIpGroups(getNetworkInterfaces());
		expect(
			decideDupIpNotice(groups, {
				mappingState: () => "active",
				isLinkMappable: isBondLinkMappable,
			}),
		).toBeUndefined();
	});

	test("per-link telemetry keeps each modem on its own row", async () => {
		await boxWithPair();
		const entries = genSrtlaBondEntries();
		registerSrtlaBond(entries);
		const snapshot = {
			last_updated_ms: 1,
			connections: entries.map((entry, index) => ({
				conn_id: String(index),
				link_id: entry.linkId,
				rtt_ms: 40 + index,
				nak_count: index,
				weight_percent: 50,
				window: 1000,
				in_flight: 0,
				bitrate_bps: 0,
			})),
		} as unknown as Telemetry;

		const rows = buildLinkRows(snapshot, false, true).filter((row) =>
			PAIR.includes(row.iface),
		);
		expect(rows.map((row) => row.iface).sort()).toEqual(PAIR);
		for (const row of rows) {
			const entry = entries.find((e) => e.iface === row.iface);
			expect(row.link_id).toBe(entry?.linkId);
			expect(row.identity_state).toBeUndefined();
		}
	});

	for (const [gone, kept] of [
		[RM520_A, RM520_B],
		[RM520_B, RM520_A],
	] as const) {
		test(`unplugging ${gone.ifname} keeps ${kept.ifname} bonded`, async () => {
			const pair = await boxWithPair();
			const keptId = xlatEntries().find(
				(entry) => entry.iface === kept.ifname,
			)?.linkId;

			await pair.scan([ETHERNET, kept]);

			expect(pair.bonded()).toEqual(["eth0", kept.ifname]);
			const netif = getNetworkInterfaces();
			expect(netif[gone.ifname]).toBeUndefined();
			expect(netif[kept.ifname]).toMatchObject({ error: 0, enabled: true });
			expect(probeExclusionReason(netif[kept.ifname])).toBeUndefined();
			const entries = xlatEntries();
			expect(entries).toHaveLength(1);
			expect(entries[0]?.linkId).toBe(keptId);
			expect(duplicateIpGroups(netif)).toEqual([]);

			// Plugged back in, the pair is two bonded links again.
			await pair.scan([ETHERNET, RM520_A, RM520_B]);
			expect(pair.bonded()).toEqual(["eth0", ...PAIR]);
		});
	}

	test("a survivor the operator took out of the bond stays out", async () => {
		const pair = await boxWithPair();
		setBondOptOut(RM520_B.ifname, true);
		expect(pair.bonded()).toEqual(["eth0", RM520_A.ifname]);

		await pair.scan([ETHERNET, RM520_B]);

		expect(getNetworkInterfaces()[RM520_B.ifname]?.error).toBe(0);
		expect(pair.bonded()).toEqual(["eth0"]);
	});
});
