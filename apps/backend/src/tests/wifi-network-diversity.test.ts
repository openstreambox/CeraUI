/*
  Two radios on two networks must stay on two networks, and the check that
  keeps them there must never cost a working link for nothing.

  Board-observed with two USB radios bonded over two access points: each radio
  held a saved profile for both networks. When network 1 went away,
  NetworkManager autoconnected that radio to its saved profile for network 2,
  where the other radio already was, and never moved it back after network 1
  returned. Losing network 2's uplink then took the whole stream down.

  The world below is a fake NetworkManager: device links, per-radio scans,
  profile priorities and MAC bindings. The review scenarios (stale merged
  visibility, phantom duplicates from monitor events, a stale multi-move plan,
  flapping, operator races, memory overwrite, unbound profiles, scan budget)
  are each pinned as an assertion.
*/

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as nm from "../modules/network/network-manager.ts";
import type { MessageSocket } from "../modules/ui/message-socket.ts";
import * as websocket from "../modules/ui/websocket-server.ts";
import { handleWifi, setWifiJoinNmcliRunner } from "../modules/wifi/wifi.ts";
import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
	handleWifiMonitorEvent,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import {
	getWifiIdToMacAddress,
	type WifiInterface,
} from "../modules/wifi/wifi-interfaces.ts";
import {
	type DiversityProfile,
	type DiversityRadio,
	diversityRadioOf,
	parseDiversityLinks,
	WIFI_CHOSEN_NETWORK_PRIORITY,
	WIFI_DIVERSITY,
	WIFI_DIVERSITY_TICK_MS,
	WifiNetworkDiversity,
} from "../modules/wifi/wifi-network-diversity.ts";

const A = "02:00:00:00:a0:01";
const B = "02:00:00:00:b0:02";
const N1 = "Lab-Net-1";
const N2 = "Lab-Net-2";
const N3 = "Lab-Net-3";
// Each radio holds its own profile for each network (MAC-bound).
const A1 = "00000000-0000-4000-8000-0000000000a1";
const A2 = "00000000-0000-4000-8000-0000000000a2";
const A3 = "00000000-0000-4000-8000-0000000000a3";
const B1 = "00000000-0000-4000-8000-0000000000b1";
const B2 = "00000000-0000-4000-8000-0000000000b2";
const B3 = "00000000-0000-4000-8000-0000000000b3";
const U = "00000000-0000-4000-8000-0000000000ff";
const MARK = WIFI_CHOSEN_NETWORK_PRIORITY;
const MIN = 60_000;

const SSID_OF: Record<string, string> = {
	[A1]: N1,
	[A2]: N2,
	[A3]: N3,
	[B1]: N1,
	[B2]: N2,
	[B3]: N3,
	[U]: N1,
};

function radio(key: string, ifname: string, uuids: string[]): DiversityRadio {
	const savedAll: Record<string, string[]> = {};
	for (const uuid of uuids) {
		const ssid = SSID_OF[uuid] as string;
		savedAll[ssid] = [...(savedAll[ssid] ?? []), uuid];
	}
	return { key, ifname, savedAll };
}

/* A fake NetworkManager with two radios on ifnames wlA and wlB. */
class World {
	clock = 0;
	links = new Map<string, string | null>([
		["wlA", null],
		["wlB", null],
	]);
	profiles = new Map<string, DiversityProfile>();
	/** What each radio's own scan sees: SSID -> signal. */
	air: Record<string, Record<string, number>> = { wlA: {}, wlB: {} };
	log: string[] = [];
	busyLock = false;
	activateOk = true;
	locks = 0;
	/** SSIDs in the merged scan list (a hint only). */
	merged = new Set<string>();
	/** Runs after each scan returns, to change the world mid-decision. */
	afterScan: (ifname: string, count: number) => void = () => {};
	/** Runs once the lock is taken, before the decision inside it. */
	inLock: () => void = () => {};
	diversity: WifiNetworkDiversity;

