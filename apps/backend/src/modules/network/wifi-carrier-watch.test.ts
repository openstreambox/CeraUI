/*
  The kernel's link notifications are a TRIGGER for the netif refresh, never a
  bond decision.

  The parser runs against the exact line shapes `ip -o monitor link` prints for
  a station radio (associated, carrier lost while the supplicant searches,
  administratively down, deleted) and must read RUNNING the way the kernel and
  `ifconfig` do. The watcher half drives a fake child and fake timers: a carrier
  loss that outlasts the hold refreshes once, a roam-length gap or a blip
  refreshes nothing, a returned carrier readmits after the settle, and only
  Wi-Fi station interfaces are followed.
*/

import { describe, expect, test } from "bun:test";

import type {
	ManagedProcess,
	WatcherHandle,
} from "../../helpers/spawn-policy.ts";
import {
	CARRIER_LOSS_HOLD_MS,
	parseLinkStateLine,
	READMIT_SETTLE_MS,
	RESTART_MAX_MS,
	RESTART_MIN_MS,
	WifiCarrierWatch,
	type WifiCarrierWatchDeps,
} from "./wifi-carrier-watch.ts";

const TAIL =
	"mtu 1500 qdisc noqueue state %S mode DORMANT group default \\    link/ether d8:44:89:74:ef:48 brd ff:ff:ff:ff:ff:ff";

function linkLine(
	ifname: string,
	flags: string,
	state: string,
	index = 3,
): string {
	return `${index}: ${ifname}: <${flags}> ${TAIL.replace("%S", state)}`;
}

const ASSOCIATED = "BROADCAST,MULTICAST,UP,LOWER_UP";
const NO_CARRIER = "NO-CARRIER,BROADCAST,MULTICAST,UP";

describe("parseLinkStateLine", () => {
	test("an associated station is running", () => {
		expect(parseLinkStateLine(linkLine("wlan0", ASSOCIATED, "UP"))).toEqual({
			ifname: "wlan0",
			running: true,
		});
	});

	test("a station that lost its AP is not running", () => {
		expect(
			parseLinkStateLine(linkLine("wlxd8448974ef48", NO_CARRIER, "DOWN")),
		).toEqual({ ifname: "wlxd8448974ef48", running: false });
		// Carrier back, WPA handshake not finished: the supplicant has not set
		// the link up yet, so RUNNING is still clear.
		expect(
			parseLinkStateLine(linkLine("wlan0", ASSOCIATED, "DORMANT")),
		).toEqual({ ifname: "wlan0", running: false });
	});

	test("UNKNOWN counts as running only with the carrier", () => {
		expect(
			parseLinkStateLine(linkLine("wlan0", ASSOCIATED, "UNKNOWN")),
		).toEqual({ ifname: "wlan0", running: true });
		expect(
			parseLinkStateLine(linkLine("wlan0", NO_CARRIER, "UNKNOWN")),
		).toEqual({ ifname: "wlan0", running: false });
	});

	test("an administratively down or deleted link is not running", () => {
		expect(
			parseLinkStateLine(linkLine("wlan0", "BROADCAST,MULTICAST", "DOWN")),
		).toEqual({ ifname: "wlan0", running: false });
		expect(
			parseLinkStateLine(
				`Deleted ${linkLine("wlan1", "BROADCAST,MULTICAST", "DOWN", 7)}`,
			),
		).toEqual({ ifname: "wlan1", running: false });
	});

	test("accepts a peer suffix and a bracketed object prefix", () => {
		expect(
			parseLinkStateLine(`[LINK]${linkLine("wlan0", ASSOCIATED, "UP")}`),
		).toEqual({ ifname: "wlan0", running: true });
		expect(
			parseLinkStateLine(
				"5: veth1@if4: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default",
			),
		).toEqual({ ifname: "veth1", running: true });
	});

	test("ignores lines that are not link state", () => {
		for (const line of [
			"",
			"    link/ether d8:44:89:74:ef:48 brd ff:ff:ff:ff:ff:ff",
			"3: wlan0    inet 192.168.178.20/24 brd 192.168.178.255 scope global dynamic wlan0",
			"Deleted 192.168.178.0/24 dev wlan0 proto kernel scope link",
			"3: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500",
		]) {
			expect(parseLinkStateLine(line)).toBeUndefined();
		}
	});
});

