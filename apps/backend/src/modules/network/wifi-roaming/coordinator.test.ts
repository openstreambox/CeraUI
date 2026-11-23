import { afterEach, describe, expect, test } from "bun:test";
import {
	type CoordinatorPorts,
	type RadioObservation,
	RoamingCoordinator,
} from "./coordinator.ts";
import { isCoordinatorOwnedRadio } from "./ownership.ts";
import type { HolderHealth, ScanRow } from "./policy.ts";
import {
	protectRadiosFromScans,
	scanProtectedRadios,
	setScanGateModeReader,
} from "./scan-gate.ts";

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
	/** Applied while a join runs. */
	duringJoin: (() => void) | null = null;
	/** Radios whose scans fail (unplugged, rfkill, NM unavailable). */
	scanFails = new Set<string>();
	/** BSSIDs whose joins fail even with a profile (wrong PSK, full AP). */
	joinFailsOn = new Set<string>();
	/** Virtual interfaces in AP mode, by name, with the phy they sit on. */
	apVifs = new Map<string, string>();
	/** Radios whose gateway has no neighbour entry yet (just joined). */
	noNeighbour = new Set<string>();
	/** Radios whose adapter lock another CeraUI operation holds. */
	lockBusy = new Set<string>();
	/** Applied inside the adapter lock, before the action runs. */
	insideLock: (() => void) | null = null;
	/** Applied after the join's profile work, right before activation. */
	beforeActivate: (() => void) | null = null;
	/** Mode reads that fail (`iw dev` unreadable). */
	modeFails = false;
	/** A different active profile reported for a radio (a transient listing). */
	activationOverride = new Map<string, string>();
	/** Radios whose active-profile listing cannot be read (nmcli failed). */
	activationFails = new Set<string>();
	/** Radios associated without an address (lease renewal, IPv6-only). */
	noAddress = new Set<string>();

	apOnPhyOf(ifname: string): boolean {
		return [...this.apVifs.values()].includes(this.phyOf(ifname));
	}
	calls: string[] = [];
	/** Every join attempt as `<radio>><bssid>`. */
	joins: string[] = [];
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

	phyOf(ifname: string): string {
		return `phy-${ifname}`;
	}

	/** Put a radio, or an extra AP leg on its phy, into AP mode. */
	hotspotOn(ifname: string, vif = ifname) {
		this.apVifs.set(vif, this.phyOf(ifname));
		if (vif === ifname) {
			const s = this.st(ifname);
			s.bssid = null;
			s.activation = "00000000-0000-4000-8000-0000000000ff";
			s.locked = false;
		}
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
					address:
						ap && !this.noAddress.has(ifname)
							? `${ap.subnet}.${host}/24`
							: null,
					gateway: ap && !this.noAddress.has(ifname) ? `${ap.subnet}.1` : null,
					routed: !!ap && !this.noAddress.has(ifname),
					activation: this.activationFails.has(ifname)
						? null
						: (this.activationOverride.get(ifname) ?? s.activation),
					activationRead: !this.activationFails.has(ifname),
					bssidLocked: s.locked,
					phy: this.phyOf(ifname),
					apOnPhy: this.apOnPhyOf(ifname),
				};
			},
			scan: async (ifname): Promise<readonly ScanRow[] | undefined> => {
				this.calls.push(`scan:${ifname}`);
				this.now += this.scanMs;
				this.duringScan?.();
				if (this.scanFails.has(ifname)) return undefined;
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
			join: async (ifname, ssid, bssid, mayActivate) => {
				this.calls.push(`join:${ifname}`);
				this.joins.push(`${ifname}>${bssid}`);
				this.now += this.joinMs;
				this.duringJoin?.();
				if (this.joinFails || this.joinFailsOn.has(bssid)) return undefined;
				// The real port joins only through a profile bound to this radio.
				if (!this.saved.get(ifname)?.has(ssid)) return undefined;
				this.beforeActivate?.();
				if (!(await mayActivate())) return "refused" as const;
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
					gatewayMac: this.noNeighbour.has(_ifname)
						? null
						: (ap?.gatewayMac ?? null),
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
			radioMode: async (ifname) => {
				if (this.modeFails || !this.stations.has(ifname)) return undefined;
				return { phy: this.phyOf(ifname), apOnPhy: this.apOnPhyOf(ifname) };
			},
			withRadioLock: async <T>(ifname: string, fn: () => Promise<T>) => {
				if (this.lockBusy.has(ifname)) return { ok: false as const };
				this.insideLock?.();
				return { ok: true as const, value: await fn() };
			},
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

afterEach(() => {
	protectRadiosFromScans([]);
	setScanGateModeReader(null);
});

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
		// The holder, the hotspot radio and the radio that was carrying when the
		// round began are all kept out of CeraUI's own rescans.
		expect([...scanProtectedRadios()].sort()).toEqual([
			"wlan0",
			"wlan1",
			"wlan2",
		]);
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
		expect(w.touched("wlan2")).toEqual([]);
		// The old holder is now an idle searcher and looks for a path at once.
		// While it is out of the bond and joining, the gate covers it too.
		expect(role(c, "wlan1")).toBe("searcher");
		expect(w.touched("wlan1")).toEqual(["scan:wlan1", "join:wlan1"]);
		expect([...scanProtectedRadios()].sort()).toEqual([
			"wlan0",
			"wlan1",
			"wlan2",
		]);
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
		// Only the hotspot radio stays out of rescans; idle radios are free.
		expect([...scanProtectedRadios()]).toEqual(["wlan0"]);
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

	test("assist keeps a warm spare on another AP, and a fade leaves it carrying", async () => {
		const w = new World();
		w.station("wlan1", AP1, -60);
		w.station("wlan2", null, null);
		// Too weak for a diversity candidate (more than 10 points below AP1), but
		// usable: assist mode puts the spare there rather than on the holder's AP.
		w.ap(AP2).quality = 50;
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
			policy: {
				...(await import("./policy.ts")).DEFAULT_SEARCH_POLICY,
				proactiveMs: 70_000,
			},
		});
		await still(w, c);
		expect(radio(c, "wlan2")).toMatchObject({
			role: "assister",
			bssid: AP2,
			joined: { goal: "capacity" },
		});
		w.setSignal("wlan1", -74);
		w.now += 16_000;
		w.calls = [];
		await c.step();
		expect(w.touched("wlan2")).toEqual([]);
		expect(radio(c, "wlan2")).toMatchObject({ role: "assister", bssid: AP2 });
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

describe("holder loss while a replacement is on its way", () => {
	/** wlan1 fades on AP1 and wlan2 shares it: a continuity search starts. */
	const fading = () => {
		const w = new World();
		w.station("wlan1", AP1, -74);
		w.station("wlan2", AP1, -75);
		return w;
	};

	test("losing the holder during the scan still joins the replacement", async () => {
		const w = fading();
		w.duringScan = () => {
			w.st("wlan1").bssid = null;
		};
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(w.joins).toEqual([`wlan2>${AP2}`]);
		await c.step();
		expect(role(c, "wlan2")).toBe("holder");
		expect(w.touched("wlan2")).toEqual(["scan:wlan2", "join:wlan2"]);
	});

	test("losing the holder during the join keeps the replacement and promotes it", async () => {
		const w = fading();
		w.duringJoin = () => {
			w.st("wlan1").bssid = null;
		};
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(c.status().lastOutcome).toBe("joining:continuity");
		expect(w.stations.get("wlan2")?.bssid).toBe(AP2);
		await c.step();
		expect(radio(c, "wlan2")).toMatchObject({ role: "holder", verified: true });
		expect([...scanProtectedRadios()]).toContain("wlan2");
		expect(w.calls.filter((x) => x.startsWith("abandon"))).toEqual([]);
		expect(w.bond.at(-1)).toBe("release:wlan2");
	});

	test("losing the holder between join and verification promotes the replacement", async () => {
		const w = fading();
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(c.status().lastOutcome).toBe("joining:continuity");
		w.st("wlan1").bssid = null;
		w.now += 1_000;
		await c.step();
		expect(radio(c, "wlan2")).toMatchObject({ role: "holder", verified: true });
		expect(w.calls.filter((x) => x.startsWith("abandon"))).toEqual([]);
	});

	test("with no holder an unready replacement keeps its verify window", async () => {
		const w = fading();
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		// The lease has not arrived yet when the holder drops.
		w.st("wlan2").locked = false;
		w.st("wlan1").bssid = null;
		w.now += 1_000;
		await c.step();
		expect(w.calls.filter((x) => x.startsWith("abandon"))).toEqual([]);
		expect(radio(c, "wlan2").joined?.bssid).toBe(AP2);
		// It stays out of the bond until it verifies.
		expect(w.bond).toEqual(["hold:wlan2"]);
		w.st("wlan2").locked = true;
		w.now += 1_000;
		await c.step();
		expect(role(c, "wlan2")).toBe("holder");
	});

	test("a holder that moves to another AP during the join does not discard it", async () => {
		const w = fading();
		w.aps.set(AP3, { ...w.ap(AP3), ssid: "venue", visible: false });
		w.duringJoin = () => {
			w.st("wlan1").bssid = AP3;
		};
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(c.status().lastOutcome).toBe("joining:continuity");
		w.now += 1_000;
		await c.step();
		expect(radio(c, "wlan2")).toMatchObject({ verified: true, bssid: AP2 });
	});
});

describe("verification guards", () => {
	test("a holder that roams onto the candidate during verification fails it", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP1, -56);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(w.joins).toEqual([`wlan2>${AP2}`]);
		w.st("wlan1").bssid = AP2;
		await c.step();
		expect(radio(c, "wlan2").verified).toBe(false);
		w.now += 15_000;
		await c.step();
		expect(c.status().lastOutcome).toBe("verify-timeout");
	});

	test("a landing without the BSSID lock is not verified", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP1, -56);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		w.st("wlan2").locked = false;
		await c.step();
		expect(radio(c, "wlan2").verified).toBe(false);
		w.now += 15_000;
		await c.step();
		expect(c.status().lastOutcome).toBe("verify-timeout");
	});
});

