import { afterEach, describe, expect, test } from "bun:test";
import {
	type CoordinatorPorts,
	type RadioObservation,
	RoamingCoordinator,
} from "./coordinator.ts";
import {
	protectRadiosFromScans,
	scanProtectedRadios,
	setScanGateModeReader,
} from "./scan-gate.ts";
import type { LinkSample, Snapshot } from "./sender-links.ts";

/*
  Handover on the sender's arrival reports. The radios here are already
  associated (no searching): wlan1 holds AP1, wlan2 carries on AP2 behind
  another gateway. A fake sender reports, once per one-second round, what was
  queued on each radio's link and the ACK entries that came back a second
  later, so a test can make a link deliver, fade or go silent.
*/

type Ap = { gateway: string; gatewayMac: string; subnet: string };
const APS: Record<string, Ap> = {
	"aa:00:00:00:00:01": {
		gateway: "192.168.1.1",
		gatewayMac: "02:00:00:00:01:01",
		subnet: "192.168.1",
	},
	"aa:00:00:00:00:02": {
		gateway: "192.168.2.1",
		gatewayMac: "02:00:00:00:02:02",
		subnet: "192.168.2",
	},
	"aa:00:00:00:00:03": {
		gateway: "192.168.3.1",
		gatewayMac: "02:00:00:00:03:03",
		subnet: "192.168.3",
	},
	// A second AP behind AP1's router: another BSSID, the same uplink.
	"aa:00:00:00:00:04": {
		gateway: "192.168.1.1",
		gatewayMac: "02:00:00:00:01:01",
		subnet: "192.168.1",
	},
};
const AP1 = "aa:00:00:00:00:01";
const AP2 = "aa:00:00:00:00:02";
const AP3 = "aa:00:00:00:00:03";
const AP4 = "aa:00:00:00:00:04";

/** One radio's link as the sender sees it. */
type Link = {
	epoch: number;
	pps: number;
	/** Share of what is queued that the receiver acknowledges. */
	deliver: number;
	queued: number;
	arrived: number;
	/** What had arrived by the end of the previous round (ACKs lag one round). */
	ackedArrived: number;
	ageMs: number | null;
	over: Partial<LinkSample>;
};

class World {
	now = 100_000;
	stations = new Map<
		string,
		{ bssid: string | null; activation: string; signalDbm: number }
	>();
	links = new Map<string, Link>();
	bond: string[] = [];
	reports = true;
	encoderBps: number | null = null;

	station(ifname: string, bssid: string, signalDbm = -55, pps = 60) {
		this.stations.set(ifname, {
			bssid,
			activation: `act-${ifname}-${bssid}`,
			signalDbm,
		});
		this.links.set(ifname, {
			epoch: this.links.size + 1,
			pps,
			deliver: 1,
			queued: 0,
			arrived: 0,
			ackedArrived: 0,
			ageMs: 100,
			over: {},
		});
	}

	signal(ifname: string, dbm: number) {
		const s = this.stations.get(ifname);
		if (!s) throw new Error(`no station ${ifname}`);
		s.signalDbm = dbm;
	}

	link(ifname: string): Link {
		const l = this.links.get(ifname);
		if (!l) throw new Error(`no link ${ifname}`);
		return l;
	}

	/** Advance the sender one second and report it. */
	snapshot(): Snapshot | undefined {
		if (!this.reports) return undefined;
		const radios = new Map<string, LinkSample>();
		for (const [ifname, l] of this.links) {
			l.ackedArrived = l.arrived;
			l.queued += l.pps;
			l.arrived += l.pps * l.deliver;
			radios.set(ifname, {
				epoch: l.epoch,
				connected: true,
				timedOut: false,
				queued: l.queued,
				entries: Math.floor(l.ackedArrived / 10) * 10,
				ageMs: l.ageMs,
				rttMs: 30,
				bitrateBps: l.pps * 1_400 * 8,
				stallGated: false,
				soleCarrierExcluded: false,
				weak: false,
				weakReason: null,
				inFlightCapActive: false,
				ccLossDegraded: false,
				ccTargetBps: null,
				ccState: null,
				ccLossPermille: null,
				...l.over,
			});
		}
		return {
			at: this.now,
			radios,
			others: new Map(),
			negotiatedLatencyMs: 2000,
			claimed: new Set(radios.keys()),
		};
	}