	constructor(
		readonly radios: () => DiversityRadio[] = () => [
			radio(A, "wlA", [A1, A2, A3]),
			radio(B, "wlB", [B1, B2, B3]),
		],
	) {
		for (const uuid of [A1, A2, A3]) {
			this.profiles.set(uuid, { priority: 0, mac: A });
		}
		for (const uuid of [B1, B2, B3]) {
			this.profiles.set(uuid, { priority: 0, mac: B });
		}
		this.diversity = new WifiNetworkDiversity({
			radios: () => this.radios(),
			readLinks: async () => new Map(this.links),
			readProfile: async (uuid) => this.profiles.get(uuid),
			setPriority: async (uuid, priority) => {
				this.log.push(`priority ${uuid} ${priority}`);
				const old = this.profiles.get(uuid);
				if (old) this.profiles.set(uuid, { ...old, priority });
				return true;
			},
			scan: async (ifname) => {
				this.log.push(`scan ${ifname}`);
				const seen = new Map(Object.entries(this.air[ifname] ?? {}));
				this.afterScan(ifname, this.scans(ifname).length);
				return seen;
			},
			activate: async (uuid, ifname) => {
				this.log.push(`activate ${uuid} ${ifname}`);
				if (!this.activateOk) return false;
				this.links.set(ifname, uuid);
				return true;
			},
			withLock: async (_key, fn) => {
				this.locks += 1;
				if (this.busyLock) return false;
				// Acquire a microtask later, like a real lock that was just freed.
				await Promise.resolve();
				this.inLock();
				await fn();
				return true;
			},
			now: () => this.clock,
			listed: () => this.merged,
		});
	}

	mark(...uuids: string[]) {
		for (const uuid of uuids) {
			const old = this.profiles.get(uuid);
			if (old) this.profiles.set(uuid, { ...old, priority: MARK });
		}
	}

	/** Both radios' own scans see these networks. */
	onAir(signals: Record<string, number>) {
		this.air = { wlA: { ...signals }, wlB: { ...signals } };
	}

	async run(ms: number) {
		const end = this.clock + ms;
		while (this.clock < end) {
			this.clock += WIFI_DIVERSITY_TICK_MS;
			await this.diversity.tick();
		}
	}

	activations() {
		return this.log.filter((line) => line.startsWith("activate"));
	}

	scans(ifname?: string) {
		return this.log.filter((line) =>
			ifname ? line === `scan ${ifname}` : line.startsWith("scan"),
		);
	}

	actionsOnly() {
		return this.log.filter((line) => !line.startsWith("priority"));
	}
}

/* Both radios settled on their own networks, then AP1 lost: A falls back. */
async function fallenBack(w: World) {
	w.mark(A1, B2);
	w.onAir({ [N1]: 70, [N2]: 70 });
	w.links.set("wlA", A1);
	w.links.set("wlB", B2);
	await w.run(MIN);
	w.onAir({ [N2]: 70 });
	w.links.set("wlA", A2);
}

