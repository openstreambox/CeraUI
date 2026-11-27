/**
 * A RADIO THAT LOSES ITS AP LEAVES THE BOND ON THE CARRIER EDGE.
 *
 * NetworkManager keeps a Wi-Fi device `activated` while its supplicant looks
 * for the network again, so the only reader of the kernel's RUNNING flag used
 * to be the 5 s netif poll, and the link stayed in the bond for up to 5 s with
 * its radio deaf. The carrier watch runs the poll's own refresh on the edge.
 *
 * The suite drives the REAL `processIfconfigOutput` and the REAL
 * `genSrtlaIpList` behind the watcher, because the guarantees live in the
 * wiring: the withdrawal is the refresh's (so the operator's bond toggle and
 * every gate still decide readmission), a cellular link riding the same
 * refreshes is never touched, and nothing moves before the hold has passed.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { ManagedProcess, WatcherHandle } from "../helpers/spawn-policy.ts";
import { netdevPresence } from "../modules/network/netdev-lifetime.ts";
import {
	getNetworkInterfaces,
	isBondCandidate,
	processIfconfigOutput,
	resetBondOptOut,
	resetNetifSnapshotForTest,
	setBondOptOut,
	setNetifDupIpSuppression,
	setQueueUpdateGwHook,
} from "../modules/network/network-interfaces.ts";
import {
	type RouterCellularScanDeps,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import { setNetifState } from "../modules/network/state/netif-state.ts";
import {
	CARRIER_LOSS_HOLD_MS,
	READMIT_SETTLE_MS,
	WifiCarrierWatch,
} from "../modules/network/wifi-carrier-watch.ts";
import { genSrtlaIpList } from "../modules/streaming/srtla.ts";

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

function stanza(
	link: { name: string; ip: string; mac: string },
	running: boolean,
): string {
	const flags = running
		? "flags=4163<UP,BROADCAST,RUNNING,MULTICAST>"
		: "flags=4099<UP,BROADCAST,MULTICAST>";
	return [
		`${link.name}: ${flags}  mtu 1500`,
		`        inet ${link.ip}  netmask 255.255.255.0  broadcast ${link.ip.replace(/\.\d+$/, ".255")}`,
		`        ether ${link.mac}  txqueuelen 1000  (Ethernet)`,
		"        RX packets 200  bytes 20000 (20.0 KB)",
		"        TX packets 100  bytes 1000 (1.0 KB)",
	].join("\n");
}

const NO_USB: RouterCellularScanDeps = {
	sysfsRoot: "/",
	udevDataRoot: "/run/udev/data",
	listDir: async () => [],
	readAttr: async () => undefined,
	resolveLink: async () => undefined,
	readLinkName: async () => undefined,
};

const LINE_TAIL =
	"mtu 1500 qdisc noqueue state %S mode DORMANT group default \\    link/ether aa:bb:cc:00:00:01 brd ff:ff:ff:ff:ff:ff";

function linkLine(ifname: string, carrier: boolean): string {
	return carrier
		? `3: ${ifname}: <BROADCAST,MULTICAST,UP,LOWER_UP> ${LINE_TAIL.replace("%S", "UP")}`
		: `3: ${ifname}: <NO-CARRIER,BROADCAST,MULTICAST,UP> ${LINE_TAIL.replace("%S", "DORMANT")}`;
}

/** A box whose kernel carrier state the test sets, with fake timers. */
function bench() {
	const carrier = new Map(ALL.map((link) => [link.name, true]));
	let clock = 0;
	let refreshes = 0;
	const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
	// The device refresh scans the USB tree before it publishes. None of these
	// links hangs off USB here (the radios sit on SDIO and PCIe, the modem on
	// PCIe), so the scan covers every name and a returning radio's identity
	// settles in the same refresh, as on the box.
	const publish = () =>
		processIfconfigOutput(
			ALL.map((link) => stanza(link, carrier.get(link.name) === true)).join(
				"\n\n",
			),
			undefined,
			undefined,
			undefined,
			// `ip addr` reports each row's ifindex, as the device refresh reads it.
			new Map(ALL.map((link) => [link.name, ifindexOf.get(link.name) ?? 0])),
		);
	const sample = async () => {
		await refreshUsbNetMarkers(
			ALL.filter((link) => carrier.get(link.name)).map((link) => link.name),
			NO_USB,
		);
		publish();
	};
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
		isPublished: (ifname) => getNetworkInterfaces()[ifname] !== undefined,
		bondMembers: () =>
			Object.entries(getNetworkInterfaces())
				.filter(([name, int]) => isBondCandidate(name, int))
				.map(([name]) => name),
		refresh: () => {
			refreshes++;
			return sample();
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
	const settle = async () => {
		for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
	};
	/** Move the fake clock, running each due timer and the refresh it starts. */
	const advance = async (ms: number) => {
		const until = clock + ms;
		for (;;) {
			const due = timers
				.filter((t) => t.live && t.at <= until)
				.sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			due.live = false;
			clock = due.at;
			due.fn();
			await settle();
		}
		clock = until;
	};
	/** The kernel changes a link's carrier and the monitor prints the edge. */
	const setCarrier = (ifname: string, up: boolean) => {
		carrier.set(ifname, up);
		watch.handleLine(linkLine(ifname, up));
	};
	return {
		watch,
		settle,
		advance,
		setCarrier,
		sample,
		refreshes: () => refreshes,
	};
}

/** The kernel's ifindex per name; a test replaces a netdev by changing it. */
const ifindexOf = new Map<string, number>();

beforeEach(() => {
	ifindexOf.clear();
	for (const [i, link] of ALL.entries()) ifindexOf.set(link.name, 3 + i);
	spyOn(netdevPresence, "inSysfs").mockImplementation((name) =>
		ifindexOf.has(name),
	);
	spyOn(netdevPresence, "ifindex").mockImplementation((name) =>
		ifindexOf.get(name),
	);
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
	const netif = getNetworkInterfaces();
	for (const name of Object.keys(netif)) delete netif[name];
	setNetifState({});
	for (const link of ALL) setNetifDupIpSuppression(link.name, false);
	resetBondOptOut();
	setQueueUpdateGwHook(null);
});

afterEach(() => {
	(netdevPresence.inSysfs as unknown as { mockRestore(): void }).mockRestore();
	(netdevPresence.ifindex as unknown as { mockRestore(): void }).mockRestore();
});

describe("Wi-Fi carrier loss and the bond", () => {
	test("a radio whose carrier stays down leaves the bond after the hold", async () => {
		const b = bench();
		await b.sample();
		b.watch.start();
		for (const link of ALL) b.watch.handleLine(linkLine(link.name, true));
		expect(genSrtlaIpList().sort()).toEqual(
			[MODEM.ip, RADIO_A.ip, RADIO_B.ip].sort(),
		);

		b.setCarrier(RADIO_A.name, false);
		await b.advance(CARRIER_LOSS_HOLD_MS - 1);
		// Before the hold nothing moved: the bond still holds the deaf radio.
		expect(genSrtlaIpList()).toContain(RADIO_A.ip);
		await b.advance(1);
		expect(genSrtlaIpList().sort()).toEqual([MODEM.ip, RADIO_B.ip].sort());
		// The other radio and the modem rode the same refresh untouched.
		expect(getNetworkInterfaces()[MODEM.name]?.enabled).toBe(true);
		expect(getNetworkInterfaces()[RADIO_B.name]).toBeDefined();
		b.watch.stop();
	});

	test("the radio is readmitted when its carrier returns", async () => {
		const b = bench();
		await b.sample();
		b.watch.start();
		for (const link of ALL) b.watch.handleLine(linkLine(link.name, true));
		b.setCarrier(RADIO_A.name, false);
		await b.advance(CARRIER_LOSS_HOLD_MS);
		expect(genSrtlaIpList()).not.toContain(RADIO_A.ip);

		// Re-associated with the other AP 1.5 s later, address kept.
		await b.advance(1_500);
		b.setCarrier(RADIO_A.name, true);
		await b.advance(READMIT_SETTLE_MS);
		expect(genSrtlaIpList().sort()).toEqual(
			[MODEM.ip, RADIO_A.ip, RADIO_B.ip].sort(),
		);
		expect(b.refreshes()).toBe(2);
		b.watch.stop();
	});

	test("a radio the operator took out of the bond stays out on readmission", async () => {
		const b = bench();
		setBondOptOut(RADIO_A.name, true);
		await b.sample();
		b.watch.start();
		for (const link of ALL) b.watch.handleLine(linkLine(link.name, true));
		expect(genSrtlaIpList()).not.toContain(RADIO_A.ip);
		b.setCarrier(RADIO_A.name, false);
		await b.advance(CARRIER_LOSS_HOLD_MS);
		await b.advance(1_000);
		b.setCarrier(RADIO_A.name, true);
		await b.advance(READMIT_SETTLE_MS);
		expect(getNetworkInterfaces()[RADIO_A.name]).toBeDefined();
		expect(genSrtlaIpList().sort()).toEqual([MODEM.ip, RADIO_B.ip].sort());
		b.watch.stop();
	});

	test("another netdev under the radio's name starts without the old toggle", async () => {
		const b = bench();
		await b.sample();
		setBondOptOut(RADIO_A.name, true);
		b.watch.start();
		for (const link of ALL) b.watch.handleLine(linkLine(link.name, true));
		b.setCarrier(RADIO_A.name, false);
		await b.advance(CARRIER_LOSS_HOLD_MS);
		// The radio was unplugged and another one took its name meanwhile.
		ifindexOf.set(RADIO_A.name, 40);
		await b.advance(1_000);
		b.setCarrier(RADIO_A.name, true);
		await b.advance(READMIT_SETTLE_MS);
		await b.sample();
		expect(genSrtlaIpList()).toContain(RADIO_A.ip);
		b.watch.stop();
	});

	test("a roam-length gap leaves the bond as it was", async () => {
		const b = bench();
		await b.sample();
		b.watch.start();
		for (const link of ALL) b.watch.handleLine(linkLine(link.name, true));
		b.setCarrier(RADIO_B.name, false);
		await b.advance(CARRIER_LOSS_HOLD_MS / 2);
		b.setCarrier(RADIO_B.name, true);
		await b.advance(10_000);
		expect(b.refreshes()).toBe(0);
		expect(genSrtlaIpList()).toContain(RADIO_B.ip);
		b.watch.stop();
	});

	test("both radios on a lost AP stay in a bond with nothing else", async () => {
		const b = bench();
		setBondOptOut(MODEM.name, true);
		await b.sample();
		b.watch.start();
		for (const link of ALL) b.watch.handleLine(linkLine(link.name, true));
		expect(genSrtlaIpList().sort()).toEqual([RADIO_A.ip, RADIO_B.ip].sort());
		b.setCarrier(RADIO_A.name, false);
		b.setCarrier(RADIO_B.name, false);
		await b.advance(1_200);
		// An empty bond would drop every sender connection: nothing moved.
		expect(b.refreshes()).toBe(0);
		expect(genSrtlaIpList().sort()).toEqual([RADIO_A.ip, RADIO_B.ip].sort());
		// RADIO_B finds the other AP; RADIO_A stays down and is withdrawn then.
		b.setCarrier(RADIO_B.name, true);
		await b.advance(READMIT_SETTLE_MS);
		expect(genSrtlaIpList()).toEqual([RADIO_B.ip]);
		b.watch.stop();
	});

	test("a modem losing its carrier is left to the modem paths", async () => {
		const b = bench();
		await b.sample();
		b.watch.start();
		for (const link of ALL) b.watch.handleLine(linkLine(link.name, true));
		b.setCarrier(MODEM.name, false);
		await b.advance(10_000);
		expect(b.refreshes()).toBe(0);
		// Still published until the poll or a modem event says otherwise.
		expect(genSrtlaIpList()).toContain(MODEM.ip);
		b.watch.stop();
	});
});