	ports(): CoordinatorPorts {
		return {
			now: () => this.now,
			observe: async (ifname): Promise<RadioObservation | undefined> => {
				const s = this.stations.get(ifname);
				if (!s) return undefined;
				const ap = s.bssid ? APS[s.bssid] : undefined;
				return {
					ifname,
					ssid: ap ? "venue" : null,
					bssid: s.bssid,
					signalDbm: s.bssid ? s.signalDbm : null,
					address: ap ? `${ap.subnet}.10/24` : null,
					gateway: ap?.gateway ?? null,
					routed: !!ap,
					activation: s.bssid ? s.activation : null,
					activationRead: true,
					bssidLocked: true,
					phy: `phy-${ifname}`,
					apOnPhy: false,
				};
			},
			scan: async () => [],
			savedSsids: async () => new Set(),
			join: async () => undefined,
			radioMode: async (ifname) => ({ phy: `phy-${ifname}`, apOnPhy: false }),
			abandon: async () => true,
			uplinkOf: async (_ifname, o) => {
				const ap = APS[o.bssid ?? ""];
				return {
					gateway: o.gateway,
					gatewayMac: ap?.gatewayMac ?? null,
					subnet: ap ? `${ap.subnet}.0/24` : null,
					egress: null,
				};
			},
			holderHealth: (ifname) => ({
				signalDbm: this.stations.get(ifname)?.signalDbm ?? null,
				attributedBps: null,
				encoderBps: null,
				nakRatio: null,
			}),
			otherUplinks: () => 0,
			holdOutOfBond: (ifname) => this.bond.push(`hold:${ifname}`),
			releaseBondHold: (ifname) => this.bond.push(`release:${ifname}`),
			withRadioLock: async <T>(_ifname: string, fn: () => Promise<T>) => ({
				ok: true as const,
				value: await fn(),
			}),
			senderLinks: () => this.snapshot(),
			encoderRate: () => this.encoderBps,
		};
	}
}

afterEach(() => {
	protectRadiosFromScans([]);
	setScanGateModeReader(null);
});

function setup(withReports = true) {
	const w = new World();
	w.station("wlan1", AP1);
	w.station("wlan2", AP2);
	const ports = w.ports();
	if (!withReports) {
		delete (ports as { senderLinks?: unknown }).senderLinks;
	}
	const c = new RoamingCoordinator(ports, {
		radios: [{ ifname: "wlan1" }, { ifname: "wlan2" }],
	});
	const rounds = async (n: number) => {
		for (let i = 0; i < n; i++) {
			w.now += 1_000;
			await c.step();
		}
	};
	const role = (ifname: string) =>
		c.status().radios.find((r) => r.ifname === ifname)?.role;
	return { w, c, rounds, role };
}

/** Run until wlan1 holds and wlan2 carries, the way the coordinator starts. */
async function settled(withReports = true) {
	const t = setup(withReports);
	await t.rounds(1);
	expect(t.role("wlan1")).toBe("holder");
	expect(t.role("wlan2")).toBe("assister");
	return t;
}