describe("joinable candidates only", () => {
	test("the holder's SSID without a profile on this radio is never picked", async () => {
		const w = new World();
		w.station("wlan1", AP1, -74);
		w.station("wlan2", null, null);
		w.saved.set("wlan2", new Set(["venue-guest"]));
		w.ap(AP3).visible = true;
		// Weaker than the holder-SSID AP2, so only joinability can decide.
		w.ap(AP3).quality = 62;
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(w.joins).toEqual([`wlan2>${AP3}`]);
		await c.step();
		expect(radio(c, "wlan2")).toMatchObject({ verified: true, bssid: AP3 });
	});

	test("a BSSID whose join failed yields to another candidate next time", async () => {
		const w = new World();
		w.station("wlan1", AP1, -74);
		w.station("wlan2", null, null);
		w.saved.set("wlan2", new Set(["venue", "venue-guest"]));
		w.ap(AP3).visible = true;
		w.ap(AP3).quality = 60;
		w.joinFailsOn.add(AP2);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(c.status().lastOutcome).toBe("join-failed");
		w.now += 20_000;
		await c.step();
		expect(w.joins).toEqual([`wlan2>${AP2}`, `wlan2>${AP3}`]);
	});
});

describe("hotspot follows the radio's runtime mode", () => {
	test("a client radio switched to AP mode is never scanned, joined or owned", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", null, null);
		w.hotspotOn("wlan2");
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		for (let t = 0; t <= 300_000; t += 30_000) {
			w.now = t;
			await c.step();
		}
		expect(w.touched("wlan2")).toEqual([]);
		expect(role(c, "wlan2")).toBe("hotspot-reserved");
		expect(isCoordinatorOwnedRadio("wlan2")).toBe(false);
		expect([...scanProtectedRadios()]).toContain("wlan2");
	});

	test("an AP leg on the same phy reserves the station radio too", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", null, null);
		w.hotspotOn("wlan2", "clap-wlan2");
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(w.touched("wlan2")).toEqual([]);
		expect(role(c, "wlan2")).toBe("hotspot-reserved");
	});

	test("the radio becomes a searcher again once its hotspot stops", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", null, null);
		w.hotspotOn("wlan2", "clap-wlan2");
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		w.apVifs.clear();
		w.now = 1_000;
		await c.step();
		expect(w.calls[0]).toBe("scan:wlan2");
		expect(isCoordinatorOwnedRadio("wlan2")).toBe(true);
	});

	test("a hotspot that starts between the look and the scan stops the scan", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", null, null);
		w.insideLock = () => w.hotspotOn("wlan2", "clap-wlan2");
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(w.touched("wlan2")).toEqual([]);
		expect(c.status().lastOutcome).toBe("radio-in-ap-mode");
		expect(w.bond.at(-1)).toBe("release:wlan2");
	});

	test("an adapter lock held elsewhere stops the action", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", null, null);
		w.lockBusy.add("wlan2");
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(w.touched("wlan2")).toEqual([]);
		expect(c.status().lastOutcome).toBe("radio-busy");
	});

	test("a searcher sharing a phy with a holder never scans", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", null, null);
		w.phyOf = (ifname) => (ifname === "wlan2" ? "phy-wlan1" : `phy-${ifname}`);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(w.touched("wlan2")).toEqual([]);
	});
});

