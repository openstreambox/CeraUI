/**
 * A RADIO THAT LOSES ITS AP STOPS CARRYING ON THE CARRIER EDGE.
 *
 * NetworkManager keeps a Wi-Fi device `activated` while its supplicant looks
 * for the network again, so the only reader of the kernel's RUNNING flag used
 * to be the 5 s netif poll, and the sender kept feeding the deaf radio until
 * then. The carrier watch marks the link, and the bond publication leaves a
 * marked link out of the sender's list unless nothing else is left.
 *
 * The suite drives the REAL `processIfconfigOutput`, the REAL bond collectors
 * and the REAL `prepareSrtlaIpAddresses` behind the watcher (only the file
 * write is captured), because the guarantees live in the wiring: the list is
 * judged for the receiver it serves (a LAN receiver's subnet subset included),
 * the operator's toggle and every gate still decide membership, the netif rows
 * are never touched, and a modem is never marked.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { ManagedProcess, WatcherHandle } from "../helpers/spawn-policy.ts";
import { resetEventEmitterForTest } from "../modules/events/emit.ts";
import { netdevPresence } from "../modules/network/netdev-lifetime.ts";
import {
	getNetworkInterfaces,
	onNetworkInterfaceSourcesChange,
	processIfconfigOutput,
	resetBondOptOut,
	resetNetifSnapshotForTest,
	setBondOptOut,
	setNetifDupIpSuppression,
	setQueueUpdateGwHook,
} from "../modules/network/network-interfaces.ts";
import { setNetifState } from "../modules/network/state/netif-state.ts";
import {
	resetWifiCarrierLostForTest,
	setWifiCarrierDown,
	setWifiCarrierLost,
	wifiCarrierLostMark,
} from "../modules/network/wifi-carrier-lost.ts";
import {
	CARRIER_LOSS_HOLD_MS,
	READMIT_SETTLE_MS,
	WifiCarrierWatch,
} from "../modules/network/wifi-carrier-watch.ts";
import type { BondEntry } from "../modules/streaming/bind-map.ts";
import type { BindMapPublication } from "../modules/streaming/bind-map-writer.ts";
import {
	genSrtlaBondEntries,
	genSrtlaBondEntriesForLocalIpAddress,
} from "../modules/streaming/srtla.ts";
import { prepareSrtlaIpAddresses } from "../modules/streaming/streamloop/srtla-ip-preparation.ts";
import { stopWifiUpdateLoopForTest } from "../modules/wifi/wifi-interfaces.ts";

const RADIO_A = {
	name: "wlan0",
	ip: "192.168.178.31",
	mac: "aa:bb:cc:00:00:01",
};
const RADIO_B = {
	name: "wlan1",
	ip: "192.168.179.32",
	mac: "aa:bb:cc:00:00:02",
};
const MODEM = { name: "wwan0", ip: "10.64.12.7", mac: "aa:bb:cc:00:00:03" };
const ALL = [RADIO_A, RADIO_B, MODEM];
const RECEIVER = "receiver.example";
const LAN_RECEIVER = "192.168.178.40";

function stanza(link: { name: string; ip: string; mac: string }): string {
	return [
		`${link.name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
		`        inet ${link.ip}  netmask 255.255.255.0  broadcast ${link.ip.replace(/\.\d+$/, ".255")}`,
		`        ether ${link.mac}  txqueuelen 1000  (Ethernet)`,
		"        RX packets 200  bytes 20000 (20.0 KB)",
		"        TX packets 100  bytes 1000 (1.0 KB)",
	].join("\n");
}

const LINE_TAIL =
	"mtu 1500 qdisc noqueue state %S mode DORMANT group default \\    link/ether aa:bb:cc:00:00:01 brd ff:ff:ff:ff:ff:ff";

function linkLine(ifname: string, carrier: boolean): string {
	return carrier
		? `3: ${ifname}: <BROADCAST,MULTICAST,UP,LOWER_UP> ${LINE_TAIL.replace("%S", "UP")}`
		: `3: ${ifname}: <NO-CARRIER,BROADCAST,MULTICAST,UP> ${LINE_TAIL.replace("%S", "DORMANT")}`;
}

/**
 * A box whose kernel carrier the test sets, with fake timers. The netif rows
 * stay as the last poll left them (all RUNNING), which is the window this
 * change is about: the poll has not seen the carrier loss yet.
 */