describe("continuity handover on arrival reports", () => {
	test("without arrival reports a fading holder is never replaced", async () => {
		const t = await settled(false);
		t.w.signal("wlan1", -78);
		await t.rounds(30);
		expect(t.role("wlan1")).toBe("holder");
		expect(t.role("wlan2")).toBe("assister");
		expect(t.c.status().swap).toBeNull();
	});

	test("a steady holder starts no handover", async () => {
		const t = await settled();
		await t.rounds(30);
		expect(t.c.status().swap).toBeNull();
		expect(t.role("wlan1")).toBe("holder");
	});

	test("a fading holder hands over to a delivering candidate by relabel, and the old holder carries through the linger", async () => {
		const t = await settled();
		await t.rounds(3);
		t.w.signal("wlan1", -78);
		let promotedAfter = -1;
		for (let i = 1; i <= 15 && promotedAfter < 0; i++) {
			await t.rounds(1);
			if (t.role("wlan2") === "holder") promotedAfter = i;
		}
		expect(promotedAfter).toBeGreaterThan(0);
		// Promotion moved the scan protection; the old holder is still a holder
		// and still in the bond through the linger.
		expect(scanProtectedRadios().has("wlan2")).toBe(true);
		expect(t.role("wlan1")).toBe("holder");
		expect(t.c.status().swap?.phase).toBe("linger");
		await t.rounds(11);
		expect(t.role("wlan2")).toBe("holder");
		expect(t.role("wlan1")).toBe("assister");
		expect(t.c.status().swap).toBeNull();
		expect(t.c.status().lastSwapOutcome).toBe("released:wlan2");
		// Nothing left the bond.
		expect(t.w.bond).toEqual([]);
	});

	test("linger renewals do not depend on the headroom estimate", async () => {
		const t = await settled();
		await t.rounds(3);
		t.w.signal("wlan1", -78);
		for (let i = 0; i < 15 && t.role("wlan2") !== "holder"; i++)
			await t.rounds(1);
		expect(t.role("wlan2")).toBe("holder");
		// Its share jumps and its CC settles below 1.25 x the encoder rate: a
		// headroom check would now fail it, but it still delivers everything.
		t.w.encoderBps = 1_400_000;
		t.w.link("wlan2").over = { ccTargetBps: 900_000, ccState: "holding" };
		await t.rounds(11);
		expect(t.c.status().lastSwapOutcome).toBe("released:wlan2");
		expect(t.role("wlan1")).toBe("assister");
	});

	test("a candidate that loses packets is not promoted, and cools down", async () => {
		const t = await settled();
		await t.rounds(3);
		t.w.link("wlan2").deliver = 0.6;
		t.w.signal("wlan1", -78);
		for (
			let i = 0;
			i < 8 && !t.c.status().lastSwapOutcome?.startsWith("candidate-failed");
			i++
		)
			await t.rounds(1);
		expect(t.role("wlan2")).toBe("assister");
		expect(t.c.status().lastSwapOutcome).toStartWith("candidate-failed:wlan2");
		// No new attempt on that BSSID during its first cool-down step (10 s
		// from the failure), then it may try again.
		const failedAt = t.w.now;
		while (t.w.now < failedAt + 9_000) {
			await t.rounds(1);
			expect(t.c.status().swap).toBeNull();
		}
		expect(t.role("wlan1")).toBe("holder");
		await t.rounds(2);
		expect(t.c.status().swap?.candidate).toBe("wlan2");
	});

	test("a holder that recovers before the proof completes keeps its role", async () => {
		const t = await settled();
		await t.rounds(3);
		t.w.signal("wlan1", -78);
		await t.rounds(1);
		expect(t.c.status().swap?.phase).toBe("proving");
		t.w.signal("wlan1", -55);
		// One more round while the fall still shows in the signal slope.
		await t.rounds(2);
		expect(t.c.status().swap).toBeNull();
		expect(t.c.status().lastSwapOutcome).toBe("not-needed:wlan2");
		await t.rounds(10);
		expect(t.role("wlan1")).toBe("holder");
		expect(t.role("wlan2")).toBe("assister");
	});

	test("a new holder that stops delivering during the linger is undone", async () => {
		const t = await settled();
		await t.rounds(3);
		t.w.signal("wlan1", -78);
		for (let i = 0; i < 15 && t.role("wlan2") !== "holder"; i++)
			await t.rounds(1);
		expect(t.role("wlan2")).toBe("holder");
		t.w.link("wlan2").deliver = 0.5;
		await t.rounds(6);
		expect(t.role("wlan2")).toBe("assister");
		expect(t.role("wlan1")).toBe("holder");
		expect(t.c.status().lastSwapOutcome).toBe("restored:wlan2");
		// Its BSSID cools down: no immediate retry on the same path.
		await t.rounds(3);
		expect(t.c.status().swap).toBeNull();
	});

	test("a holder the receiver stops hearing is relabelled at once, without a hold-out", async () => {
		const t = await settled();
		await t.rounds(5);
		// The holder's path dies while it stays associated: its ACK age grows
		// while wlan2 still gets ACKs.
		t.w.link("wlan1").deliver = 0;
		t.w.link("wlan1").ageMs = 1_700;
		await t.rounds(1);
		expect(t.role("wlan2")).toBe("holder");
		expect(t.role("wlan1")).toBe("assister");
		expect(t.c.status().lastOutcome).toBe("holder-dead:wlan1>wlan2");
		expect(scanProtectedRadios().has("wlan2")).toBe(true);
		expect(t.w.bond).toEqual([]);
	});

	test("with nobody else delivering, a dead holder stays holder", async () => {
		const t = await settled();
		await t.rounds(5);
		t.w.link("wlan1").ageMs = 1_700;
		t.w.link("wlan2").ageMs = 1_700;
		t.w.link("wlan2").deliver = 0;
		await t.rounds(2);
		expect(t.role("wlan1")).toBe("holder");
	});

	test("in a Wi-Fi-only bond a double failure counts against the candidate", async () => {
		const t = await settled();
		await t.rounds(3);
		t.w.link("wlan1").deliver = 0.5;
		t.w.link("wlan2").deliver = 0.5;
		await t.rounds(8);
		expect(t.c.status().lastSwapOutcome).toStartWith("candidate-failed:wlan2");
		expect(t.role("wlan1")).toBe("holder");
	});

	test("arrival reports going away ends the handover and keeps the roles", async () => {
		const t = await settled();
		await t.rounds(3);
		t.w.signal("wlan1", -78);
		await t.rounds(1);
		expect(t.c.status().swap).not.toBeNull();
		t.w.reports = false;
		await t.rounds(1);
		expect(t.c.status().swap).toBeNull();
		expect(t.c.status().lastSwapOutcome).toBe("no-arrival-reports");
		expect(t.role("wlan1")).toBe("holder");
	});

	/** wlan1 holds AP1 (made strongest); the others are given. */
	async function three(others: [string, number][]) {
		const w = new World();
		w.station("wlan1", AP1, -45);
		for (const [i, [bssid, dbm]] of others.entries())
			w.station(`wlan${i + 2}`, bssid, dbm);
		const c = new RoamingCoordinator(w.ports(), {
			radios: [
				{ ifname: "wlan1" },
				...others.map((_, i) => ({ ifname: `wlan${i + 2}` })),
			],
		});
		const step = async () => {
			w.now += 1_000;
			await c.step();
		};
		await step();
		expect(c.status().radios.find((r) => r.ifname === "wlan1")?.role).toBe(
			"holder",
		);
		w.signal("wlan1", -78);
		for (let i = 0; i < 3; i++) await step();
		return c;
	}

	test("a radio on the holder's own AP is never a continuity candidate", async () => {
		const c = await three([[AP1, -50]]);
		expect(c.status().swap).toBeNull();
	});

	test("a separate gateway ranks before a stronger AP behind the holder's router", async () => {
		const c = await three([
			[AP4, -50],
			[AP3, -65],
		]);
		expect(c.status().swap?.candidate).toBe("wlan3");
	});
});