describe("moving a radio back", () => {
	test("waits while its network is gone, returns once its own scans see it", async () => {
		const w = new World();
		await fallenBack(w);

		// AP1 stays off for 10 minutes: the fallback link is never touched.
		await w.run(10 * MIN);
		expect(w.activations()).toEqual([]);
		expect(w.scans("wlB")).toEqual([]);

		// AP1 is back: one move, on the right radio, with its ifname.
		w.onAir({ [N1]: 70, [N2]: 70 });
		await w.run(20 * MIN);
		expect(w.activations()).toEqual([`activate ${A1} wlA`]);
		expect(w.links.get("wlA")).toBe(A1);
		expect(w.links.get("wlB")).toBe(B2);
	});

	test("returns within about a minute and a half when its network is back early", async () => {
		const w = new World();
		await fallenBack(w);
		w.onAir({ [N1]: 70, [N2]: 70 });
		const start = w.clock;
		while (w.activations().length === 0 && w.clock - start < 10 * MIN) {
			await w.run(WIFI_DIVERSITY_TICK_MS);
		}
		// Two confirm ticks and 30 s settle, then two sightings 20 s apart.
		expect(w.activations()).toHaveLength(1);
		expect(w.clock - start).toBeLessThanOrEqual(90_000);
	});

	test("review P1-1: a sibling's stale view of the network is never trusted", async () => {
		const w = new World();
		await fallenBack(w);
		// B (connected, rarely scanning) still lists N1; A's own scans do not.
		w.air.wlB = { [N1]: 70, [N2]: 70 };
		await w.run(15 * MIN);
		expect(w.activations()).toEqual([]);
		expect(w.scans("wlB")).toEqual([]);
	});

	test("review P1-1: one sighting is not enough", async () => {
		const w = new World();
		await fallenBack(w);
		await w.run(MIN); // confirm, settle; the first scan finds nothing
		// N1 shows up in exactly one of A's scans, then is gone again.
		w.air.wlA = { [N1]: 70, [N2]: 70 };
		const scans = w.scans("wlA").length;
		while (w.scans("wlA").length === scans) {
			await w.run(WIFI_DIVERSITY_TICK_MS);
		}
		w.air.wlA = { [N2]: 70 };
		await w.run(10 * MIN);
		expect(w.activations()).toEqual([]);
	});

	test("needs a usable signal, not much weaker than the shared link", async () => {
		const weak = new World();
		await fallenBack(weak);
		weak.onAir({ [N1]: WIFI_DIVERSITY.signalFloor - 1, [N2]: 50 });
		await weak.run(10 * MIN);
		expect(weak.activations()).toEqual([]);

		const worse = new World();
		await fallenBack(worse);
		worse.onAir({ [N1]: 55, [N2]: 55 + WIFI_DIVERSITY.signalMargin + 1 });
		await worse.run(10 * MIN);
		expect(worse.activations()).toEqual([]);
	});

	test("a failed move restores the fallback link and backs off", async () => {
		const w = new World();
		await fallenBack(w);
		w.onAir({ [N1]: 70, [N2]: 70 });
		w.activateOk = false;
		while (w.activations().length === 0) {
			await w.run(WIFI_DIVERSITY_TICK_MS);
		}
		expect(w.activations()).toEqual([
			`activate ${A1} wlA`,
			`activate ${A2} wlA`,
		]);
		await w.run(WIFI_DIVERSITY.moveBackoffMs - WIFI_DIVERSITY_TICK_MS);
		expect(w.activations()).toHaveLength(2);
	});
});

