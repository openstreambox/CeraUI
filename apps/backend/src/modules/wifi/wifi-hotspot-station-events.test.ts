/*
  The nl80211 station events are a TRIGGER for the roster read, never data.

  The parser runs against the exact line shape `iw event` prints (format strings
  `%s (phy #%d): ` and `new station %s` / `del station %s`), with and without the
  `-t` timestamp, and must ignore every other event on the same stream. The
  watcher half drives a fake child: it reads the AP interface's roster at once
  and twice more after a `new station` (the WPA handshake finishes without a
  further event), ignores a station leg's own events, and restarts a dead child
  with a growing delay only while a hotspot is up.
*/

import { describe, expect, test } from "bun:test";

import type {
	ManagedProcess,
	WatcherHandle,
} from "../../helpers/spawn-policy.ts";
import {
	type HotspotStationEventDeps,
	HotspotStationEvents,
	JOIN_FOLLOW_UP_MS,
	parseIwStationEvent,
	RESTART_MAX_MS,
	RESTART_MIN_MS,
} from "./wifi-hotspot-station-events.ts";

describe("parseIwStationEvent", () => {
	test("reads a new and a del station line", () => {
		expect(
			parseIwStationEvent("clap-wlan0 (phy #1): new station 8C:85:90:1A:2B:3C"),
		).toEqual({ ifname: "clap-wlan0", kind: "new", mac: "8c:85:90:1a:2b:3c" });
		expect(
			parseIwStationEvent("wlan0 (phy #0): del station 3c:22:fb:0e:91:7d\n"),
		).toEqual({ ifname: "wlan0", kind: "del", mac: "3c:22:fb:0e:91:7d" });
	});

	test("accepts the -t timestamp prefix", () => {
		expect(
			parseIwStationEvent(
				"1755823102.841234: wlan1 (phy #2): new station aa:bb:cc:dd:ee:ff",
			),
		).toEqual({ ifname: "wlan1", kind: "new", mac: "aa:bb:cc:dd:ee:ff" });
	});

	test("ignores every other event and any drifted shape", () => {
		for (const line of [
			"",
			"wlan0 (phy #0): scan started",
			"wlan0 (phy #0): connected to 11:22:33:44:55:66",
			"wlan0 (phy #0): new station <unknown>",
			"wlan0 (phy #0): new station aa:bb:cc:dd:ee",
			"wlan0: new station aa:bb:cc:dd:ee:ff",
			"phy #0: reg_change",
			"wlan0 (phy #0): new station aa:bb:cc:dd:ee:ff trailing",
		]) {
			expect(parseIwStationEvent(line)).toBeUndefined();
		}
	});
});

type Scheduled = { callback: () => void; ms: number; cleared: boolean };

function harness(apIfnames: readonly string[] = ["wlan0"]) {
	const scheduled: Scheduled[] = [];
	const reads: string[][] = [];
	const spawned: string[][] = [];
	const children: Array<{
		push: (text: string) => void;
		end: () => void;
		aborted: () => boolean;
	}> = [];

	const deps: HotspotStationEventDeps = {
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
		iwPath: () => "/usr/sbin/iw",
		apIfnames: () => apIfnames,
		refresh: async (ifnames) => {
			reads.push([...ifnames]);
		},
		setTimeout: (callback, ms) => {
			scheduled.push({ callback, ms, cleared: false });
			return scheduled.length - 1;
		},
		clearTimeout: (timer) => {
			const entry = scheduled[timer as number];
			if (entry) entry.cleared = true;
		},
	};
	const runDue = () => {
		for (const entry of scheduled.splice(0)) {
			if (!entry.cleared) entry.callback();
		}
	};
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
	return { deps, scheduled, reads, spawned, children, runDue, flush };
}