describe("every radio gets a turn", () => {
	test("a radio whose scans fail does not take every search", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", null, null);
		w.station("wlan3", null, null);
		w.scanFails.add("wlan2");
		w.ap(AP2).visible = false;
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2", "wlan3"),
		});
		for (let t = 0; t <= 600_000; t += 10_000) {
			w.now = Math.max(w.now, t);
			await c.step();
		}
		expect(w.calls).toContain("scan:wlan3");
	});

	test("idle radios take turns", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", null, null);
		w.station("wlan3", null, null);
		w.ap(AP2).visible = false;
		w.otherLinks = 1;
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2", "wlan3"),
		});
		// Empty searches back off: 0, 120, 360 and 840 s.
		for (let t = 0; t <= 900_000; t += 10_000) {
			w.now = Math.max(w.now, t);
			await c.step();
		}
		const scans = w.calls.filter((x) => x.startsWith("scan"));
		expect(scans.slice(0, 4)).toEqual([
			"scan:wlan2",
			"scan:wlan3",
			"scan:wlan2",
			"scan:wlan3",
		]);
	});
});

describe("learned uplinks follow the current holders", () => {
	/**
	 * wlan2 learns AP3 (venue-guest on AP1's router) as the same uplink as the
	 * holder on AP1, then loses it.
	 */
	const learnedAp3 = async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", null, null);
		w.ap(AP2).visible = false;
		w.ap(AP3).visible = true;
		w.saved.set("wlan2", new Set(["venue", "venue-guest"]));
		w.otherLinks = 1;
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		await c.step();
		expect(radio(c, "wlan2")).toMatchObject({
			bssid: AP3,
			diversity: "same-uplink",
		});
		w.st("wlan2").bssid = null;
		w.st("wlan2").activation = null;
		w.now += 1_000;
		await c.step();
		return { w, c };
	};

	test("a BSSID learned against an old holder is judged against the new one", async () => {
		const { w, c } = await learnedAp3();
		// The holder moves to AP2 on another router; AP1 leaves range.
		w.st("wlan1").bssid = AP2;
		w.ap(AP2).visible = true;
		w.ap(AP1).visible = false;
		w.now += 10 * 60_000;
		w.joins = [];
		await c.step();
		expect(w.joins).toEqual([`wlan2>${AP3}`]);
	});

	test("what was learned expires", async () => {
		const { w, c } = await learnedAp3();
		w.now += 31 * 60_000;
		w.joins = [];
		await c.step();
		expect(w.joins).toEqual([`wlan2>${AP3}`]);
	});

	test("within its lifetime a same-uplink BSSID is still skipped", async () => {
		const { w, c } = await learnedAp3();
		w.now += 5 * 60_000;
		w.joins = [];
		await c.step();
		expect(w.joins).toEqual([]);
		expect(c.status().lastOutcome).toBe("no-candidate:diversity");
	});
});