describe("never a move that gains nothing", () => {
	test("review P1-2: monitor events cannot invent a duplicate", async () => {
		// The registry's `conn` is patched from monitor events by connection
		// NAME across radios; the check must read NetworkManager's device table.
		const spies = [
			spyOn(websocket, "broadcastMsg").mockImplementation(() => {}),
		];
		const avail = () =>
			new Map([
				[N1, { active: false, ssid: N1, signal: 60, security: "", freq: 1 }],
				[N2, { active: false, ssid: N2, signal: 60, security: "", freq: 1 }],
			]);
		const row = (
			id: number,
			ifname: string,
			conn: string,
			one: string,
			two: string,
		): WifiInterface => ({
			id,
			ifname,
			conn,
			hw: "Fixture",
			available: avail(),
			saved: { [N1]: one, [N2]: two },
			savedAll: { [N1]: [one], [N2]: [two] },
		});
		addWifiInterface(A, row(0, "wlA", A1, A1, A2));
		addWifiInterface(B, row(1, "wlB", B2, B1, B2));
		try {
			const live = () => {
				const out: DiversityRadio[] = [];
				const all = getWifiInterfacesByMacAddress();
				for (const mac in all) {
					const entry = all[mac];
					const r = entry && diversityRadioOf(mac, entry);
					if (r) out.push(r);
				}
				return out;
			};
			const w = new World(live);
			w.mark(A1, B2);
			w.onAir({ [N1]: 70, [N2]: 70 });
			w.links.set("wlA", A1);
			w.links.set("wlB", B2);
			await w.run(MIN);
			// A's own move-back emits these when profile names equal SSIDs.
			handleWifiMonitorEvent({
				type: "connection-state",
				connection: N2,
				state: "deactivated",
			});
			handleWifiMonitorEvent({
				type: "connection-state",
				connection: N1,
				state: "activated",
			});
			// The registry now claims B is on N1 next to A: a phantom duplicate.
			expect(getWifiInterfacesByMacAddress()[B]?.conn).toBe(B1);
			await w.run(5 * MIN);
			expect(w.actionsOnly()).toEqual([]);
		} finally {
			for (const spy of spies) spy.mockRestore();
			removeWifiInterface(A);
			removeWifiInterface(B);
		}
	});

	test("review P1-3: one move per tick, and no second move once diversity is back", async () => {
		const w = new World();
		w.mark(A1, B3);
		w.onAir({ [N1]: 70, [N2]: 70, [N3]: 70 });
		w.links.set("wlA", A2);
		w.links.set("wlB", B2);
		await w.run(20 * MIN);
		expect(w.activations()).toEqual([`activate ${A1} wlA`]);
		expect(w.links.get("wlB")).toBe(B2);
	});

	test("never activates a profile that is already active", async () => {
		const w = new World(() => [
			radio(A, "wlA", [A1, A2]),
			radio(B, "wlB", [A1, B2]), // an odd setup: B lists A's profile too
		]);
		w.mark(A1);
		w.onAir({ [N1]: 70, [N2]: 70 });
		w.links.set("wlA", A2);
		w.links.set("wlB", A1);
		await w.run(10 * MIN);
		expect(w.activations()).toEqual([]);
	});

	test("waits for a fresh link change to settle", async () => {
		const w = new World();
		await fallenBack(w);
		w.onAir({ [N1]: 70, [N2]: 70 });
		await w.run(WIFI_DIVERSITY.settleMs - WIFI_DIVERSITY_TICK_MS);
		expect(w.actionsOnly()).toEqual([]);
	});

	test("a busy adapter lock skips the turn", async () => {
		const w = new World();
		await fallenBack(w);
		w.onAir({ [N1]: 70, [N2]: 70 });
		w.busyLock = true;
		await w.run(10 * MIN);
		expect(w.actionsOnly()).toEqual([]);
		w.busyLock = false;
		await w.run(2 * MIN);
		expect(w.activations()).toEqual([`activate ${A1} wlA`]);
	});
});

describe("hysteresis", () => {
	test("review P2-1: a preferred network that keeps dropping parks the radio", async () => {
		const w = new World();
		await fallenBack(w);
		w.onAir({ [N1]: 70, [N2]: 70 });
		let moves = 0;
		for (let i = 0; i < 6 * 60; i++) {
			await w.run(WIFI_DIVERSITY_TICK_MS);
			// NM drops A from the weak AP1 within a tick and falls back.
			if (w.links.get("wlA") === A1) {
				moves += 1;
				w.links.set("wlA", A2);
			}
		}
		// One hour: three quick reverts, then parked (the signal never improves).
		expect(moves).toBe(WIFI_DIVERSITY.parkAfterReverts);
	});

	test("a parked radio moves again when the signal is clearly stronger", async () => {
		const w = new World();
		await fallenBack(w);
		w.onAir({ [N1]: 50, [N2]: 50 });
		for (let i = 0; i < 6 * 30; i++) {
			await w.run(WIFI_DIVERSITY_TICK_MS);
			if (w.links.get("wlA") === A1) w.links.set("wlA", A2);
		}
		const before = w.activations().length;
		expect(before).toBe(WIFI_DIVERSITY.parkAfterReverts);
		w.onAir({ [N1]: 50 + WIFI_DIVERSITY.parkSignalGain, [N2]: 50 });
		await w.run(40 * MIN);
		expect(w.activations()).toHaveLength(before + 1);
		expect(w.links.get("wlA")).toBe(A1);
	});

	test("a move that holds clears the revert count", async () => {
		const w = new World();
		await fallenBack(w);
		w.onAir({ [N1]: 70, [N2]: 70 });
		for (let reverts = 0; reverts < 2; ) {
			await w.run(WIFI_DIVERSITY_TICK_MS);
			if (w.links.get("wlA") === A1) {
				w.links.set("wlA", A2);
				reverts += 1;
			}
		}
		// Then a move that holds past the hold time, and a later fallback.
		while (w.links.get("wlA") !== A1) await w.run(WIFI_DIVERSITY_TICK_MS);
		await w.run(WIFI_DIVERSITY.holdMs + WIFI_DIVERSITY_TICK_MS);
		w.links.set("wlA", A2);
		const before = w.activations().length;
		await w.run(2 * MIN);
		// No back-off left: it returns within the normal confirm time.
		expect(w.activations()).toHaveLength(before + 1);
	});

	test("review P2-4: forced scans are budgeted while the network is absent", async () => {
		const w = new World();
		await fallenBack(w);
		await w.run(60 * MIN);
		// Three fast scans, then one per slow interval.
		expect(w.scans("wlA").length).toBeLessThanOrEqual(
			WIFI_DIVERSITY.scanDelaysMs.length +
				1 +
				Math.ceil((60 * MIN) / WIFI_DIVERSITY.scanSlowMs),
		);
		expect(w.scans("wlB")).toEqual([]);
	});
});

