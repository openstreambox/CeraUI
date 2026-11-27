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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ManagedProcess, WatcherHandle } from "../helpers/spawn-policy.ts";
import {
	getNetworkInterfaces,
	processIfconfigOutput,
	resetBondOptOut,
	resetNetifSnapshotForTest,
	setBondOptOut,
	setNetifDupIpSuppression,
	setQueueUpdateGwHook,
} from "../modules/network/network-interfaces.ts";
import { setNetifState } from "../modules/network/state/netif-state.ts";
import {
	isWifiCarrierLost,
	resetWifiCarrierLostForTest,
	setWifiCarrierLost,
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
	let refreshes = 0;
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
		needsReadmit: (ifname) => getNetworkInterfaces()[ifname] === undefined,
		refresh: () => {
			refreshes++;
		},
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
	/** What a live refresh would hand the sender for `receiver`. */
	const published = async (receiver = RECEIVER): Promise<string[]> => {
		let written: readonly BondEntry[] = [];
		await prepareSrtlaIpAddresses(
			receiver,
			{
				isLocal: (address) => address === LAN_RECEIVER,
				localList: genSrtlaBondEntriesForLocalIpAddress,
				bondedList: genSrtlaBondEntries,
				writeList: async (entries) => {
					written = entries;
					return { ok: true, changed: true } as unknown as BindMapPublication;
				},
			},
			"refresh",
		);
		return written.map((entry) => entry.iface).sort();
	};
	processIfconfigOutput(ALL.map(stanza).join("\n\n"));
	watch.start();
	for (const link of ALL) watch.handleLine(linkLine(link.name, true));
	return {
		watch,
		advance,
		setCarrier,
		published,
		refreshes: () => refreshes,
	};
}

beforeEach(() => {
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
	stopWifiUpdateLoopForTest();
	resetWifiCarrierLostForTest();
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
		expect(b.refreshes()).toBe(0);
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
		// Its row never left, so no netif refresh was needed.
		expect(b.refreshes()).toBe(0);
		b.watch.stop();
	});

	test("a LAN receiver's subnet subset keeps its only link", async () => {
		// The receiver shares wlan0's subnet; the modem and wlan1 do not.
		const b = bench();
		expect(await b.published(LAN_RECEIVER)).toEqual(["wlan0"]);
		b.setCarrier(RADIO_A.name, false);
		b.advance(CARRIER_LOSS_HOLD_MS);
		expect(isWifiCarrierLost(RADIO_A.name)).toBe(true);
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
		expect(isWifiCarrierLost(RADIO_B.name)).toBe(false);
		expect(await b.published()).toEqual(["wlan0", "wlan1", "wwan0"]);
		b.watch.stop();
	});

	test("a modem losing its carrier is never marked", async () => {
		const b = bench();
		b.setCarrier(MODEM.name, false);
		b.advance(10_000);
		expect(isWifiCarrierLost(MODEM.name)).toBe(false);
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
});