type Scheduled = {
	callback: () => void;
	ms: number;
	at: number;
	cleared: boolean;
};

function harness(
	options: {
		stations?: readonly string[];
		published?: Set<string>;
		refresh?: () => void;
	} = {},
) {
	const stations = options.stations ?? ["wlan0", "wlan1"];
	const published = options.published ?? new Set(stations);
	let clock = 0;
	const scheduled: Scheduled[] = [];
	const spawned: string[][] = [];
	let refreshes = 0;
	const children: Array<{
		push: (text: string) => void;
		end: () => void;
		aborted: () => boolean;
	}> = [];

	const deps: WifiCarrierWatchDeps = {
		spawn: (argv) => {
			spawned.push(argv);
			let controller!: ReadableStreamDefaultController<Uint8Array>;
			const stdout = new ReadableStream<Uint8Array>({
				start(c) {
					controller = c;
				},
			});
			let exit!: (code: number) => void;
			const exited = new Promise<number>((resolve) => {
				exit = resolve;
			});
			let aborted = false;
			const proc: ManagedProcess = {
				stdout,
				stderr: null,
				exited,
				exitCode: null,
				signalCode: null,
				kill: () => undefined,
			};
			const end = () => {
				try {
					controller.close();
				} catch {
					/* already closed */
				}
				exit(0);
			};
			children.push({
				push: (text) => controller.enqueue(new TextEncoder().encode(text)),
				end,
				aborted: () => aborted,
			});
			const handle: WatcherHandle = {
				proc,
				abort: () => {
					aborted = true;
					end();
				},
			};
			return handle;
		},
		isWifiStation: (ifname) => stations.includes(ifname),
		isPublished: (ifname) => published.has(ifname),
		refresh: () => {
			refreshes++;
			options.refresh?.();
		},
		now: () => clock,
		setTimeout: (callback, ms) => {
			scheduled.push({ callback, ms, at: clock + ms, cleared: false });
			return scheduled.length - 1;
		},
		clearTimeout: (timer) => {
			const entry = scheduled[timer as number];
			if (entry) entry.cleared = true;
		},
	};
	/** Move the fake clock and run every timer that falls due, in order. */
	const advance = (ms: number) => {
		const until = clock + ms;
		for (;;) {
			const due = scheduled
				.filter((entry) => !entry.cleared && entry.at <= until)
				.sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			due.cleared = true;
			clock = due.at;
			due.callback();
		}
		clock = until;
	};
	const pending = () => scheduled.filter((entry) => !entry.cleared);
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
	return {
		deps,
		published,
		spawned,
		children,
		advance,
		pending,
		flush,
		refreshes: () => refreshes,
	};
}

