/*
  A REALISTIC CELLULAR BOX FOR HOST TESTS.

  Ethernet plus three USB modems on their default automatic profiles, driven
  through the production interface scan (`processIfconfigOutput`), the
  production `ifname → ID_PATH` cache (`refreshModemIdPaths`), the production
  journal-block projection (`refreshMutationBlocks`) and the production bond list
  (`genSrtlaBondEntries`). Only I/O is replaced: the ifconfig text, the udev
  ID_PATH map and the journal's entry list.

  Every change to how a blocked or re-enumerated modem is treated must keep the
  invariants in `cellular-realistic-box.test.ts` green.
*/

import {
	deriveModemStableKey,
	MODEM_MUTATION_JOURNAL_VERSION,
	type ModemMutationEntry,
	type ModemMutationState,
} from "@ceraui/rpc/schemas";
import {
	refreshMutationBlocks,
	resetMutationBlockDeps,
} from "../../modules/modems/mutation-blocks.ts";
import {
	refreshModemIdPaths,
	setModemIdPathReader,
} from "../../modules/modems/modem-wire-producer.ts";
import { processIfconfigOutput } from "../../modules/network/network-interfaces.ts";
import { genSrtlaBondEntries } from "../../modules/streaming/srtla.ts";
import { setMutationBlocks } from "../../modules/streaming/lifecycle-admission.ts";

export interface BoxLink {
	readonly ifname: string;
	readonly ip: string;
	/** udev ID_PATH of the netdev; absent for a device udev gives none. */
	readonly idPath?: string;
}

export const ETHERNET: BoxLink = { ifname: "eth0", ip: "192.0.2.10" };
export const MODEMS: readonly BoxLink[] = [
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
];

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
	scan(links?: readonly BoxLink[]): Promise<void>;
	/** Replace the journal and re-derive the block set through production code. */
	journal(entries: readonly ModemMutationEntry[]): Promise<void>;
	/** The interfaces in the bond, sorted. */
	bonded(): string[];
	close(): void;
}

export async function realisticBox(): Promise<RealisticBox> {
	let entries: readonly ModemMutationEntry[] = [];
	let present: readonly BoxLink[] = [ETHERNET, ...MODEMS];
	const box: RealisticBox = {
		async scan(links = present) {
			present = links;
			setModemIdPathReader(
				async () =>
					new Map(
						links.flatMap((link) =>
							link.idPath === undefined ? [] : [[link.ifname, link.idPath]],
						),
					),
			);
			await refreshModemIdPaths();
			processIfconfigOutput(links.map(stanza).join("\n\n"));
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
