import { afterEach, describe, expect, test } from "bun:test";
import {
	type CoordinatorPorts,
	type RadioObservation,
	RoamingCoordinator,
} from "./coordinator.ts";
import { isCoordinatorOwnedRadio } from "./ownership.ts";
import type { HolderHealth, ScanRow } from "./policy.ts";
import { protectRadiosFromScans, scanProtectedRadios } from "./scan-gate.ts";

type Ap = {
	ssid: string;
	quality: number;
	gatewayMac: string;
	subnet: string;
	/** Seen in scans; an AP can be in range for one radio only in reality, but
	 * colocated radios see the same coverage, which is the case here. */
	visible: boolean;
};

type Station = {
	bssid: string | null;
	activation: string | null;
	locked: boolean;
	signalDbm: number | null;
};

const AP1 = "aa:00:00:00:00:01";
const AP2 = "aa:00:00:00:00:02";
const AP3 = "aa:00:00:00:00:03";

/** A small fake of the radios, the APs and the bond, with a fake clock. */
class World {
	now = 0;
	scanMs = 4_000;
	joinMs = 3_000;
	aps = new Map<string, Ap>([
		[
			AP1,
			{
				ssid: "venue",
				quality: 70,
				gatewayMac: "02:00:00:00:01:01",
				subnet: "192.168.0",
				visible: true,
			},
		],
		[
			AP2,
			{
				ssid: "venue",
				quality: 65,
				gatewayMac: "02:00:00:00:02:02",
				subnet: "192.168.0",
				visible: true,
			},
		],
		[
			AP3,
			{
				ssid: "venue-guest",
				quality: 66,
				gatewayMac: "02:00:00:00:01:01",
				subnet: "10.0.0",
				visible: false,
			},
		],
	]);
	stations = new Map<string, Station>();
	saved = new Map<string, Set<string>>();
	health = new Map<string, HolderHealth>();
	otherLinks = 0;
	joinFails = false;
	/** Where a join really lands, when the radio ignores the requested BSSID. */
	landOn: string | null = null;
	/** Applied while a scan runs, to change the world under the coordinator. */
	duringScan: (() => void) | null = null;
	calls: string[] = [];
	bond: string[] = [];
	nextUuid = 1;

	station(
		ifname: string,
		bssid: string | null,
		signalDbm: number | null = -55,
	) {
		this.stations.set(ifname, {
			bssid,
			activation: bssid
				? `00000000-0000-4000-8000-${String(this.nextUuid++).padStart(12, "0")}`
				: null,
			locked: false,
			signalDbm,
		});
		this.saved.set(ifname, new Set(["venue"]));
		this.health.set(ifname, {
			signalDbm,
			attributedBps: null,
			encoderBps: null,
			nakRatio: null,
		});
	}

	st(ifname: string): Station {
		const s = this.stations.get(ifname);
		if (!s) throw new Error(`no station ${ifname}`);
		return s;
	}

	ap(bssid: string): Ap {
		const a = this.aps.get(bssid);
		if (!a) throw new Error(`no AP ${bssid}`);
		return a;
	}

	setSignal(ifname: string, dbm: number) {
		const s = this.st(ifname);
		s.signalDbm = dbm;
		this.health.set(ifname, {
			signalDbm: dbm,
			attributedBps: null,
			encoderBps: null,
			nakRatio: null,
		});
	}

	/** Interfering calls only: scan, join, abandon. */
	touched(ifname: string): string[] {
		return this.calls.filter((c) => c.endsWith(`:${ifname}`));
	}