describe("gateway MAC gaps", () => {
	test("a missing neighbour entry keeps the gateway MAC learned for that BSSID", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP2, -56);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(radio(c, "wlan2").diversity).toBe("distinct-gateway");
		// Both routers use 192.168.0.1/24; only the MAC tells them apart.
		w.noNeighbour.add("wlan2");
		w.now += 1_000;
		await c.step();
		expect(radio(c, "wlan2").diversity).toBe("distinct-gateway");
	});

	test("without any MAC, two factory-default routers are unknown, not one uplink", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP2, -56);
		w.noNeighbour.add("wlan2");
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(radio(c, "wlan2").diversity).toBe("unknown");
	});
});

describe("status for the bench record", () => {
	test("each radio reports whether its profile is locked to the BSSID", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP1, -56);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		await c.step();
		expect(radio(c, "wlan2").verified).toBe(true);
		expect(radio(c, "wlan1").bssidLocked).toBe(false);
		expect(radio(c, "wlan2").bssidLocked).toBe(true);
	});
});

describe("scan gate covers every radio that must not scan", () => {
	test("holders, assisters and the hotspot radio are protected; an idle searcher is not", async () => {
		const w = new World();
		w.station("wlan1", AP1, -68);
		w.station("wlan2", AP2, -60);
		w.station("wlan3", null, null);
		w.scanFails.add("wlan3");
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2", "wlan3"),
		});
		await c.step();
		expect([...scanProtectedRadios()].sort()).toEqual([
			"wlan0",
			"wlan1",
			"wlan2",
		]);
	});
});