function bench() {
	const carrier = new Map(ALL.map((link) => [link.name, true]));
	let clock = 0;
	const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
	const noChild = (): WatcherHandle => {
		const proc: ManagedProcess = {
			stdout: new ReadableStream<Uint8Array>(),
			stderr: null,
			exited: new Promise<number>(() => undefined),
			exitCode: null,
			signalCode: null,
			kill: () => undefined,
		};
		return { proc, abort: () => undefined };
	};
	const watch = new WifiCarrierWatch({
		spawn: noChild,
		isWifiStation: (ifname) => ifname.startsWith("wl"),
		isOperational: (ifname) => carrier.get(ifname) === true,
		setLost: setWifiCarrierLost,
		setDown: setWifiCarrierDown,
		now: () => clock,
		setTimeout: (fn, ms) => {
			timers.push({ at: clock + ms, fn, live: true });
			return timers.length - 1;
		},
		clearTimeout: (timer) => {
			const entry = timers[timer as number];
			if (entry) entry.live = false;
		},
	});
	const advance = (ms: number) => {
		const until = clock + ms;
		for (;;) {
			const due = timers
				.filter((t) => t.live && t.at <= until)
				.sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			due.live = false;
			clock = due.at;
			due.fn();
		}
		clock = until;
	};
	/** The kernel changes a link's carrier and the monitor prints the edge. */
	const setCarrier = (ifname: string, up: boolean) => {
		carrier.set(ifname, up);
		watch.handleLine(linkLine(ifname, up));
	};
	/** The links the sender's telemetry shows carrying (all, unless a test says). */
	const carrying = new Set(ALL.map((link) => link.name));
	/** What a live refresh would hand the sender for `receiver`. */
	const published = async (
		receiver = RECEIVER,
		purpose: "launch" | "refresh" = "refresh",
	): Promise<string[]> => {
		let written: readonly BondEntry[] = [];
		await prepareSrtlaIpAddresses(
			receiver,
			{
				isLocal: (address) => address === LAN_RECEIVER,
				localList: genSrtlaBondEntriesForLocalIpAddress,
				bondedList: genSrtlaBondEntries,
				carryingIfaces: () => carrying,
				writeList: async (entries) => {
					written = entries;
					return { ok: true, changed: true } as unknown as BindMapPublication;
				},
			},
			purpose,
		);
		return written.map((entry) => entry.iface).sort();
	};
	processIfconfigOutput(ALL.map(stanza).join("\n\n"));
	watch.start();
	for (const link of ALL) watch.handleLine(linkLine(link.name, true));
	return { watch, advance, setCarrier, published, carrying };
}

beforeEach(() => {
	// The fixture's interface events go nowhere: no store, no log, no timers left.
	resetEventEmitterForTest({
		appendEvent: () => undefined,
		log: () => undefined,
	});
	// Every fixture netdev answers with the ifindex its monitor lines carry.
	spyOn(netdevPresence, "ifindex").mockReturnValue(3);
	resetNetifSnapshotForTest();
	const netif = getNetworkInterfaces();
	for (const name of Object.keys(netif)) delete netif[name];
	setNetifState({});
	for (const link of ALL) setNetifDupIpSuppression(link.name, false);
	resetBondOptOut();
	resetWifiCarrierLostForTest();
	setQueueUpdateGwHook(null);
});

afterEach(() => {
	// Leave no fixture rows, Wi-Fi devices, snapshot or delayed discovery behind.
	processIfconfigOutput("");
	stopWifiUpdateLoopForTest();
	resetNetifSnapshotForTest();
	setNetifState({});
	resetBondOptOut();
	resetWifiCarrierLostForTest();
	(netdevPresence.ifindex as unknown as { mockRestore(): void }).mockRestore();
	resetEventEmitterForTest();
});