describe("operator intent", () => {
	test("review P2-2: an operator op in flight is never raced", async () => {
		const w = new World();
		await fallenBack(w);
		w.onAir({ [N1]: 70, [N2]: 70 });
		const release = w.diversity.beginOperatorChoice(A);
		await w.run(10 * MIN);
		expect(w.actionsOnly()).toEqual([]);
		// The operator deliberately put A on N2 next to B.
		await w.diversity.recordChoice(A, A2);
		release();
		await w.run(10 * MIN);
		expect(w.activations()).toEqual([]);
		expect(w.profiles.get(A2)?.priority).toBe(MARK);
		expect(w.profiles.get(A1)?.priority).toBe(0);
	});

	test("both radios chosen for one network stay there", async () => {
		const w = new World();
		w.mark(A2, B2);
		w.onAir({ [N1]: 70, [N2]: 70 });
		w.links.set("wlA", A2);
		w.links.set("wlB", B2);
		await w.run(20 * MIN);
		expect(w.activations()).toEqual([]);
	});

	test("review P2-3: an unmarked radio is not moved on a remembered network", async () => {
		const w = new World();
		w.onAir({ [N1]: 70, [N2]: 70 });
		// Past the migration window, so nothing gets marked.
		await w.run(WIFI_DIVERSITY.migrationWindowMs + MIN);
		w.links.set("wlA", A1);
		w.links.set("wlB", B2);
		await w.run(5 * MIN);
		w.links.set("wlA", A2);
		w.links.set("wlB", null); // sibling blip
		await w.run(WIFI_DIVERSITY_TICK_MS);
		w.links.set("wlB", B2);
		await w.run(20 * MIN);
		expect(w.log).toEqual([]);
	});

	test("an upgraded box marks each radio's own network once, early and when stable", async () => {
		const w = new World();
		w.onAir({ [N1]: 70, [N2]: 70 });
		w.links.set("wlA", A1);
		w.links.set("wlB", B2);
		await w.run(WIFI_DIVERSITY.migrationStableMs - WIFI_DIVERSITY_TICK_MS);
		expect(w.log).toEqual([]);
		await w.run(2 * WIFI_DIVERSITY_TICK_MS);
		expect([...w.log].sort()).toEqual([
			`priority ${A1} ${MARK}`,
			`priority ${B2} ${MARK}`,
		]);
		// Later the fallback happens and the marks bring A back.
		w.onAir({ [N2]: 70 });
		w.links.set("wlA", A2);
		await w.run(5 * MIN);
		// Back after the fast scans are spent: the next slow scan finds it.
		w.onAir({ [N1]: 70, [N2]: 70 });
		await w.run(WIFI_DIVERSITY.scanSlowMs + MIN);
		expect(w.activations()).toEqual([`activate ${A1} wlA`]);
	});

	test("no migration when the radios share a network or a mark exists", async () => {
		const shared = new World();
		shared.links.set("wlA", A2);
		shared.links.set("wlB", B2);
		await shared.run(WIFI_DIVERSITY.migrationWindowMs + MIN);
		expect(shared.log).toEqual([]);

		const marked = new World();
		marked.mark(B3);
		marked.links.set("wlA", A1);
		marked.links.set("wlB", B2);
		await marked.run(WIFI_DIVERSITY.migrationWindowMs + MIN);
		expect(marked.log).toEqual([]);
	});

	test("review P2-5: a choice of an unbound profile marks nothing, for anyone", async () => {
		const w = new World(() => [
			radio(A, "wlA", [U, A2]),
			radio(B, "wlB", [U, B2]),
		]);
		w.profiles.set(U, { priority: 0, mac: undefined });
		w.mark(B2);
		await w.diversity.recordChoice(A, U);
		expect(w.log).toEqual([]);
		expect(w.profiles.get(B2)?.priority).toBe(MARK);
		// An unbound profile is never a move target either.
		w.mark(U);
		w.onAir({ [N1]: 70, [N2]: 70 });
		w.links.set("wlA", A2);
		w.links.set("wlB", B2);
		await w.run(10 * MIN);
		expect(w.activations()).toEqual([]);
	});

	test("quick successive choices end with exactly one mark", async () => {
		const w = new World();
		w.mark(A1);
		await Promise.all([
			w.diversity.recordChoice(A, A2),
			w.diversity.recordChoice(A, A3),
		]);
		const marked = [A1, A2, A3].filter(
			(uuid) => w.profiles.get(uuid)?.priority === MARK,
		);
		expect(marked).toEqual([A3]);
	});
});