describe("second fix round: protection is current, cleanup never cuts a live station", () => {
	test("a searcher is in the scan gate as soon as it leaves the bond, before the next round", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", null, null);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(radio(c, "wlan2").joined?.bssid).toBe(AP2);
		expect(radio(c, "wlan2").verified).toBe(false);
		expect([...scanProtectedRadios()]).toContain("wlan2");
	});

	test("a hotspot that appears after the profile work stops the activation", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", null, null);
		w.beforeActivate = () => w.hotspotOn("wlan2", "clap-wlan2");
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(c.status().lastOutcome).toBe("radio-in-ap-mode");
		expect(w.stations.get("wlan2")?.bssid).toBeNull();
		expect(radio(c, "wlan2").joined).toBeNull();
		expect(w.bond.at(-1)).toBe("release:wlan2");
	});

	test("an unreadable mode refuses the scan", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", null, null);
		w.modeFails = true;
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(w.touched("wlan2")).toEqual([]);
		expect(c.status().lastOutcome).toBe("radio-in-ap-mode");
	});

	test("an AP leg next to a verified station leaves the station and its clone alone", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP1, -56);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		await c.step();
		expect(radio(c, "wlan2")).toMatchObject({ verified: true, bssid: AP2 });
		w.hotspotOn("wlan2", "clap-wlan2");
		for (let i = 0; i < 3; i++) {
			w.now += 20_000;
			await c.step();
		}
		expect(w.calls.filter((x) => x.startsWith("abandon"))).toEqual([]);
		expect(w.stations.get("wlan2")?.bssid).toBe(AP2);
		expect(radio(c, "wlan2")).toMatchObject({
			role: "hotspot-reserved",
			joined: { bssid: AP2 },
		});
		// The AP leg goes: the station carries on as a verified assister.
		w.apVifs.clear();
		w.now += 1_000;
		await c.step();
		expect(radio(c, "wlan2")).toMatchObject({
			role: "assister",
			verified: true,
		});
	});

	test("an AP leg next to a station still verifying keeps it, out of the bond", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP1, -56);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		w.hotspotOn("wlan2", "clap-wlan2");
		w.now += 30_000;
		await c.step();
		expect(w.calls.filter((x) => x.startsWith("abandon"))).toEqual([]);
		expect(w.stations.get("wlan2")?.bssid).toBe(AP2);
		expect(w.bond).toEqual(["hold:wlan2"]);
	});

	test("a standalone AP that replaced the station gets the stale clone removed", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP1, -56);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		await c.step();
		w.hotspotOn("wlan2");
		w.now += 1_000;
		await c.step();
		expect(w.calls.filter((x) => x.startsWith("abandon"))).toEqual([
			"abandon:wlan2",
		]);
		expect(radio(c, "wlan2").joined).toBeNull();
	});

	test("a cleanup waits while the adapter lock is busy, then runs", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP1, -56);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		await c.step();
		w.hotspotOn("wlan2");
		w.lockBusy.add("wlan2");
		w.now += 1_000;
		await c.step();
		expect(w.calls.filter((x) => x.startsWith("abandon"))).toEqual([]);
		w.lockBusy.clear();
		w.now += 1_000;
		await c.step();
		expect(w.calls.filter((x) => x.startsWith("abandon"))).toEqual([
			"abandon:wlan2",
		]);
	});

	test("a verify timeout does not tear down a station whose phy just gained an AP", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP1, -56);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		w.st("wlan2").locked = false; // never verifies
		w.now += 15_000;
		// The AP leg comes up between this round's look and the cleanup.
		w.insideLock = () => w.hotspotOn("wlan2", "clap-wlan2");
		await c.step();
		expect(c.status().lastOutcome).toBe("verify-timeout");
		expect(w.calls.filter((x) => x.startsWith("abandon"))).toEqual([]);
		expect(w.stations.get("wlan2")?.bssid).toBe(AP2);
	});

	test("a lease renewal keeps a verified station and a holder in their roles, unscanned", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP1, -56);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		await c.step();
		w.noAddress.add("wlan1");
		w.noAddress.add("wlan2");
		for (let i = 0; i < 4; i++) {
			w.now += 70_000;
			await c.step();
		}
		expect(role(c, "wlan1")).toBe("holder");
		expect(w.calls).toEqual(["scan:wlan2", "join:wlan2"]);
		expect(radio(c, "wlan2").joined?.bssid).toBe(AP2);
	});

	test("a radio associated without an address is not idle and is not scanned", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		// NetworkManager associated it on its own; the lease is still pending.
		w.station("wlan2", AP2, -56);
		w.noAddress.add("wlan2");
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(w.touched("wlan2")).toEqual([]);
	});

	test("a backfilled gateway MAC ages from when it was really seen, at pick time too", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP2, -56);
		w.ap(AP3).visible = true;
		w.saved.set("wlan2", new Set(["venue", "venue-guest"]));
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step(); // AP2's gateway MAC is seen once, at 0
		w.noNeighbour.add("wlan2");
		for (const min of [10, 20, 29]) {
			w.now = min * 60_000;
			await c.step();
			expect(radio(c, "wlan2").diversity).toBe("distinct-gateway");
		}
		expect(w.calls).toEqual([]);
		// wlan2 leaves AP2 at 31 min. AP2 was associated two minutes ago, but its
		// MAC is 31 minutes old: on the holder's gateway and subnet it is unknown,
		// so the slightly stronger AP3 wins the diversity search.
		w.st("wlan2").bssid = null;
		w.st("wlan2").activation = null;
		w.now = 31 * 60_000;
		await c.step();
		expect(w.joins).toEqual([`wlan2>${AP3}`]);
	});

	test("a gateway MAC older than the learned lifetime is not backfilled", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP2, -56);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		expect(radio(c, "wlan2").diversity).toBe("distinct-gateway");
		// AP2 is gone for 31 min with no lookup in between, then back without a
		// neighbour entry, on the holder's gateway address and subnet.
		w.now += 31 * 60_000;
		w.noNeighbour.add("wlan2");
		await c.step();
		expect(radio(c, "wlan2").diversity).toBe("unknown");
	});
});