describe("Wi-Fi carrier loss and the published bond", () => {
	test("a radio whose carrier stays down stops carrying after the hold", async () => {
		const b = bench();
		expect(await b.published()).toEqual(["wlan0", "wlan1", "wwan0"]);
		b.setCarrier(RADIO_A.name, false);
		b.advance(CARRIER_LOSS_HOLD_MS - 1);
		expect(await b.published()).toEqual(["wlan0", "wlan1", "wwan0"]);
		b.advance(1);
		expect(await b.published()).toEqual(["wlan1", "wwan0"]);
		// The netif row, its toggle state and the modem are untouched.
		expect(getNetworkInterfaces()[RADIO_A.name]?.enabled).toBe(true);
		expect(getNetworkInterfaces()[MODEM.name]?.enabled).toBe(true);
		b.watch.stop();
	});

	test("the radio carries again once its carrier is back and settled", async () => {
		const b = bench();
		b.setCarrier(RADIO_A.name, false);
		b.advance(CARRIER_LOSS_HOLD_MS);
		expect(await b.published()).toEqual(["wlan1", "wwan0"]);
		b.advance(1_500);
		b.setCarrier(RADIO_A.name, true);
		b.advance(READMIT_SETTLE_MS - 1);
		expect(await b.published()).toEqual(["wlan1", "wwan0"]);
		b.advance(1);
		expect(await b.published()).toEqual(["wlan0", "wlan1", "wwan0"]);
		b.watch.stop();
	});

	test("a LAN receiver's subnet subset keeps its only link", async () => {
		// The receiver shares wlan0's subnet; the modem and wlan1 do not.
		const b = bench();
		expect(await b.published(LAN_RECEIVER)).toEqual(["wlan0"]);
		b.setCarrier(RADIO_A.name, false);
		b.advance(CARRIER_LOSS_HOLD_MS);
		expect(wifiCarrierLostMark(RADIO_A.name)).toBeDefined();
		// The modem elsewhere is no survivor for this receiver: nothing is emptied.
		expect(await b.published(LAN_RECEIVER)).toEqual(["wlan0"]);
		b.watch.stop();
	});

	test("both radios losing one AP stay in a bond with nothing else", async () => {
		setBondOptOut(MODEM.name, true);
		const b = bench();
		expect(await b.published()).toEqual(["wlan0", "wlan1"]);
		b.setCarrier(RADIO_A.name, false);
		b.setCarrier(RADIO_B.name, false);
		b.advance(CARRIER_LOSS_HOLD_MS);
		expect(await b.published()).toEqual(["wlan0", "wlan1"]);
		// wlan1 finds the other AP; wlan0 stays down and stops carrying then.
		b.setCarrier(RADIO_B.name, true);
		b.advance(READMIT_SETTLE_MS);
		expect(await b.published()).toEqual(["wlan1"]);
		b.watch.stop();
	});

	test("a radio toggled out is no survivor for a radio without carrier", async () => {
		setBondOptOut(MODEM.name, true);
		setBondOptOut(RADIO_B.name, true);
		const b = bench();
		expect(await b.published()).toEqual(["wlan0"]);
		b.setCarrier(RADIO_A.name, false);
		b.advance(CARRIER_LOSS_HOLD_MS);
		b.setCarrier(RADIO_B.name, false);
		b.advance(1_000);
		b.setCarrier(RADIO_B.name, true);
		b.advance(READMIT_SETTLE_MS);
		// wlan1 is back but out of the bond: wlan0 stays, the list never empties.
		expect(await b.published()).toEqual(["wlan0"]);
		b.watch.stop();
	});

	test("a roam-length gap leaves the bond as it was", async () => {
		const b = bench();
		b.setCarrier(RADIO_B.name, false);
		b.advance(CARRIER_LOSS_HOLD_MS - 100);
		b.setCarrier(RADIO_B.name, true);
		b.advance(10_000);
		expect(wifiCarrierLostMark(RADIO_B.name)).toBeUndefined();
		expect(await b.published()).toEqual(["wlan0", "wlan1", "wwan0"]);
		b.watch.stop();
	});

	test("a modem losing its carrier is never marked", async () => {
		const b = bench();
		b.setCarrier(MODEM.name, false);
		b.advance(10_000);
		expect(wifiCarrierLostMark(MODEM.name)).toBeUndefined();
		expect(await b.published()).toEqual(["wlan0", "wlan1", "wwan0"]);
		b.watch.stop();
	});

	test("stopping the watch clears its marks", async () => {
		const b = bench();
		b.setCarrier(RADIO_A.name, false);
		b.advance(CARRIER_LOSS_HOLD_MS);
		expect(await b.published()).toEqual(["wlan1", "wwan0"]);
		b.watch.stop();
		expect(await b.published()).toEqual(["wlan0", "wlan1", "wwan0"]);
	});

	test("a mark change drives the live refresh", async () => {
		const b = bench();
		let refreshes = 0;
		const unsubscribe = onNetworkInterfaceSourcesChange(() => {
			refreshes++;
		});
		try {
			b.setCarrier(RADIO_A.name, false);
			b.advance(CARRIER_LOSS_HOLD_MS);
			expect(refreshes).toBe(1);
			b.setCarrier(RADIO_A.name, true);
			b.advance(READMIT_SETTLE_MS);
			expect(refreshes).toBe(2);
		} finally {
			unsubscribe();
			b.watch.stop();
		}
	});

	test("a launch ignores marks, so nothing is stranded outside a sender", async () => {
		const b = bench();
		b.setCarrier(RADIO_A.name, false);
		b.advance(CARRIER_LOSS_HOLD_MS);
		expect(await b.published(RECEIVER, "launch")).toEqual([
			"wlan0",
			"wlan1",
			"wwan0",
		]);
		b.watch.stop();
	});

	test("a staggered loss of both radios does not cycle the first one", async () => {
		setBondOptOut(MODEM.name, true);
		const b = bench();
		b.setCarrier(RADIO_A.name, false);
		b.advance(CARRIER_LOSS_HOLD_MS - 300);
		b.setCarrier(RADIO_B.name, false);
		b.advance(300);
		// wlan0 is marked while wlan1 is still inside its hold: no survivor.
		expect(await b.published()).toEqual(["wlan0", "wlan1"]);
		b.advance(CARRIER_LOSS_HOLD_MS);
		expect(await b.published()).toEqual(["wlan0", "wlan1"]);
		b.watch.stop();
	});

	test("a mark on a netdev the name no longer holds is ignored", async () => {
		const b = bench();
		b.setCarrier(RADIO_A.name, false);
		b.advance(CARRIER_LOSS_HOLD_MS);
		expect(await b.published()).toEqual(["wlan1", "wwan0"]);
		// Another netdev took the name before its monitor line arrived.
		(
			netdevPresence.ifindex as unknown as { mockReturnValue(v: number): void }
		).mockReturnValue(12);
		expect(await b.published()).toEqual(["wlan0", "wlan1", "wwan0"]);
		b.watch.stop();
	});
});