describe("re-check fixes", () => {
	test("R1: choosing an unbound legacy profile clears the old mark, so the choice stands", async () => {
		const w = new World(() => [
			radio(A, "wlA", [A2, U]),
			radio(B, "wlB", [B1, B2]),
		]);
		w.profiles.set(U, { priority: 0, mac: undefined });
		w.mark(A2, B1);
		w.onAir({ [N1]: 70, [N2]: 70 });
		w.links.set("wlA", A2);
		w.links.set("wlB", B1);
		await w.run(MIN);
		// The operator deliberately puts A on N1, next to B, via the legacy profile.
		const release = w.diversity.beginOperatorChoice(A);
		w.links.set("wlA", U);
		await w.diversity.recordChoice(A, U);
		release();
		expect(w.profiles.get(A2)?.priority).toBe(0);
		expect(w.profiles.get(U)?.priority).toBe(0);
		await w.run(10 * MIN);
		expect(w.activations()).toEqual([]);
		expect(w.links.get("wlA")).toBe(U);
	});

	test("R2: an operator op that starts while the lock is being taken wins", async () => {
		const w = new World();
		await fallenBack(w);
		w.onAir({ [N1]: 70, [N2]: 70 });
		let release: (() => void) | undefined;
		w.inLock = () => {
			release ??= w.diversity.beginOperatorChoice(A);
		};
		w.log.length = 0;
		await w.run(5 * MIN);
		expect(w.log).toEqual([]);
		release?.();
	});

	test("R2: the sibling taking the target during the confirming scan stops the move", async () => {
		const w = new World();
		await fallenBack(w);
		w.onAir({ [N1]: 70, [N2]: 70 });
		w.afterScan = (ifname, count) => {
			if (ifname === "wlA" && count === 2) w.links.set("wlB", B1);
		};
		await w.run(5 * MIN);
		expect(w.activations()).toEqual([]);
		expect(w.links.get("wlA")).toBe(A2);
	});

	test("a sibling blip does not reset the scan budget", async () => {
		const w = new World();
		await fallenBack(w);
		w.log.length = 0;
		for (let i = 0; i < 6; i++) {
			await w.run(5 * MIN);
			w.links.set("wlB", null);
			await w.run(WIFI_DIVERSITY_TICK_MS);
			w.links.set("wlB", B2);
		}
		// About 31 minutes: the fast scans once, then the slow cadence.
		expect(w.scans("wlA").length).toBeLessThanOrEqual(
			WIFI_DIVERSITY.scanDelaysMs.length +
				1 +
				Math.ceil((31 * MIN) / WIFI_DIVERSITY.scanSlowMs),
		);
	});

	test("a parked radio is unparked when NetworkManager's own recovery holds", async () => {
		const w = new World();
		await fallenBack(w);
		w.onAir({ [N1]: 50, [N2]: 50 });
		for (let i = 0; i < 400; i++) {
			await w.run(WIFI_DIVERSITY_TICK_MS);
			if (w.links.get("wlA") === A1) w.links.set("wlA", A2);
		}
		const before = w.activations().length;
		expect(before).toBe(WIFI_DIVERSITY.parkAfterReverts);
		// NM puts A back on N1 itself, and it holds.
		w.links.set("wlA", A1);
		await w.run(60 * MIN);
		// A new fallback at the same signal: the radio is no longer parked.
		w.links.set("wlA", A2);
		await w.run(60 * MIN);
		expect(w.activations().length).toBe(before + 1);
	});

	test("the lock is not taken while no scan is due", async () => {
		const w = new World();
		await fallenBack(w);
		w.locks = 0;
		await w.run(30 * MIN);
		expect(w.locks).toBe(w.scans("wlA").length);
	});

	test("a network newly listed in the merged scan earns one early scan, never a move", async () => {
		const w = new World();
		await fallenBack(w);
		// Spend the fast scans; the next one is the slow cadence away.
		await w.run(5 * MIN);
		const spent = w.scans("wlA").length;
		w.merged = new Set([N1, N2]);
		await w.run(MIN);
		expect(w.scans("wlA").length).toBe(spent + 1);
		expect(w.activations()).toEqual([]);
		// Still listed: no further early scans.
		await w.run(3 * MIN);
		expect(w.scans("wlA").length).toBe(spent + 1);
	});

	test("the merged list speeds up the return once the network is really back", async () => {
		const w = new World();
		await fallenBack(w);
		await w.run(5 * MIN);
		w.onAir({ [N1]: 70, [N2]: 70 });
		w.merged = new Set([N1, N2]);
		const back = w.clock;
		while (w.links.get("wlA") !== A1 && w.clock - back < 20 * MIN) {
			await w.run(WIFI_DIVERSITY_TICK_MS);
		}
		// One early scan, then the confirming one 20 s later.
		expect(w.clock - back).toBeLessThanOrEqual(MIN);
	});
});