describe("HotspotStationEvents", () => {
	test("spawns `iw event` only once a hotspot is up, and stops with it", async () => {
		const h = harness();
		const watcher = new HotspotStationEvents(h.deps);
		watcher.sync(false);
		expect(h.spawned).toEqual([]);
		watcher.sync(true);
		watcher.sync(true);
		expect(h.spawned).toEqual([["/usr/sbin/iw", "event"]]);
		expect(watcher.running).toBe(true);
		watcher.sync(false);
		expect(h.children[0]?.aborted()).toBe(true);
		expect(watcher.running).toBe(false);
		await h.flush();
		// A deliberate stop is not a crash: nothing is restarted.
		expect(h.scheduled).toEqual([]);
	});

	test("a new station reads the AP's roster now and twice more", async () => {
		const h = harness(["clap-wlan0"]);
		const watcher = new HotspotStationEvents(h.deps);
		watcher.sync(true);
		h.children[0]?.push("clap-wlan0 (phy #0): new sta");
		h.children[0]?.push("tion 8c:85:90:1a:2b:3c\n");
		await h.flush();
		expect(h.scheduled.map((s) => s.ms)).toEqual([...JOIN_FOLLOW_UP_MS]);
		h.runDue();
		expect(h.reads).toEqual([["clap-wlan0"], ["clap-wlan0"], ["clap-wlan0"]]);
		watcher.stop();
	});

	test("a del station reads once", () => {
		const h = harness();
		const watcher = new HotspotStationEvents(h.deps);
		watcher.sync(true);
		watcher.handleLine("wlan0 (phy #0): del station 8c:85:90:1a:2b:3c");
		expect(h.scheduled.map((s) => s.ms)).toEqual([0]);
		watcher.stop();
	});

	test("events on a station leg or another interface read nothing", () => {
		const h = harness(["clap-wlan0"]);
		const watcher = new HotspotStationEvents(h.deps);
		watcher.sync(true);
		watcher.handleLine("wlan0 (phy #0): new station 11:22:33:44:55:66");
		watcher.handleLine("wlan1 (phy #1): new station 11:22:33:44:55:66");
		expect(h.scheduled).toEqual([]);
		watcher.stop();
	});

	test("a follow-up after its AP stopped reads nothing", () => {
		const aps = ["wlan0"];
		const h = harness(aps);
		const watcher = new HotspotStationEvents(h.deps);
		watcher.sync(true);
		watcher.handleLine("wlan0 (phy #0): new station 8c:85:90:1a:2b:3c");
		// The AP went down before its follow-ups fired; the interface is a
		// station leg now.
		aps.length = 0;
		h.runDue();
		expect(h.reads).toEqual([]);
		watcher.stop();
	});

	test("a second join on the same AP replaces the pending follow-ups", () => {
		const h = harness();
		const watcher = new HotspotStationEvents(h.deps);
		watcher.sync(true);
		watcher.handleLine("wlan0 (phy #0): new station aa:bb:cc:dd:ee:01");
		watcher.handleLine("wlan0 (phy #0): new station aa:bb:cc:dd:ee:02");
		const live = h.scheduled.filter((s) => !s.cleared);
		expect(live.map((s) => s.ms)).toEqual([...JOIN_FOLLOW_UP_MS]);
		watcher.stop();
		expect(h.scheduled.every((s) => s.cleared)).toBe(true);
	});

	test("a child that dies is restarted with a doubling, capped delay", async () => {
		const h = harness();
		const watcher = new HotspotStationEvents(h.deps);
		watcher.sync(true);
		const delays: number[] = [];
		for (let i = 0; i < 9; i++) {
			h.children[i]?.end();
			await h.flush();
			await h.flush();
			const restart = h.scheduled.at(-1);
			if (!restart) throw new Error("no restart scheduled");
			delays.push(restart.ms);
			h.runDue();
		}
		expect(delays[0]).toBe(RESTART_MIN_MS);
		expect(delays[1]).toBe(RESTART_MIN_MS * 2);
		expect(Math.max(...delays)).toBe(RESTART_MAX_MS);
		expect(h.spawned).toHaveLength(10);
		watcher.stop();
	});

	test("a spawn that throws schedules a restart instead of crashing", () => {
		const h = harness();
		const watcher = new HotspotStationEvents({
			...h.deps,
			spawn: () => {
				throw new Error("ENOENT");
			},
		});
		watcher.sync(true);
		expect(watcher.running).toBe(false);
		expect(h.scheduled.map((s) => s.ms)).toEqual([RESTART_MIN_MS]);
		watcher.stop();
		expect(h.scheduled[0]?.cleared).toBe(true);
	});
});