	ports(): CoordinatorPorts {
		return {
			now: () => this.now,
			observe: async (ifname): Promise<RadioObservation | undefined> => {
				const s = this.stations.get(ifname);
				if (!s) return undefined;
				const ap = s.bssid ? this.aps.get(s.bssid) : undefined;
				const host = [...this.stations.keys()].indexOf(ifname) + 10;
				return {
					ifname,
					ssid: ap?.ssid ?? null,
					bssid: s.bssid,
					signalDbm: s.bssid ? s.signalDbm : null,
					address: ap ? `${ap.subnet}.${host}/24` : null,
					gateway: ap ? `${ap.subnet}.1` : null,
					routed: !!ap,
					activation: s.activation,
					bssidLocked: s.locked,
				};
			},
			scan: async (ifname): Promise<readonly ScanRow[] | undefined> => {
				this.calls.push(`scan:${ifname}`);
				this.now += this.scanMs;
				this.duringScan?.();
				return [...this.aps.entries()]
					.filter(([, ap]) => ap.visible)
					.map(([bssid, ap]) => ({
						bssid,
						ssid: ap.ssid,
						quality: ap.quality,
						channel: 1,
					}));
			},
			savedSsids: async (ifname) => this.saved.get(ifname) ?? new Set(),
			join: async (ifname, ssid, bssid) => {
				this.calls.push(`join:${ifname}`);
				this.now += this.joinMs;
				if (this.joinFails) return undefined;
				const activation = `00000000-0000-4000-8000-${String(this.nextUuid++).padStart(12, "0")}`;
				const s = this.st(ifname);
				s.bssid = this.landOn ?? bssid;
				expect(this.aps.get(bssid)?.ssid).toBe(ssid);
				s.activation = activation;
				s.locked = true;
				s.signalDbm = -60;
				return { activation };
			},
			abandon: async (ifname, activation) => {
				this.calls.push(`abandon:${ifname}`);
				const s = this.st(ifname);
				if (s.activation === activation) {
					s.bssid = null;
					s.activation = null;
					s.locked = false;
				}
				return true;
			},
			uplinkOf: async (_ifname, o) => {
				const ap = this.aps.get(o.bssid ?? "");
				return {
					gateway: o.gateway,
					gatewayMac: ap?.gatewayMac ?? null,
					subnet: ap ? `${ap.subnet}.0/24` : null,
					egress: null,
				};
			},
			holderHealth: (ifname) =>
				this.health.get(ifname) ?? {
					signalDbm: null,
					attributedBps: null,
					encoderBps: null,
					nakRatio: null,
				},
			otherUplinks: () => this.otherLinks,
			holdOutOfBond: (ifname) => this.bond.push(`hold:${ifname}`),
			releaseBondHold: (ifname) => this.bond.push(`release:${ifname}`),
		};
	}
}

const radios = (...names: string[]) => [
	{ ifname: "wlan0", reserved: "hotspot" as const },
	...names.map((ifname) => ({ ifname })),
];

const radio = (c: RoamingCoordinator, ifname: string) => {
	const r = c.status().radios.find((x) => x.ifname === ifname);
	if (!r) throw new Error(`no radio ${ifname}`);
	return r;
};

const role = (c: RoamingCoordinator, ifname: string) =>
	c.status().radios.find((r) => r.ifname === ifname)?.role;

afterEach(() => protectRadiosFromScans([]));

describe("shared-AP start", () => {
	test("holder carries untouched while the other radio finds and joins AP2", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP1, -56);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});

		await c.step();
		expect(role(c, "wlan1")).toBe("holder");
		expect([...scanProtectedRadios()]).toEqual(["wlan1"]);
		expect(w.calls).toEqual(["scan:wlan2", "join:wlan2"]);
		expect(w.bond).toEqual(["hold:wlan2"]);
		expect(w.stations.get("wlan2")).toMatchObject({ bssid: AP2, locked: true });

		await c.step();
		const s = radio(c, "wlan2");
		expect(s).toMatchObject({
			role: "assister",
			verified: true,
			diversity: "distinct-gateway",
		});
		expect(w.bond).toEqual(["hold:wlan2", "release:wlan2"]);
		expect(w.touched("wlan1")).toEqual([]);
		expect(w.touched("wlan0")).toEqual([]);
		expect(c.status().lastOutcome).toBe("verified:diversity:distinct-gateway");
	});

	test("client radios are marked as coordinator-owned until stop; the hotspot radio never", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP1, -56);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		expect(["wlan0", "wlan1", "wlan2"].map(isCoordinatorOwnedRadio)).toEqual([
			false,
			true,
			true,
		]);
		await c.step();
		c.stop();
		expect(["wlan1", "wlan2"].map(isCoordinatorOwnedRadio)).toEqual([
			false,
			false,
		]);
		expect([...scanProtectedRadios()]).toEqual([]);
		expect(w.bond.at(-1)).toBe("release:wlan2");
	});

	test("a steady holder keeps its assister in the bond: no search", async () => {
		const w = new World();
		w.station("wlan1", AP1, -68);
		w.station("wlan2", AP1, -69);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(w.calls).toEqual([]);
		expect(w.bond).toEqual([]);
	});

	test("a fade recalls the assister on the holder's AP at once, then not within 15 s", async () => {
		const w = new World();
		w.station("wlan1", AP1, -72);
		w.station("wlan2", AP1, -73);
		w.ap(AP2).visible = false;
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(w.calls).toEqual(["scan:wlan2"]);
		expect(c.status().lastOutcome).toBe("no-candidate:continuity");
		expect(role(c, "wlan2")).toBe("assister");
		w.now = 10_000;
		await c.step();
		expect(w.calls).toEqual(["scan:wlan2"]);
		w.now = 15_000;
		await c.step();
		expect(w.calls).toEqual(["scan:wlan2", "scan:wlan2"]);
		expect(w.touched("wlan1")).toEqual([]);
	});
});