describe("wiring", () => {
	function iface(overrides: Partial<WifiInterface> = {}): WifiInterface {
		return {
			id: 3,
			ifname: "wlx0",
			conn: A2,
			hw: "Fixture",
			available: new Map(),
			saved: { [N1]: A1, [N2]: A2 },
			savedAll: { [N1]: [A1], [N2]: [A2] },
			...overrides,
		};
	}

	test("a station radio is projected by key and ifname", () => {
		expect(diversityRadioOf(A, iface())).toEqual({
			key: A,
			ifname: "wlx0",
			savedAll: { [N1]: [A1], [N2]: [A2] },
		});
	});

	test("radios running a hotspot, alone or concurrently, are exempt", () => {
		expect(
			diversityRadioOf(
				A,
				iface({
					activeMode: "ap",
					hotspot: { conn: "hs" },
				} as unknown as Partial<WifiInterface>),
			),
		).toBeUndefined();
		expect(
			diversityRadioOf(
				A,
				iface({
					hotspot: { conn: "hs" },
					concurrentHotspot: { ifname: "clap-wlx0", activeConn: "hs" },
				} as unknown as Partial<WifiInterface>),
			),
		).toBeUndefined();
	});

	test("device links come from NetworkManager's device table", () => {
		const links = parseDiversityLinks([
			`wlA:wifi:connected:${A1}`,
			"wlB:wifi:disconnected:",
			"wlC:wifi:connecting (getting IP configuration):x",
			`eth0:ethernet:connected:${B1}`,
			"",
		]);
		expect([...links]).toEqual([
			["wlA", A1],
			["wlB", null],
			["wlC", null],
		]);
	});
});