describe("Wi-Fi carrier loss: survivors that come and go", () => {
	test("a survivor back inside its own hold lets the marked radio go", async () => {
		setBondOptOut(MODEM.name, true);
		const b = bench();
		let refreshes = 0;
		const unsubscribe = onNetworkInterfaceSourcesChange(() => {
			refreshes++;
		});
		try {
			b.setCarrier(RADIO_A.name, false);
			b.advance(CARRIER_LOSS_HOLD_MS - 300);
			// wlan1 starts a short roam just before wlan0 is marked.
			b.setCarrier(RADIO_B.name, false);
			b.advance(300);
			expect(await b.published()).toEqual(["wlan0", "wlan1"]);
			const before = refreshes;
			b.setCarrier(RADIO_B.name, true);
			// Its return republishes, and the marked radio is left out.
			expect(refreshes).toBe(before + 1);
			expect(await b.published()).toEqual(["wlan1"]);
		} finally {
			unsubscribe();
			b.watch.stop();
		}
	});

	test("another netdev under a down radio's name counts as a survivor", async () => {
		setBondOptOut(MODEM.name, true);
		const b = bench();
		b.setCarrier(RADIO_A.name, false);
		b.advance(CARRIER_LOSS_HOLD_MS - 300);
		b.setCarrier(RADIO_B.name, false);
		b.advance(300);
		expect(await b.published()).toEqual(["wlan0", "wlan1"]);
		// wlan1's name now belongs to another netdev, whose down line has not come.
		(
			netdevPresence.ifindex as unknown as {
				mockImplementation(fn: (name: string) => number): void;
			}
		).mockImplementation((name) => (name === RADIO_B.name ? 12 : 3));
		expect(await b.published()).toEqual(["wlan1"]);
		b.watch.stop();
	});
});

