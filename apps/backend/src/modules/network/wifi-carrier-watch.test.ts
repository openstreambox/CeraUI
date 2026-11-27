/*
  The kernel's link notifications mark a Wi-Fi link that lost its access
  point; they never decide bond membership.

  The parser runs against the exact line shapes `ip -o monitor link` prints for
  a station radio (associated, carrier lost while the supplicant searches,
  administratively down, deleted) and must read RUNNING the way the kernel and
  `ifconfig` do. The watcher half drives a fake child and fake timers: a carrier
  loss that outlasts the hold marks the link once (after sysfs agrees, bound to
  its ifindex), a roam-length gap or a blip marks nothing, a returned carrier
  clears the mark after the settle, a stranded mark is cleared by the sysfs
  check, a deleted or replaced netdev drops its mark, the watch never samples
  the netif rows, and only Wi-Fi station interfaces are followed. The child's lifetime is checked too:
  a dead reader is reaped, buffered lines after a stop are ignored, and only a
  child that lived resets the restart delay.
*/

import { describe, expect, test } from "bun:test";

import type {
	ManagedProcess,
	WatcherHandle,
} from "../../helpers/spawn-policy.ts";
import {
	CARRIER_LOSS_HOLD_MS,
	HEALTHY_CHILD_MS,
	MARK_CHECK_MS,
	parseLinkStateLine,
	READMIT_SETTLE_MS,
	RESTART_MIN_MS,
	sysfsOperational,
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
		expect(
			parseLinkStateLine(linkLine("wlan0", ASSOCIATED, "UP")),
		).toMatchObject({
			ifname: "wlan0",
			running: true,
		});
	});

	test("a station that lost its AP is not running", () => {
		expect(
			parseLinkStateLine(linkLine("wlxd8448974ef48", NO_CARRIER, "DOWN")),
		).toMatchObject({ ifname: "wlxd8448974ef48", running: false });
		// Carrier back, WPA handshake not finished: the supplicant has not set
		// the link up yet, so RUNNING is still clear.
		expect(
			parseLinkStateLine(linkLine("wlan0", ASSOCIATED, "DORMANT")),
		).toMatchObject({ ifname: "wlan0", running: false });
	});

	test("UNKNOWN counts as running only with the carrier", () => {
		expect(
			parseLinkStateLine(linkLine("wlan0", ASSOCIATED, "UNKNOWN")),
		).toMatchObject({ ifname: "wlan0", running: true });
		expect(
			parseLinkStateLine(linkLine("wlan0", NO_CARRIER, "UNKNOWN")),
		).toMatchObject({ ifname: "wlan0", running: false });
	});

	test("an administratively down or deleted link is not running", () => {
		expect(
			parseLinkStateLine(linkLine("wlan0", "BROADCAST,MULTICAST", "DOWN")),
		).toMatchObject({ ifname: "wlan0", running: false });
		expect(
			parseLinkStateLine(
				`Deleted ${linkLine("wlan1", "BROADCAST,MULTICAST", "DOWN", 7)}`,
			),
		).toMatchObject({
			ifname: "wlan1",
			running: false,
			deleted: true,
			ifindex: 7,
		});
	});

	test("accepts a peer suffix and a bracketed object prefix", () => {
		expect(
			parseLinkStateLine(`[LINK]${linkLine("wlan0", ASSOCIATED, "UP")}`),
		).toMatchObject({ ifname: "wlan0", running: true });
		expect(
			parseLinkStateLine(
				"5: veth1@if4: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default",
			),
		).toMatchObject({ ifname: "veth1", running: true });
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
	at: number;
	cleared: boolean;
};

type Child = {
	push: (text: string) => void;
	end: () => void;
	fail: () => void;
	aborted: () => boolean;
};

function harness(options: { stations?: string[] } = {}) {
	const stations = options.stations ?? ["wlan0", "wlan1"];
	const carrier = new Map<string, boolean>();
	let clock = 0;
	const scheduled: Scheduled[] = [];
	const spawned: string[][] = [];
	const marks: Array<[string, boolean]> = [];
	const markIndex = new Map<string, number | undefined>();
	const lost = new Set<string>();
	const down = new Set<string>();
	const children: Child[] = [];

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
			let exitCode: number | null = null;
			const proc: ManagedProcess = {
				stdout,
				stderr: null,
				exited,
				get exitCode() {
					return exitCode;
				},
				signalCode: null,
				kill: () => undefined,
			} as ManagedProcess;
			const end = () => {
				try {
					controller.close();
				} catch {
					/* already closed */
				}
				exitCode = 0;
				exit(0);
			};
			children.push({
				push: (text) => controller.enqueue(new TextEncoder().encode(text)),
				end,
				// The stream errors while the child itself keeps running.
				fail: () => controller.error(new Error("read failed")),
				aborted: () => aborted,
			});
			return {
				proc,
				abort: () => {
					if (aborted) return;
					aborted = true;
					exitCode = 143;
					exit(143);
				},
			} satisfies WatcherHandle;
		},
		isWifiStation: (ifname) => stations.includes(ifname),
		isOperational: (ifname) => carrier.get(ifname) !== false,
		setLost: (ifname, value, ifindex) => {
			marks.push([ifname, value]);
			markIndex.set(ifname, ifindex);
			if (value) lost.add(ifname);
			else lost.delete(ifname);
		},
		setDown: (ifname, value) => {
			if (value) down.add(ifname);
			else down.delete(ifname);
		},
		now: () => clock,
		setTimeout: (callback, ms) => {
			scheduled.push({ callback, at: clock + ms, cleared: false });
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
	const flush = async () => {
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	};
	const watch = new WifiCarrierWatch(deps);
	/** The kernel changes a link's carrier and the monitor prints the edge. */
	const edge = (
		ifname: string,
		up: boolean,
		state = up ? "UP" : "DORMANT",
		index = 3,
	) => {
		carrier.set(ifname, up);
		watch.handleLine(
			linkLine(ifname, up ? ASSOCIATED : NO_CARRIER, state, index),
		);
	};
	return {
		deps,
		watch,
		stations,
		carrier,
		spawned,
		marks,
		markIndex,
		lost,
		down,
		children,
		advance,
		flush,
		edge,
		pending: () => scheduled.filter((entry) => !entry.cleared),
	};
}

describe("WifiCarrierWatch marks", () => {
	test("spawns the link monitor once and stops it", () => {
		const h = harness();
		h.watch.start();
		h.watch.start();
		expect(h.spawned).toEqual([["ip", "-o", "monitor", "link"]]);
		expect(h.watch.running).toBe(true);
		h.watch.stop();
		expect(h.children[0]?.aborted()).toBe(true);
		expect(h.watch.running).toBe(false);
	});

	test("a carrier loss that outlasts the hold marks the link once", () => {
		const h = harness();
		h.watch.start();
		h.edge("wlan0", true);
		h.edge("wlan0", false);
		// Repeated lines while the radio searches change nothing.
		h.edge("wlan0", false);
		h.advance(CARRIER_LOSS_HOLD_MS - 1);
		expect(h.marks).toEqual([]);
		h.advance(1);
		expect(h.marks).toEqual([["wlan0", true]]);
		expect(h.markIndex.get("wlan0")).toBe(3);
		expect(h.down.has("wlan0")).toBe(true);
		h.advance(3 * MARK_CHECK_MS);
		expect(h.marks).toEqual([["wlan0", true]]);
		h.watch.stop();
	});

	test("the carrier back clears the mark after the settle", () => {
		const h = harness();
		h.watch.start();
		h.edge("wlan0", true);
		h.edge("wlan0", false);
		h.advance(CARRIER_LOSS_HOLD_MS + 1_500);
		h.edge("wlan0", true);
		h.advance(READMIT_SETTLE_MS - 1);
		expect(h.lost.has("wlan0")).toBe(true);
		h.advance(1);
		expect(h.marks).toEqual([
			["wlan0", true],
			["wlan0", false],
		]);
		expect(h.down.has("wlan0")).toBe(false);
		h.watch.stop();
	});

	test("a carrier lost again during the settle keeps the mark", () => {
		const h = harness();
		h.watch.start();
		h.edge("wlan0", true);
		h.edge("wlan0", false);
		h.advance(CARRIER_LOSS_HOLD_MS);
		h.edge("wlan0", true);
		h.advance(READMIT_SETTLE_MS / 2);
		h.edge("wlan0", false);
		h.advance(READMIT_SETTLE_MS);
		expect(h.lost.has("wlan0")).toBe(true);
		h.watch.stop();
	});

	test("a carrier back within the hold marks nothing", () => {
		const h = harness();
		h.watch.start();
		h.edge("wlan0", true);
		// Twenty roam-length gaps: authentication, association and handshake
		// with the next AP, each shorter than the hold.
		for (let roam = 0; roam < 20; roam++) {
			h.edge("wlan0", false);
			h.advance(CARRIER_LOSS_HOLD_MS - 50);
			h.edge("wlan0", true, "DORMANT");
			h.advance(20);
			h.edge("wlan0", true);
			h.advance(1_000);
		}
		expect(h.marks).toEqual([]);
		expect(h.pending()).toEqual([]);
		h.watch.stop();
	});

	test("a flapping carrier never stays down for the hold", () => {
		const h = harness();
		h.watch.start();
		h.edge("wlan0", true);
		for (let i = 0; i < 50; i++) {
			h.edge("wlan0", false);
			h.advance(100);
			h.edge("wlan0", true);
			h.advance(100);
		}
		expect(h.marks).toEqual([]);
		h.watch.stop();
	});

	test("one radio's timers never act on another radio", () => {
		const h = harness();
		h.watch.start();
		h.edge("wlan0", true);
		h.edge("wlan1", true);
		h.edge("wlan0", false);
		h.advance(CARRIER_LOSS_HOLD_MS - 50);
		// wlan1 starts a short roam just before wlan0's hold expires.
		h.edge("wlan1", false);
		h.advance(50);
		expect(h.marks).toEqual([["wlan0", true]]);
		h.advance(100);
		h.edge("wlan1", true);
		h.advance(10_000);
		expect(h.marks).toEqual([["wlan0", true]]);
		h.watch.stop();
	});

	test("sysfs must agree before a mark is set", () => {
		const h = harness();
		h.watch.start();
		h.edge("wlan0", true);
		h.watch.handleLine(linkLine("wlan0", NO_CARRIER, "DORMANT"));
		// The monitor said down, but the kernel reports the link up.
		h.carrier.set("wlan0", true);
		h.advance(CARRIER_LOSS_HOLD_MS);
		expect(h.marks).toEqual([]);
		expect(h.down.has("wlan0")).toBe(false);
		// The kernel's state was taken: the next real loss is an edge again.
		h.edge("wlan0", false);
		h.advance(CARRIER_LOSS_HOLD_MS);
		expect(h.marks).toEqual([["wlan0", true]]);
		h.watch.stop();
	});

	test("the sysfs check leaves a settling radio to its settle", () => {
		const h = harness();
		h.watch.start();
		h.edge("wlan0", true);
		h.edge("wlan0", false);
		h.advance(CARRIER_LOSS_HOLD_MS);
		// The carrier returns 50 ms before the check is due.
		h.advance(MARK_CHECK_MS - 50);
		h.edge("wlan0", true);
		h.advance(50);
		expect(h.lost.has("wlan0")).toBe(true);
		// It drops again inside the settle: the mark was never cleared.
		h.advance(50);
		h.edge("wlan0", false);
		h.advance(READMIT_SETTLE_MS);
		expect(h.lost.has("wlan0")).toBe(true);
		expect(h.marks).toEqual([["wlan0", true]]);
		h.watch.stop();
	});

	test("an async sysfs answer is applied when it lands, and only if still current", async () => {
		const h = harness();
		let answer!: (value: boolean) => void;
		const watch = new WifiCarrierWatch({
			...h.deps,
			isOperational: () =>
				new Promise<boolean>((resolve) => {
					answer = resolve;
				}),
		});
		watch.start();
		watch.handleLine(linkLine("wlan0", ASSOCIATED, "UP"));
		watch.handleLine(linkLine("wlan0", NO_CARRIER, "DORMANT"));
		h.advance(CARRIER_LOSS_HOLD_MS);
		expect(h.marks).toEqual([]);
		answer(false);
		await h.flush();
		expect(h.marks).toEqual([["wlan0", true]]);
		// A late answer for a radio that is back again changes nothing.
		watch.handleLine(
			`Deleted ${linkLine("wlan1", "BROADCAST,MULTICAST", "DOWN")}`,
		);
		watch.handleLine(linkLine("wlan1", ASSOCIATED, "UP", 4));
		watch.handleLine(linkLine("wlan1", NO_CARRIER, "DORMANT", 4));
		h.advance(CARRIER_LOSS_HOLD_MS);
		watch.handleLine(linkLine("wlan1", ASSOCIATED, "UP", 4));
		answer(false);
		await h.flush();
		expect(h.marks).toEqual([["wlan0", true]]);
		watch.stop();
	});

	test("a late sysfs answer never acts on a newer edge", async () => {
		const h = harness();
		const answers: Array<(value: boolean) => void> = [];
		const watch = new WifiCarrierWatch({
			...h.deps,
			isOperational: () =>
				new Promise<boolean>((resolve) => {
					answers.push(resolve);
				}),
		});
		watch.start();
		watch.handleLine(linkLine("wlan0", ASSOCIATED, "UP"));
		watch.handleLine(linkLine("wlan0", NO_CARRIER, "DORMANT"));
		h.advance(CARRIER_LOSS_HOLD_MS);
		// While the first hold's read is in flight: back up, then down again.
		watch.handleLine(linkLine("wlan0", ASSOCIATED, "UP"));
		watch.handleLine(linkLine("wlan0", NO_CARRIER, "DORMANT"));
		answers[0]?.(false);
		await h.flush();
		// The second loss has not outlasted its own hold yet.
		expect(h.marks).toEqual([]);
		h.advance(CARRIER_LOSS_HOLD_MS);
		answers[1]?.(false);
		await h.flush();
		expect(h.marks).toEqual([["wlan0", true]]);
		// A periodic check's late "up" for the old edge does not clear a newer loss.
		h.advance(MARK_CHECK_MS);
		watch.handleLine(linkLine("wlan0", ASSOCIATED, "UP"));
		watch.handleLine(linkLine("wlan0", NO_CARRIER, "DORMANT"));
		answers[2]?.(true);
		await h.flush();
		expect(h.marks).toEqual([["wlan0", true]]);
		watch.stop();
	});

	test("a mark whose carrier-up line was lost is cleared by the sysfs check", () => {
		const h = harness();
		h.watch.start();
		h.edge("wlan0", true);
		h.edge("wlan0", false);
		h.advance(CARRIER_LOSS_HOLD_MS);
		expect(h.lost.has("wlan0")).toBe(true);
		// The radio re-associates but no line reaches the watch.
		h.carrier.set("wlan0", true);
		h.advance(MARK_CHECK_MS);
		expect(h.lost.has("wlan0")).toBe(false);
		// The check lapses on its next tick, with nothing left to check.
		h.advance(MARK_CHECK_MS);
		expect(h.pending()).toEqual([]);
		// A second loss after the recovered line is still seen and marked.
		h.edge("wlan0", false);
		h.advance(CARRIER_LOSS_HOLD_MS);
		expect(h.lost.has("wlan0")).toBe(true);
		h.watch.stop();
	});

	test("a deleted netdev drops its mark at once", () => {
		const h = harness();
		h.watch.start();
		h.edge("wlan1", true);
		h.edge("wlan1", false);
		h.advance(CARRIER_LOSS_HOLD_MS);
		expect(h.lost.has("wlan1")).toBe(true);
		h.watch.handleLine(
			`Deleted ${linkLine("wlan1", "BROADCAST,MULTICAST", "DOWN")}`,
		);
		expect(h.lost.has("wlan1")).toBe(false);
		expect(h.down.has("wlan1")).toBe(false);
		// The sysfs check finds nothing left to check and lapses.
		h.advance(MARK_CHECK_MS);
		expect(h.pending()).toEqual([]);
		h.watch.stop();
	});

	test("a netdev gone without its deletion line leaves no track behind", () => {
		const h = harness();
		const present = new Map<string, number | false>([["wlan1", 3]]);
		const watch = new WifiCarrierWatch({
			...h.deps,
			netdevNow: (ifname) => present.get(ifname),
		});
		watch.start();
		watch.handleLine(linkLine("wlan1", ASSOCIATED, "UP"));
		h.carrier.set("wlan1", false);
		watch.handleLine(linkLine("wlan1", NO_CARRIER, "DORMANT"));
		h.advance(CARRIER_LOSS_HOLD_MS);
		expect(h.lost.has("wlan1")).toBe(true);
		// The USB radio is unplugged; the monitor's deletion line never comes.
		present.set("wlan1", false);
		h.advance(MARK_CHECK_MS);
		expect(h.lost.has("wlan1")).toBe(false);
		expect(h.down.has("wlan1")).toBe(false);
		h.advance(MARK_CHECK_MS);
		expect(h.pending()).toEqual([]);
		watch.stop();
	});

	test("another netdev under the name does not inherit the mark", () => {
		const h = harness();
		h.watch.start();
		h.edge("wlan1", true, "UP", 7);
		h.edge("wlan1", false, "DORMANT", 7);
		h.advance(CARRIER_LOSS_HOLD_MS);
		expect(h.markIndex.get("wlan1")).toBe(7);
		// A replugged radio appears under the same name with a new ifindex.
		h.edge("wlan1", false, "DOWN", 9);
		expect(h.lost.has("wlan1")).toBe(false);
		h.advance(CARRIER_LOSS_HOLD_MS);
		expect(h.markIndex.get("wlan1")).toBe(9);
		h.watch.stop();
	});

	test("an up edge without a mark schedules nothing", () => {
		const h = harness();
		h.watch.start();
		h.edge("wlan0", true);
		h.edge("wlan1", false);
		h.edge("wlan1", true);
		h.advance(10_000);
		expect(h.marks).toEqual([]);
		expect(h.pending()).toEqual([]);
		h.watch.stop();
	});

	test("cellular, Ethernet and hotspot interfaces are never followed", () => {
		const h = harness({ stations: ["wlan0"] });
		h.watch.start();
		for (const ifname of ["wwan0", "eth0", "usb0", "ap0", "wl-test"]) {
			h.watch.handleLine(linkLine(ifname, ASSOCIATED, "UP", 9));
			h.watch.handleLine(linkLine(ifname, NO_CARRIER, "DOWN", 9));
		}
		h.advance(10_000);
		expect(h.marks).toEqual([]);
		expect(h.pending()).toEqual([]);
		h.watch.stop();
	});

	test("a station reclassified as a hotspot during the hold is not marked", () => {
		const h = harness({ stations: ["wlan0"] });
		h.watch.start();
		h.edge("wlan0", true);
		h.edge("wlan0", false);
		// No further line arrives before the hold expires.
		h.stations.length = 0;
		h.advance(CARRIER_LOSS_HOLD_MS);
		expect(h.marks).toEqual([]);
		h.watch.stop();
	});

	test("a marked station that turns into a hotspot loses its mark", () => {
		const h = harness({ stations: ["wlan0"] });
		h.watch.start();
		h.edge("wlan0", true);
		h.edge("wlan0", false);
		h.advance(CARRIER_LOSS_HOLD_MS);
		h.stations.length = 0;
		h.edge("wlan0", true);
		expect(h.marks).toEqual([
			["wlan0", true],
			["wlan0", false],
		]);
		h.watch.stop();
	});

	test("stopping clears every mark", () => {
		const h = harness();
		h.watch.start();
		for (const name of ["wlan0", "wlan1"]) {
			h.edge(name, true);
			h.edge(name, false);
		}
		h.advance(CARRIER_LOSS_HOLD_MS);
		expect([...h.lost].sort()).toEqual(["wlan0", "wlan1"]);
		h.watch.stop();
		expect(h.lost.size).toBe(0);
		expect(h.pending()).toEqual([]);
	});
});

describe("WifiCarrierWatch child lifetime", () => {
	test("reads lines across chunk boundaries from the child", async () => {
		const h = harness();
		h.watch.start();
		const child = h.children[0];
		if (!child) throw new Error("no child");
		h.carrier.set("wlan0", false);
		const down = `${linkLine("wlan0", NO_CARRIER, "DORMANT")}\n`;
		child.push(`${linkLine("wlan0", ASSOCIATED, "UP")}\n${down.slice(0, 20)}`);
		child.push(down.slice(20));
		await h.flush();
		h.advance(CARRIER_LOSS_HOLD_MS);
		expect(h.marks).toEqual([["wlan0", true]]);
		h.watch.stop();
	});

	test("lines a stopped child still had buffered arm nothing", async () => {
		const h = harness();
		h.watch.start();
		const child = h.children[0];
		if (!child) throw new Error("no child");
		h.watch.stop();
		h.carrier.set("wlan0", false);
		child.push(
			`${linkLine("wlan0", ASSOCIATED, "UP")}\n${linkLine("wlan0", NO_CARRIER, "DORMANT")}\n`,
		);
		await h.flush();
		expect(h.pending()).toEqual([]);
		h.advance(10_000);
		expect(h.marks).toEqual([]);
	});

	test("a reader that fails while the child lives is reaped and restarted", async () => {
		const h = harness();
		h.watch.start();
		const child = h.children[0];
		if (!child) throw new Error("no child");
		child.fail();
		await h.flush();
		expect(child.aborted()).toBe(true);
		expect(h.watch.running).toBe(false);
		h.advance(RESTART_MIN_MS);
		expect(h.spawned).toHaveLength(2);
		expect(h.watch.running).toBe(true);
		h.watch.stop();
	});

	test("a dead child clears its marks and restarts with a growing delay", async () => {
		const h = harness();
		h.watch.start();
		const first = h.children[0];
		if (!first) throw new Error("no child");
		h.carrier.set("wlan0", false);
		first.push(`${linkLine("wlan0", ASSOCIATED, "UP")}\n`);
		first.push(`${linkLine("wlan0", NO_CARRIER, "DORMANT")}\n`);
		await h.flush();
		h.advance(CARRIER_LOSS_HOLD_MS);
		expect(h.lost.has("wlan0")).toBe(true);
		first.end();
		await h.flush();
		expect(h.watch.running).toBe(false);
		expect(h.lost.has("wlan0")).toBe(false);
		h.advance(RESTART_MIN_MS);
		expect(h.spawned).toHaveLength(2);
		h.children[1]?.end();
		await h.flush();
		h.advance(RESTART_MIN_MS);
		expect(h.spawned).toHaveLength(2);
		h.advance(RESTART_MIN_MS);
		expect(h.spawned).toHaveLength(3);
		h.watch.stop();
	});

	test("a child that prints and dies does not reset the restart delay", async () => {
		const h = harness();
		h.watch.start();
		for (let k = 0; k < 4; k++) {
			const child = h.children[k];
			if (!child) throw new Error(`no child ${k}`);
			child.push(`${linkLine("wlan0", ASSOCIATED, "UP")}\n`);
			await h.flush();
			child.end();
			await h.flush();
			// 1 s, 2 s, 4 s, 8 s: output alone is no proof of health.
			h.advance(RESTART_MIN_MS * 2 ** k - 1);
			expect(h.spawned).toHaveLength(k + 1);
			h.advance(1);
			expect(h.spawned).toHaveLength(k + 2);
		}
		h.watch.stop();
	});

	test("a child that lived resets the restart delay", async () => {
		const h = harness();
		h.watch.start();
		h.children[0]?.end();
		await h.flush();
		h.advance(RESTART_MIN_MS);
		h.advance(HEALTHY_CHILD_MS);
		h.children[1]?.end();
		await h.flush();
		h.advance(RESTART_MIN_MS);
		expect(h.spawned).toHaveLength(3);
		h.watch.stop();
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

	test("sysfs that cannot be read never sets a mark", async () => {
		expect(await sysfsOperational("osb-no-such-netdev0")).toBe(true);
	});
});