describe("third fix round: unknown is not absent", () => {
	test("an unreadable active-profile listing on an AP phy keeps the live station", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP1, -56);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		await c.step();
		expect(radio(c, "wlan2").verified).toBe(true);
		w.hotspotOn("wlan2", "clap-wlan2");
		w.activationFails.add("wlan2");
		for (let i = 0; i < 3; i++) {
			w.now += 20_000;
			await c.step();
		}
		expect(w.calls.filter((x) => x.startsWith("abandon"))).toEqual([]);
		expect(w.stations.get("wlan2")?.bssid).toBe(AP2);
		expect(radio(c, "wlan2").joined?.bssid).toBe(AP2);
	});

	test("an unreadable listing never tears down a promoted holder's clone", async () => {
		const w = new World();
		w.station("wlan1", AP1, -74);
		w.station("wlan2", AP1, -75);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		w.st("wlan1").bssid = null;
		w.now += 1_000;
		await c.step();
		expect(radio(c, "wlan2")).toMatchObject({ role: "holder", verified: true });
		w.activationFails.add("wlan2");
		for (let i = 0; i < 3; i++) {
			w.now += 20_000;
			await c.step();
		}
		expect(w.calls.filter((x) => x.startsWith("abandon"))).toEqual([]);
		expect(role(c, "wlan2")).toBe("holder");
		expect(w.stations.get("wlan2")?.bssid).toBe(AP2);
		expect(radio(c, "wlan2").joined?.bssid).toBe(AP2);
	});

	test("a holder's clone that is active again at the fresh look is never removed", async () => {
		const w = new World();
		w.station("wlan1", AP1, -74);
		w.station("wlan2", AP1, -75);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		w.st("wlan1").bssid = null;
		w.now += 1_000;
		await c.step();
		expect(role(c, "wlan2")).toBe("holder");
		// The round's listing shows another profile; by the time the cleanup
		// looks again under the lock, the clone is the active connection.
		w.activationOverride.set("wlan2", "00000000-0000-4000-8000-0000000000aa");
		w.insideLock = () => w.activationOverride.clear();
		w.now += 1_000;
		await c.step();
		expect(w.calls.filter((x) => x.startsWith("abandon"))).toEqual([]);
		expect(w.stations.get("wlan2")?.bssid).toBe(AP2);
	});

	test("an unreadable listing defers even an ordinary cleanup, which runs once readable", async () => {
		const w = new World();
		w.station("wlan1", AP1, -50);
		w.station("wlan2", AP1, -56);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2"),
		});
		await c.step();
		w.st("wlan2").locked = false; // never verifies
		w.activationFails.add("wlan2");
		w.now += 15_000;
		await c.step();
		expect(c.status().lastOutcome).toBe("verify-timeout");
		expect(w.calls.filter((x) => x.startsWith("abandon"))).toEqual([]);
		w.activationFails.clear();
		w.now += 1_000;
		await c.step();
		expect(w.calls.filter((x) => x.startsWith("abandon"))).toEqual([
			"abandon:wlan2",
		]);
	});

	test("a station frozen on a reserved radio does not stop another radio from searching", async () => {
		const w = new World();
		w.station("wlan1", AP1, -74);
		w.station("wlan2", AP1, -75);
		w.station("wlan3", null, null);
		const c = new RoamingCoordinator(w.ports(), {
			radios: radios("wlan1", "wlan2", "wlan3"),
		});
		await c.step();
		expect(w.joins).toEqual([`wlan3>${AP2}`]);
		// wlan3's join stays unverified when its phy gains an AP leg.
		w.st("wlan3").locked = false;
		w.hotspotOn("wlan3", "clap-wlan3");
		w.now += 1_000;
		await c.step();
		expect(role(c, "wlan3")).toBe("hotspot-reserved");
		w.now += 60_000;
		await c.step();
		expect(w.touched("wlan2")).toContain("scan:wlan2");
	});
});