describe("join and connect record the operator's choice", () => {
	const spies: Array<{ mockRestore(): void }> = [];
	const writes: Array<[string, Record<string, string>]> = [];
	let replied: Promise<void> = Promise.resolve();
	let socket: MessageSocket;
	// The choice is recorded after the reply; let its reads and writes settle.
	const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

	beforeEach(() => {
		writes.length = 0;
		const reply = Promise.withResolvers<void>();
		replied = reply.promise;
		socket = { send: () => reply.resolve() } as unknown as MessageSocket;
		const priorities: Record<string, string> = {
			[A1]: String(MARK),
			[A2]: "0",
		};
		addWifiInterface(A, {
			id: 7,
			ifname: "wlx7",
			conn: A1,
			hw: "Fixture",
			available: new Map(),
			saved: { [N1]: A1, [N2]: A2 },
			savedAll: { [N1]: [A1], [N2]: [A2] },
		});
		getWifiIdToMacAddress()[7] = A;
		spies.push(
			spyOn(nm, "nmConnect").mockResolvedValue(true),
			spyOn(nm, "nmScanResults").mockResolvedValue([""]),
			spyOn(nm, "nmConnGetFields").mockImplementation((async (
				uuid: string,
				fields: readonly string[],
			) =>
				fields.includes("802-11-wireless.ssid")
					? ["infrastructure", uuid === A1 ? N1 : N2, A]
					: [
							priorities[uuid] ?? "0",
							A.toUpperCase(),
						]) as unknown as typeof nm.nmConnGetFields),
			spyOn(nm, "nmConnsGet").mockResolvedValue([
				`${A1}:802-11-wireless`,
				`${A2}:802-11-wireless`,
			]),
			spyOn(nm, "nmConnSetWifiMacAddress").mockResolvedValue(true),
			spyOn(nm, "nmConnSetFields").mockImplementation(async (uuid, fields) => {
				writes.push([uuid, fields]);
				priorities[uuid] = fields["connection.autoconnect-priority"] ?? "0";
				return true;
			}),
			spyOn(websocket, "broadcastMsg").mockImplementation(() => {}),
		);
	});

	afterEach(() => {
		setWifiJoinNmcliRunner(null);
		for (const spy of spies.splice(0)) spy.mockRestore();
		removeWifiInterface(A);
		delete getWifiIdToMacAddress()[7];
	});

	test("a connect from the UI moves the mark to that network", async () => {
		handleWifi(socket, { connect: A2 });
		await replied;
		await settle();
		expect(writes).toContainEqual([
			A2,
			{ "connection.autoconnect-priority": String(MARK) },
		]);
		expect(writes).toContainEqual([
			A1,
			{ "connection.autoconnect-priority": "0" },
		]);
	});

	test("a join from the UI moves the mark to the joined network", async () => {
		setWifiJoinNmcliRunner(async () => ({
			stdout: `Device 'wlx7' successfully activated with '${A2}'.`,
			stderr: "",
			exitCode: 0,
		}));
		handleWifi(socket, {
			new: { device: 7, ssid: N2, password: "fixture-pass", security: "" },
		});
		await replied;
		await settle();
		expect(writes).toContainEqual([
			A2,
			{ "connection.autoconnect-priority": String(MARK) },
		]);
	});

	test("a failed connect records nothing", async () => {
		(
			nm.nmConnect as unknown as { mockResolvedValue(v: boolean): void }
		).mockResolvedValue(false);
		handleWifi(socket, { connect: A2 });
		await replied;
		await settle();
		expect(writes).toEqual([]);
	});
});
