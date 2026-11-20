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
	/** Links outside the radios (cellular), keyed like the sender does. */
	others = new Map<string, Link>();
	/** Report a new sample only every this many calls (a slower sender). */
	sampleEvery = 1;
	calls = 0;
	/** A stuck sender: keeps handing out its last sample, `at` unchanged. */
	frozen = false;
	/** Delivered and encoder rates the holder health reports (default: unknown). */
	rates = new Map<string, { attributedBps: number; encoderBps: number }>();
	last: Snapshot | undefined;

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

	cellular(key: string, pps = 60) {
		this.others.set(key, {
			epoch: 100 + this.others.size,
			pps,
			deliver: 1,
			queued: 0,
			arrived: 0,
			ackedArrived: 0,
			ageMs: 100,
			over: {},
		});
	}

	/** Advance the sender one second and report it. */
	snapshot(): Snapshot | undefined {
		if (!this.reports) return undefined;
		if (this.frozen && this.last) return this.last;
		// A slower sender hands out the same sample again in between.
		if (this.calls++ % this.sampleEvery !== 0 && this.last) return this.last;
		const sample = (l: Link): LinkSample => {
			l.ackedArrived = l.arrived;
			l.queued += l.pps;
			l.arrived += l.pps * l.deliver;
			return {
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
			};
		};
		const radios = new Map<string, LinkSample>();
		for (const [ifname, l] of this.links) radios.set(ifname, sample(l));
		const others = new Map<string, LinkSample>();
		for (const [key, l] of this.others) others.set(key, sample(l));
		this.last = {
			at: this.now,
			radios,
			others,
			negotiatedLatencyMs: 2000,
			claimed: new Set(radios.keys()),
		};
		return this.last;
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
				attributedBps: this.rates.get(ifname)?.attributedBps ?? null,
				encoderBps: this.rates.get(ifname)?.encoderBps ?? null,
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

	test("a new holder that dies during the linger gives the label up next to a fading old holder", async () => {
		const t = await settled();
		await t.rounds(3);
		t.w.signal("wlan1", -78);
		for (let i = 0; i < 15 && t.role("wlan2") !== "holder"; i++)
			await t.rounds(1);
		expect(t.role("wlan2")).toBe("holder");
		expect(t.c.status().swap?.phase).toBe("linger");
		// The old holder is the fading one and delivers half; then the new
		// holder's path dies while it stays associated.
		t.w.link("wlan1").deliver = 0.5;
		await t.rounds(5);
		t.w.link("wlan2").deliver = 0;
		t.w.link("wlan2").ageMs = 5_000;
		await t.rounds(30);
		expect(t.role("wlan1") === "holder" && t.role("wlan2") === "holder").toBe(
			false,
		);
		expect(t.role("wlan1")).toBe("holder");
	});

	test("a radio the receiver no longer hears is freed to search after a grace period", async () => {
		const t = await settled();
		await t.rounds(5);
		t.w.link("wlan1").deliver = 0;
		t.w.link("wlan1").ageMs = 5_000;
		await t.rounds(1);
		expect(t.role("wlan2")).toBe("holder");
		expect(t.role("wlan1")).toBe("assister");
		// Not before the grace period: it may only be a short gap.
		await t.rounds(8);
		expect(t.w.bond).toEqual([]);
		await t.rounds(20);
		expect(t.w.bond).toContain("hold:wlan1");
		expect(t.c.status().searches).toBeGreaterThan(0);
	});

	test("the dead-holder relabel skips a more diverse carrier that is not delivering", async () => {
		const w = new World();
		w.station("wlan1", AP1, -45);
		w.station("wlan2", AP3, -50); // a separate gateway: ranks first
		w.station("wlan3", AP4, -50); // behind wlan1's router
		const c = new RoamingCoordinator(w.ports(), {
			radios: [{ ifname: "wlan1" }, { ifname: "wlan2" }, { ifname: "wlan3" }],
		});
		const step = async (n = 1) => {
			for (let i = 0; i < n; i++) {
				w.now += 1_000;
				await c.step();
			}
		};
		await step(6);
		w.link("wlan2").deliver = 0.5; // still gets ACKs, below the fade ratio
		await step(5);
		w.link("wlan1").deliver = 0;
		w.link("wlan1").ageMs = 5_000;
		await step(1);
		const role = (i: string) =>
			c.status().radios.find((r) => r.ifname === i)?.role;
		expect(c.status().lastOutcome).toBe("holder-dead:wlan1>wlan3");
		expect(role("wlan3")).toBe("holder");
		expect(role("wlan2")).toBe("assister");
	});

	test("a cool-down starts over at its first step after a quiet period", async () => {
		const t = await settled();
		await t.rounds(3);
		t.w.link("wlan2").deliver = 0.6;
		const failOnce = async () => {
			t.w.signal("wlan1", -78);
			for (
				let i = 0;
				i < 20 && !t.c.status().lastSwapOutcome?.startsWith("candidate-failed");
				i++
			)
				await t.rounds(1);
			expect(t.c.status().lastSwapOutcome).toStartWith(
				"candidate-failed:wlan2",
			);
			const failedAt = t.w.now;
			for (let i = 0; i < 40 && t.c.status().swap === null; i++)
				await t.rounds(1);
			return t.w.now - failedAt;
		};
		const first = await failOnce();
		// The holder recovers, and nothing fails for well over five minutes.
		t.w.signal("wlan1", -55);
		await t.rounds(400);
		expect(t.c.status().swap).toBeNull();
		const again = await failOnce();
		expect(first).toBeLessThanOrEqual(11_000);
		expect(again).toBeLessThanOrEqual(11_000);
	});

	test("a common-target failure backs off before the next attempt", async () => {
		const t = setup();
		t.w.cellular("modem-a");
		await t.rounds(4);
		expect(t.role("wlan1")).toBe("holder");
		// Everything loses half: the receiver side, not the candidate.
		t.w.link("wlan1").deliver = 0.5;
		t.w.link("wlan2").deliver = 0.5;
		const cell = t.w.others.get("modem-a");
		if (cell) cell.deliver = 0.5;
		for (
			let i = 0;
			i < 20 && t.c.status().lastSwapOutcome !== "common-target";
			i++
		)
			await t.rounds(1);
		expect(t.c.status().lastSwapOutcome).toBe("common-target");
		const at = t.w.now;
		while (t.w.now < at + 9_000) {
			await t.rounds(1);
			expect(t.c.status().swap).toBeNull();
		}
	});

	test("a snapshot that is not newer than the last is no new sample", async () => {
		const w = new World();
		w.station("wlan1", AP1);
		w.station("wlan2", AP2);
		// The coordinator steps every half second; the sender has a new sample
		// only every second and hands out the last one in between.
		w.sampleEvery = 2;
		const c = new RoamingCoordinator(w.ports(), {
			radios: [{ ifname: "wlan1" }, { ifname: "wlan2" }],
		});
		const half = async (n: number) => {
			for (let i = 0; i < n; i++) {
				w.now += 500;
				await c.step();
			}
		};
		await half(8);
		w.signal("wlan1", -78);
		let promoted = false;
		for (let i = 0; i < 30 && !promoted; i++) {
			await half(1);
			promoted =
				c.status().radios.find((r) => r.ifname === "wlan2")?.role === "holder";
		}
		expect(promoted).toBe(true);
	});

	test("a dead radio is recalled even while the holder only holds steady", async () => {
		const t = await settled();
		await t.rounds(5);
		t.w.link("wlan1").deliver = 0;
		t.w.link("wlan1").ageMs = 5_000;
		await t.rounds(1);
		expect(t.role("wlan2")).toBe("holder");
		// The new holder carries only 1.3 x the encoder rate: steady, no proven
		// headroom, so no live carrier would be withdrawn. A dead one still is.
		t.w.rates.set("wlan2", { attributedBps: 1_300_000, encoderBps: 1_000_000 });
		await t.rounds(25);
		expect(t.w.bond).toContain("hold:wlan1");
	});

	test("a completed handover clears the new holder's failure record", async () => {
		const t = await settled();
		await t.rounds(3);
		const waitFor = async (outcome: string) => {
			for (
				let i = 0;
				i < 40 && !t.c.status().lastSwapOutcome?.startsWith(outcome);
				i++
			)
				await t.rounds(1);
			expect(t.c.status().lastSwapOutcome).toStartWith(outcome);
		};
		// wlan2 fails once: its BSSID's count is 1.
		t.w.link("wlan2").deliver = 0.6;
		t.w.signal("wlan1", -78);
		await waitFor("candidate-failed:wlan2");
		// Then it recovers and takes over.
		t.w.link("wlan2").deliver = 1;
		await waitFor("released:wlan2");
		// And hands back to wlan1 when it fades in turn.
		t.w.signal("wlan1", -55);
		t.w.signal("wlan2", -78);
		await waitFor("released:wlan1");
		// Failing again soon after costs only the first step: the success
		// cleared the record.
		t.w.signal("wlan2", -55);
		t.w.link("wlan2").deliver = 0.6;
		t.w.signal("wlan1", -78);
		await waitFor("candidate-failed:wlan2");
		const failedAt = t.w.now;
		for (let i = 0; i < 40 && t.c.status().swap === null; i++)
			await t.rounds(1);
		expect(t.w.now - failedAt).toBeLessThanOrEqual(11_000);
	});

	test("an idle but healthy diverse assister is not judged dead and keeps carrying", async () => {
		const t = await settled();
		await t.rounds(5);
		const l = t.w.link("wlan2");
		// The sender puts nothing on it, so no SRTLA ACK comes back either.
		l.pps = 0;
		l.over = { weak: true, weakReason: "no_traffic" };
		for (let i = 0; i < 40; i++) {
			l.ageMs = (l.ageMs ?? 0) + 1_000;
			await t.rounds(1);
		}
		expect(t.w.bond).not.toContain("hold:wlan2");
		expect(t.role("wlan2")).toBe("assister");
	});

	test("a sole dead holder with no delivering replacement keeps the holder label", async () => {
		const t = await settled();
		await t.rounds(5);
		// wlan2 still gets ACKs (so wlan1 is judged dead) but delivers only
		// half, so it is no replacement.
		t.w.link("wlan2").deliver = 0.5;
		await t.rounds(5);
		t.w.link("wlan1").deliver = 0;
		t.w.link("wlan1").ageMs = 5_000;
		await t.rounds(3);
		expect(t.role("wlan1")).toBe("holder");
		expect(t.c.status().radios.filter((r) => r.role === "holder").length).toBe(
			1,
		);
	});

	test("a dead verdict is not acted on after arrival reports stop", async () => {
		const t = await settled();
		await t.rounds(5);
		t.w.link("wlan1").deliver = 0;
		t.w.link("wlan1").ageMs = 5_000;
		await t.rounds(1);
		expect(t.role("wlan1")).toBe("assister");
		// Reports stop inside the grace period: nothing is known any more.
		t.w.reports = false;
		t.w.rates.set("wlan2", { attributedBps: 1_300_000, encoderBps: 1_000_000 });
		await t.rounds(30);
		expect(t.w.bond).not.toContain("hold:wlan1");
	});

	test("a dead verdict is not acted on while the sender's reports are frozen", async () => {
		const t = await settled();
		await t.rounds(5);
		t.w.link("wlan1").deliver = 0;
		t.w.link("wlan1").ageMs = 5_000;
		await t.rounds(1);
		expect(t.role("wlan1")).toBe("assister");
		// The port keeps answering with the same sample: no new evidence.
		t.w.frozen = true;
		t.w.rates.set("wlan2", { attributedBps: 1_300_000, encoderBps: 1_000_000 });
		await t.rounds(30);
		expect(t.w.bond).not.toContain("hold:wlan1");
	});

	test("a radio judged dead is no continuity candidate", async () => {
		const w = new World();
		w.station("wlan1", AP1, -45);
		w.station("wlan2", AP2, -50); // dead below, ranks first by signal
		w.station("wlan3", AP3, -60);
		const c = new RoamingCoordinator(w.ports(), {
			radios: [{ ifname: "wlan1" }, { ifname: "wlan2" }, { ifname: "wlan3" }],
		});
		const step = async (n = 1) => {
			for (let i = 0; i < n; i++) {
				w.now += 1_000;
				await c.step();
			}
		};
		await step(6);
		w.link("wlan2").deliver = 0;
		w.link("wlan2").ageMs = 5_000;
		await step(1);
		w.signal("wlan1", -78);
		await step(3);
		expect(c.status().swap?.candidate).toBe("wlan3");
	});
});
