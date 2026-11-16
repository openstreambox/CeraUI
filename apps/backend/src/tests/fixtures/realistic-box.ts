/*
  A REALISTIC CELLULAR BOX FOR HOST TESTS.

  Ethernet plus three USB modems on their default automatic profiles, driven
  through the production interface scan (`processIfconfigOutput`), the
  production USB descriptor scan and roster ID-path refresh, the production
  journal-block projection (`refreshMutationBlocks`) and the production bond list
  (`genSrtlaBondEntries`). Only I/O is replaced: the ifconfig text, the
  sysfs/udev reads and the journal's entry list.

  Every change to how a blocked or re-enumerated modem is treated must keep the
  invariants in `cellular-realistic-box.test.ts` green.
*/

import { spyOn } from "bun:test";
import {
	deriveModemStableKey,
	MODEM_MUTATION_JOURNAL_VERSION,
	type ModemMutationEntry,
	type ModemMutationState,
} from "@ceraui/rpc/schemas";
import {
	refreshModemIdPaths,
	setModemIdPathReader,
} from "../../modules/modems/modem-wire-producer.ts";
import {
	refreshMutationBlocks,
	resetMutationBlockDeps,
} from "../../modules/modems/mutation-blocks.ts";
import {
	processIfconfigOutput,
	resetNetifSnapshotForTest,
} from "../../modules/network/network-interfaces.ts";
import {
	type RouterCellularScanDeps,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../../modules/network/router-cellular-scan.ts";
import { setMutationBlocks } from "../../modules/streaming/lifecycle-admission.ts";
import { genSrtlaBondEntries } from "../../modules/streaming/srtla.ts";
import * as wifiRadio from "../../modules/wifi/wifi-radio-identity.ts";

export interface BoxLink {
	readonly ifname: string;
	readonly ip: string;
	/** udev ID_PATH of the netdev; absent for a device udev gives none. */
	readonly idPath?: string;
	readonly kind?: "modem" | "ethernet" | "wifi" | "unknown";
}

export const ETHERNET: BoxLink = { ifname: "eth0", ip: "192.0.2.10" };
export const USB_ETHERNET: BoxLink = {
	ifname: "enx001122334455",
	ip: "203.0.113.10",
	kind: "ethernet",
};
export const USB_WIFI: BoxLink = {
	ifname: "wlx001122334466",
	ip: "203.0.113.20",
	kind: "wifi",
};
export const MODEMS = [
	{
		ifname: "wwan0",
		ip: "198.51.100.10",
		idPath: "platform-xhci-hcd.0.auto-usb-0:1.1:1.4",
	},
	{
		ifname: "wwan1",
		ip: "198.51.100.20",
		idPath: "platform-xhci-hcd.0.auto-usb-0:1.2:1.4",
	},
	{
		ifname: "wwan2",
		ip: "198.51.100.30",
		idPath: "platform-xhci-hcd.0.auto-usb-0:1.3:1.4",
	},
] as const satisfies readonly BoxLink[];

export function stableKeyOf(link: BoxLink): string {
	const key = deriveModemStableKey(link.idPath);
	if (key === undefined) throw new Error(`no stable key for ${link.ifname}`);
	return key;
}

function stanza(link: BoxLink, index: number): string {
	const mac = `02:00:00:00:00:${(16 + index).toString(16)}`;
	return [
		`${link.ifname}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
		`        inet ${link.ip}  netmask 255.255.255.0  broadcast ${link.ip.replace(/\.\d+$/, ".255")}`,
		`        ether ${mac}  txqueuelen 1000  (Ethernet)`,
		"        RX packets 200  bytes 20000 (20.0 KB)",
		"        TX packets 100  bytes 1000 (1.0 KB)",
	].join("\n");
}

export function journalEntry(
	link: BoxLink,
	state: ModemMutationState,
	kind: ModemMutationEntry["kind"] = "modem-config",
): ModemMutationEntry {
	return {
		version: MODEM_MUTATION_JOURNAL_VERSION,
		stableKey: stableKeyOf(link),
		kind,
		state,
		attemptId: `attempt-${link.ifname}`,
		startedAt: 1,
		updatedAt: 2,
		preState: {},
		history: [],
	};
}

export interface RealisticBox {
	/** Re-run the interface scan with the given links present. */
	scan(
		links?: readonly BoxLink[],
		options?: { failIdPaths?: boolean; skipPhysical?: boolean },
	): Promise<void>;
	/** Replace the journal and re-derive the block set through production code. */
	journal(entries: readonly ModemMutationEntry[]): Promise<void>;
	/** The interfaces in the bond, sorted. */
	bonded(): string[];
	close(): void;
}

export async function realisticBox(): Promise<RealisticBox> {
	let entries: readonly ModemMutationEntry[] = [];
	let present: readonly BoxLink[] = [ETHERNET, ...MODEMS];
	const epochs = new Map<string, number>();
	let scanned = new Set<string>();
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
	const wireless = spyOn(wifiRadio, "isWirelessInterface").mockImplementation(
		(name) =>
			present.some((link) => link.ifname === name && link.kind === "wifi"),
	);
	const box: RealisticBox = {
		async scan(links = present, options = {}) {
			present = links;
			setModemIdPathReader(async () => {
				if (options.failIdPaths) throw new Error("udev read failed");
				return new Map(
					links.flatMap((link) =>
						link.idPath === undefined ? [] : [[link.ifname, link.idPath]],
					),
				);
			});
			await refreshModemIdPaths();
			// Bus observation precedes the descriptor sweep, as at first sight in production.
			const output = links.map(stanza).join("\n\n");
			processIfconfigOutput(
				output,
				undefined,
				undefined,
				wifiRadio.isWirelessInterface,
				new Map(
					links.map((link) => [
						link.ifname,
						{
							result: {
								kind: "bus" as const,
								bus: link === ETHERNET ? "pci" : "usb",
							},
							seen: epochs.get(link.ifname) ?? 0,
						},
					]),
				),
			);
			const names = new Set(links.map((link) => link.ifname));
			for (const name of new Set([...scanned, ...names])) {
				if (scanned.has(name) !== names.has(name))
					epochs.set(name, (epochs.get(name) ?? 0) + 1);
			}
			scanned = names;
			if (!options.skipPhysical)
				await refreshUsbNetMarkers(
					links.map((link) => link.ifname),
					boxScanDeps(links),
				);
		},
		async journal(next) {
			entries = next;
			await refreshMutationBlocks({
				listEntries: async () => entries,
				presentStableKeys: async () =>
					new Set(
						present.flatMap((link) =>
							link.idPath === undefined ? [] : [stableKeyOf(link)],
						),
					),
			});
		},
		bonded() {
			return genSrtlaBondEntries()
				.map((entry) => entry.iface)
				.sort();
		},
		close() {
			wireless.mockRestore();
			resetUsbNetMarkers();
			setModemIdPathReader(null);
			resetMutationBlockDeps();
			setMutationBlocks([]);
			processIfconfigOutput("");
		},
	};
	await box.scan();
	await box.journal([]);
	return box;
}

/** Synthetic sysfs/udev reads; all classification and scan commitment stay real. */
function boxScanDeps(links: readonly BoxLink[]): RouterCellularScanDeps {
	const attrs = new Map<string, string>();
	const paths = new Map<string, string>();
	const dirs = new Map<string, string[]>();
	const drivers = new Map<string, string>();
	links.forEach((link, index) => {
		if (link === ETHERNET) return;
		const parent = `/sys/devices/usb1/1-${index + 1}`;
		const iface = `${parent}/1-${index + 1}:1.0`;
		const kind = link.kind ?? "modem";
		paths.set(`/sys/class/net/${link.ifname}/device`, iface);
		dirs.set(parent, [`1-${index + 1}:1.0`]);
		attrs.set(`${parent}/idVendor`, kind === "modem" ? "2c7c" : "0bda");
		attrs.set(`${parent}/idProduct`, "1234");
		attrs.set(`${parent}/bDeviceClass`, "00");
		attrs.set(`${parent}/busnum`, "1");
		attrs.set(`${parent}/devnum`, String(index + 2));
		attrs.set(`${parent}/devpath`, String(index + 1));
		// Unknown devices deliberately have neither a control port nor a path.
		attrs.set(
			`${iface}/bInterfaceClass`,
			kind === "modem" ? "02" : kind === "ethernet" ? "02" : "ff",
		);
		attrs.set(`${iface}/bInterfaceSubClass`, kind === "modem" ? "0e" : "06");
		attrs.set(`${iface}/bInterfaceProtocol`, "00");
		drivers.set(
			`${iface}/driver`,
			kind === "modem"
				? "cdc_mbim"
				: kind === "ethernet"
					? "cdc_ether"
					: "rtl8xxxu",
		);
		if (link.idPath)
			attrs.set(`/run/udev/data/c189:${index + 1}`, `E:ID_PATH=${link.idPath}`);
	});
	return {
		sysfsRoot: "/",
		udevDataRoot: "/run/udev/data",
		readAttr: async (path) => attrs.get(path),
		resolveLink: async (path) => paths.get(path),
		listDir: async (path) => dirs.get(path) ?? [],
		readLinkName: async (path) => drivers.get(path),
	};
}