describe("N radios", () => {
	test("an idle third radio searches; the carrying assister is never withdrawn", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP1, -56);
		w.station("wlan3", null, null);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2", "wlan3"),
		});
		await c.step();
		expect(w.calls).toEqual(["scan:wlan3", "join:wlan3"]);
		expect(w.bond).toEqual(["hold:wlan3"]);
		expect(role(c, "wlan2")).toBe("assister");
	});

	test("an idle radio searches even while the holder has no proven headroom", async () => {
		const w = new World();
		w.station("wlan1", AP1, -68);
		w.station("wlan2", null, null);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(w.calls[0]).toBe("scan:wlan2");
	});

	test("a diverse assister keeps carrying; a diversity search recalls only same-uplink radios", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP2, -56);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(c.status().radios.find((r) => r.ifname === "wlan2")?.diversity).toBe(
			"distinct-gateway",
		);
		expect(w.calls).toEqual([]);
	});

	test("losing the holder promotes a carrying radio and moves the scan gate", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP2, -56);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		w.st("wlan1").bssid = null;
		w.now = 1_000;
		await c.step();
		expect(role(c, "wlan2")).toBe("holder");
		expect([...scanProtectedRadios()]).toEqual(["wlan2"]);
		expect(w.touched("wlan2")).toEqual([]);
		// The old holder is now an idle searcher and may look for a path at once.
		expect(role(c, "wlan1")).toBe("searcher");
	});

	test("no holder at all releases every bond hold", async () => {
		const w = new World();
		w.station("wlan1", null, null);
		w.station("wlan2", null, null);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(c.status().lastOutcome).toBe("no-holder");
		expect(w.calls).toEqual([]);
		expect([...scanProtectedRadios()]).toEqual([]);
	});
});