describe("WifiCarrierWatch", () => {
	test("spawns the link monitor once and stops it", () => {
		const h = harness();
		const watch = new WifiCarrierWatch(h.deps);
		watch.start();
		watch.start();
		expect(h.spawned).toEqual([["ip", "-o", "monitor", "link"]]);
		expect(watch.running).toBe(true);
		watch.stop();
		expect(h.children[0]?.aborted()).toBe(true);
		expect(watch.running).toBe(false);
	});

	test("a carrier loss that outlasts the hold refreshes the bond once", () => {
		const h = harness();
		const watch = new WifiCarrierWatch(h.deps);
		watch.start();
		watch.handleLine(linkLine("wlan0", ASSOCIATED, "UP"));
		watch.handleLine(linkLine("wlan0", NO_CARRIER, "DORMANT"));
		// Repeated lines while the radio searches change nothing.
		watch.handleLine(linkLine("wlan0", NO_CARRIER, "DORMANT"));
		h.advance(CARRIER_LOSS_HOLD_MS - 1);
		expect(h.refreshes()).toBe(0);
		h.advance(1);
		expect(h.refreshes()).toBe(1);
		h.advance(10_000);
		expect(h.refreshes()).toBe(1);
		watch.stop();
	});

	test("a carrier back within the hold refreshes nothing", () => {
		const h = harness();
		const watch = new WifiCarrierWatch(h.deps);
		watch.start();
		watch.handleLine(linkLine("wlan0", ASSOCIATED, "UP"));
		// Twenty roam-length gaps: authentication, association and handshake
		// with the next AP, each shorter than the hold.
		for (let roam = 0; roam < 20; roam++) {
			watch.handleLine(linkLine("wlan0", NO_CARRIER, "DORMANT"));
			h.advance(CARRIER_LOSS_HOLD_MS - 50);
			watch.handleLine(linkLine("wlan0", ASSOCIATED, "DORMANT"));
			h.advance(20);
			watch.handleLine(linkLine("wlan0", ASSOCIATED, "UP"));
			h.advance(1_000);
		}
		expect(h.refreshes()).toBe(0);
		expect(h.pending()).toEqual([]);
		watch.stop();
	});

	test("a returned carrier readmits an unpublished radio after the settle", () => {
		const h = harness();
		const watch = new WifiCarrierWatch(h.deps);
		watch.start();
		watch.handleLine(linkLine("wlan0", ASSOCIATED, "UP"));
		watch.handleLine(linkLine("wlan0", NO_CARRIER, "DORMANT"));
		h.advance(CARRIER_LOSS_HOLD_MS);
		expect(h.refreshes()).toBe(1);
		// The refresh withdrew the row.
		h.published.delete("wlan0");
		h.advance(1_500);
		watch.handleLine(linkLine("wlan0", ASSOCIATED, "UP"));
		h.advance(READMIT_SETTLE_MS - 1);
		expect(h.refreshes()).toBe(1);
		h.advance(1);
		expect(h.refreshes()).toBe(2);
		watch.stop();
	});

	test("a carrier lost again during the settle is not readmitted", () => {
		const h = harness({ published: new Set() });
		const watch = new WifiCarrierWatch(h.deps);
		watch.start();
		watch.handleLine(linkLine("wlan0", NO_CARRIER, "DORMANT"));
		watch.handleLine(linkLine("wlan0", ASSOCIATED, "UP"));
		h.advance(READMIT_SETTLE_MS / 2);
		watch.handleLine(linkLine("wlan0", NO_CARRIER, "DORMANT"));
		h.advance(10_000);
		// Unpublished: nothing to withdraw, and the settle was cancelled.
		expect(h.refreshes()).toBe(0);
		watch.stop();
	});

	test("a radio the poll already withdrew during the hold is left to it", () => {
		const h = harness();
		const watch = new WifiCarrierWatch(h.deps);
		watch.start();
		watch.handleLine(linkLine("wlan1", ASSOCIATED, "UP"));
		watch.handleLine(linkLine("wlan1", NO_CARRIER, "DOWN"));
		h.published.delete("wlan1");
		h.advance(CARRIER_LOSS_HOLD_MS);
		expect(h.refreshes()).toBe(0);
		watch.stop();
	});

	test("a still-published running radio is not refreshed on its up edge", () => {
		const h = harness();
		const watch = new WifiCarrierWatch(h.deps);
		watch.start();
		watch.handleLine(linkLine("wlan0", ASSOCIATED, "UP"));
		h.advance(10_000);
		expect(h.refreshes()).toBe(0);
		watch.stop();
	});

	test("cellular, Ethernet and hotspot interfaces are never followed", () => {
		const h = harness({
			stations: ["wlan0"],
			published: new Set(["wlan0", "wwan0", "eth0", "usb0", "ap0"]),
		});
		const watch = new WifiCarrierWatch(h.deps);
		watch.start();
		for (const ifname of ["wwan0", "eth0", "usb0", "ap0"]) {
			watch.handleLine(linkLine(ifname, ASSOCIATED, "UP", 9));
			watch.handleLine(linkLine(ifname, NO_CARRIER, "DOWN", 9));
		}
		h.advance(10_000);
		expect(h.refreshes()).toBe(0);
		expect(h.pending()).toEqual([]);
		watch.stop();
	});

	test("a station that turns into a hotspot drops its pending hold", () => {
		const stations = ["wlan0"];
		const h = harness({ stations });
		const watch = new WifiCarrierWatch(h.deps);
		watch.start();
		watch.handleLine(linkLine("wlan0", ASSOCIATED, "UP"));
		watch.handleLine(linkLine("wlan0", NO_CARRIER, "DORMANT"));
		stations.length = 0;
		watch.handleLine(linkLine("wlan0", ASSOCIATED, "UP"));
		h.advance(10_000);
		expect(h.refreshes()).toBe(0);
		watch.stop();
	});

	test("withdrawals are bounded by the hold under a flapping carrier", () => {
		const h = harness();
		const watch = new WifiCarrierWatch(h.deps);
		watch.start();
		watch.handleLine(linkLine("wlan0", ASSOCIATED, "UP"));
		// A carrier toggling every 100 ms for 10 s never stays down for the hold.
		for (let i = 0; i < 50; i++) {
			watch.handleLine(linkLine("wlan0", NO_CARRIER, "DORMANT"));
			h.advance(100);
			watch.handleLine(linkLine("wlan0", ASSOCIATED, "UP"));
			h.advance(100);
		}
		expect(h.refreshes()).toBe(0);
		watch.stop();
	});

	test("reads lines across chunk boundaries from the child", async () => {
		const h = harness();
		const watch = new WifiCarrierWatch(h.deps);
		watch.start();
		const child = h.children[0];
		if (!child) throw new Error("no child");
		const down = `${linkLine("wlan0", NO_CARRIER, "DORMANT")}\n`;
		child.push(`${linkLine("wlan0", ASSOCIATED, "UP")}\n${down.slice(0, 20)}`);
		child.push(down.slice(20));
		await h.flush();
		h.advance(CARRIER_LOSS_HOLD_MS);
		expect(h.refreshes()).toBe(1);
		watch.stop();
	});

	test("restarts a dead child with a growing delay and forgets its edges", async () => {
		const h = harness();
		const watch = new WifiCarrierWatch(h.deps);
		watch.start();
		const first = h.children[0];
		if (!first) throw new Error("no child");
		first.push(`${linkLine("wlan0", ASSOCIATED, "UP")}\n`);
		first.push(`${linkLine("wlan0", NO_CARRIER, "DORMANT")}\n`);
		await h.flush();
		first.end();
		await h.flush();
		await h.flush();
		expect(watch.running).toBe(false);
		// The dead child's pending hold is gone with it; the poll covers the gap.
		h.advance(RESTART_MIN_MS);
		expect(h.refreshes()).toBe(0);
		expect(h.spawned).toHaveLength(2);
		const second = h.children[1];
		second?.end();
		await h.flush();
		await h.flush();
		h.advance(RESTART_MIN_MS);
		expect(h.spawned).toHaveLength(2);
		h.advance(RESTART_MIN_MS);
		expect(h.spawned).toHaveLength(3);
		expect(RESTART_MAX_MS).toBeGreaterThan(RESTART_MIN_MS);
		watch.stop();
	});

	test("a spawn failure retries later instead of throwing", () => {
		const h = harness();
		let calls = 0;
		const watch = new WifiCarrierWatch({
			...h.deps,
			spawn: (argv) => {
				calls++;
				if (calls === 1) throw new Error("ENOENT ip");
				return h.deps.spawn(argv);
			},
		});
		expect(() => watch.start()).not.toThrow();
		expect(watch.running).toBe(false);
		h.advance(RESTART_MIN_MS);
		expect(watch.running).toBe(true);
		watch.stop();
	});

	test("a refresh that rejects is contained", async () => {
		const h = harness();
		const watch = new WifiCarrierWatch({
			...h.deps,
			refresh: () => Promise.reject(new Error("ifconfig failed")),
		});
		watch.start();
		watch.handleLine(linkLine("wlan0", ASSOCIATED, "UP"));
		watch.handleLine(linkLine("wlan0", NO_CARRIER, "DORMANT"));
		expect(() => h.advance(CARRIER_LOSS_HOLD_MS)).not.toThrow();
		await h.flush();
		watch.stop();
	});
});