describe("the carrier rule at publication", () => {
	const entry = (iface: string, parentIface?: string, ip = "192.0.2.1") =>
		({
			iface,
			ip,
			...(parentIface ? { parentIface } : {}),
		}) as unknown as BondEntry;
	const publish = async (
		entries: BondEntry[],
		lost: readonly string[] | ((ifname: string) => boolean),
		down: readonly string[] = typeof lost === "function" ? [] : lost,
		carrying?: readonly string[],
	) => {
		let written: readonly BondEntry[] = [];
		await prepareSrtlaIpAddresses(
			RECEIVER,
			{
				isLocal: () => false,
				localList: () => [],
				bondedList: () => entries,
				writeList: async (list) => {
					written = list;
					return { ok: true, changed: true } as unknown as BindMapPublication;
				},
				carrierLost:
					typeof lost === "function" ? lost : (ifname) => lost.includes(ifname),
				carrierDown: (ifname) => down.includes(ifname),
				carryingIfaces: () => new Set(carrying ?? entries.map((e) => e.iface)),
			},
			"refresh",
		);
		return written.map((e) => e.iface);
	};

	test("a CLAT translator row alone is no survivor", async () => {
		expect(
			await publish([entry("wlan0"), entry("clat0", "wwan0")], ["wlan0"]),
		).toEqual(["wlan0", "clat0"]);
		expect(
			await publish(
				[entry("wlan0"), entry("clat0", "wwan0"), entry("eth0")],
				["wlan0"],
			),
		).toEqual(["clat0", "eth0"]);
	});

	test("a link whose carrier is down is no survivor before its mark", async () => {
		expect(
			await publish(
				[entry("wlan0"), entry("wlan1")],
				["wlan0"],
				["wlan0", "wlan1"],
			),
		).toEqual(["wlan0", "wlan1"]);
		expect(
			await publish([entry("wlan0"), entry("wlan1")], ["wlan0"], ["wlan0"]),
		).toEqual(["wlan1"]);
	});

	test("a survivor must reach the receiver's address family", async () => {
		// IPv6 Wi-Fi with an IPv4-only Ethernet beside it: Ethernet is no backup.
		expect(
			await publish(
				[entry("wlan0", undefined, "2001:db8::31"), entry("eth0")],
				["wlan0"],
			),
		).toEqual(["wlan0", "eth0"]);
		// Another IPv6 link that can carry lets the marked radio go.
		expect(
			await publish(
				[
					entry("wlan0", undefined, "2001:db8::31"),
					entry("wlan1", undefined, "2001:db8::32"),
					entry("eth0"),
				],
				["wlan0"],
			),
		).toEqual(["wlan1", "eth0"]);
	});

	test("a link the telemetry does not show carrying is no survivor", async () => {
		// Ethernet is up but cannot reach the receiver: nothing goes out on it.
		expect(
			await publish([entry("wlan0"), entry("eth0")], ["wlan0"], ["wlan0"], []),
		).toEqual(["wlan0", "eth0"]);
		expect(
			await publish(
				[entry("wlan0"), entry("eth0")],
				["wlan0"],
				["wlan0"],
				["eth0"],
			),
		).toEqual(["eth0"]);
	});

	test("each entry's state is read once per publication", async () => {
		const reads = new Map<string, number>();
		// A flipping reader would empty the list if it were asked twice.
		const flipping = (ifname: string) => {
			const n = (reads.get(ifname) ?? 0) + 1;
			reads.set(ifname, n);
			return ifname === "wlan0" || (ifname === "wlan1" && n > 1);
		};
		expect(await publish([entry("wlan0"), entry("wlan1")], flipping)).toEqual([
			"wlan1",
		]);
		expect([...reads.values()]).toEqual([1, 1]);
	});
});