describe("search outcomes", () => {
	test("nothing found: the assister returns to the bond and the cadence backs off", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP1, -56);
		w.ap(AP2).visible = false;
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(w.bond).toEqual(["hold:wlan2", "release:wlan2"]);
		w.now = 60_000 + w.scanMs;
		await c.step();
		expect(w.calls).toEqual(["scan:wlan2"]);
		w.now = 120_000 + w.scanMs;
		await c.step();
		expect(w.calls).toEqual(["scan:wlan2", "scan:wlan2"]);
	});

	test("a failed join cools down 20 s and abandons nothing", async () => {
		const w = new World();
		w.station("wlan1", AP1, -72);
		w.station("wlan2", AP1, -73);
		w.joinFails = true;
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(c.status().lastOutcome).toBe("join-failed");
		expect(w.bond).toEqual(["hold:wlan2", "release:wlan2"]);
		w.now = 15_000 + w.scanMs + w.joinMs;
		await c.step();
		expect(w.calls).toEqual(["scan:wlan2", "join:wlan2"]);
	});

	test("a join that lands on the holder's AP is abandoned after the verify window", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP1, -56);
		w.landOn = AP1;
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		await c.step();
		expect(role(c, "wlan2")).toBe("searcher");
		w.now += 15_000;
		await c.step();
		expect(c.status().lastOutcome).toBe("verify-timeout");
		expect(w.calls).toEqual(["scan:wlan2", "join:wlan2", "abandon:wlan2"]);
		expect(w.bond).toEqual(["hold:wlan2", "release:wlan2"]);
		expect(w.touched("wlan1")).toEqual([]);
	});

	test("a holder that moves during the scan aborts the search", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP1, -56);
		w.duringScan = () => {
			w.st("wlan1").bssid = AP2;
		};
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(c.status().lastOutcome).toBe("scan-aborted");
		expect(w.calls).toEqual(["scan:wlan2"]);
		expect(w.bond).toEqual(["hold:wlan2", "release:wlan2"]);
	});

	test("a scan that overruns its budget is aborted", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP1, -56);
		w.scanMs = 16_000;
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(c.status().lastOutcome).toBe("scan-aborted");
		expect(w.calls).toEqual(["scan:wlan2"]);
	});
});

describe("same SSID, different backends", () => {
	test("a second SSID on the holder's router is learned as the same uplink and skipped for diversity", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", null, null);
		w.ap(AP2).visible = false;
		w.ap(AP3).visible = true;
		w.saved.set("wlan2", new Set(["venue", "venue-guest"]));
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		await c.step();
		const s = radio(c, "wlan2");
		expect(s).toMatchObject({
			bssid: AP3,
			diversity: "same-uplink",
			verified: true,
		});
	});
});

describe("assist mode", () => {
	/** Step every 10 s up to 150 s with the holder's signal unchanged. */
	const still = async (w: World, c: RoamingCoordinator) => {
		for (let t = 0; t <= 150_000; t += 10_000) {
			w.now = Math.max(w.now, t);
			await c.step();
		}
	};

	test("nothing new, holder not moving, no other links: a spare radio joins to add capacity", async () => {
		const w = new World();
		w.station("wlan1", AP1, -60);
		w.station("wlan2", null, null);
		w.ap(AP2).visible = false;
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
			policy: {
				...(await import("./policy.ts")).DEFAULT_SEARCH_POLICY,
				proactiveMs: 70_000,
			},
		});
		// The first search at t=0 has no stability history; the one at 140 s
		// finds nothing new again and assists.
		await still(w, c);
		const s = radio(c, "wlan2");
		expect(s).toMatchObject({
			role: "assister",
			bssid: AP1,
			verified: true,
			joined: { goal: "capacity" },
		});
		expect(w.touched("wlan1")).toEqual([]);
	});

	test("with a cellular link in the bond the spare radio stays a searcher", async () => {
		const w = new World();
		w.station("wlan1", AP1, -60);
		w.station("wlan2", null, null);
		w.ap(AP2).visible = false;
		w.otherLinks = 1;
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
			policy: {
				...(await import("./policy.ts")).DEFAULT_SEARCH_POLICY,
				proactiveMs: 70_000,
			},
		});
		await still(w, c);
		expect(w.calls.filter((x) => x.startsWith("join"))).toEqual([]);
		expect(role(c, "wlan2")).toBe("searcher");
	});

	test("a fade recalls the capacity assister on the holder's AP to search", async () => {
		const w = new World();
		w.station("wlan1", AP1, -60);
		w.station("wlan2", null, null);
		w.ap(AP2).visible = false;
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
			policy: {
				...(await import("./policy.ts")).DEFAULT_SEARCH_POLICY,
				proactiveMs: 70_000,
			},
		});
		await still(w, c);
		expect(role(c, "wlan2")).toBe("assister");
		w.ap(AP2).visible = true;
		w.setSignal("wlan1", -74);
		w.now += 16_000;
		w.calls = [];
		await c.step();
		expect(w.calls).toEqual(["scan:wlan2", "join:wlan2"]);
		expect(w.stations.get("wlan2")?.bssid).toBe(AP2);
		expect(w.touched("wlan1")).toEqual([]);
	});
});
