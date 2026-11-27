import { describe, expect, test } from "bun:test";
import {
	COOLDOWN_BASE_MS,
	deliveringStayers,
	type JournalEvent,
	ROAM_DWELL_MS,
	RoamingObserver,
	type RoundInput,
} from "./observer.ts";
import type { RadioView } from "./radio-port.ts";
import type { LinkSample, Snapshot } from "./sender-links.ts";
import type { SenderView } from "./sender-port.ts";

const MAC = "02:00:00:00:e0:01";
const ID = `${MAC}/51:5:/devices/pci/phy5`;
const AP1 = "aa:00:00:00:00:01";
const AP2 = "aa:00:00:00:00:02";

const base: LinkSample = {
	epoch: 1,
	connected: true,
	timedOut: false,
	queued: 0,
	entries: 0,
	ageMs: 100,
	rttMs: 30,
	bitrateBps: 0,
	stallGated: false,
	soleCarrierExcluded: false,
	weak: false,
	weakReason: null,
	inFlightCapActive: false,
	ccLossDegraded: false,
	ccTargetBps: null,
	ccState: null,
	ccLossPermille: null,
};

const READY: SenderView = {
	reachable: true,
	arrivalReports: true,
	standby: true,
};

const radio = (over: Partial<RadioView> = {}): RadioView => ({
	id: ID,
	permanentMac: MAC,
	ifname: "wlan1",
	station: true,
	reserved: false,
	link: { bssid: AP1, ssid: "venue", signalDbm: -60 },
	...over,
});

/**
 * A sender snapshot at second `t`: wlan1 and a stayer (wwan0) each queue
 * 30 packets a second; the stayer's receiver acknowledges `deliver` of them.
 */
function snap(
	t: number,
	opts: {
		deliver?: number;
		radioMapped?: boolean;
		unmapped?: boolean;
		stayer?: boolean;
	} = {},
): Snapshot {
	const radios = new Map<string, LinkSample>();
	if (opts.radioMapped !== false)
		radios.set("wlan1", { ...base, queued: 30 * t, entries: 30 * t });
	if (opts.stayer !== false)
		radios.set("wwan0", {
			...base,
			queued: 30 * t,
			entries: Math.floor(30 * t * (opts.deliver ?? 1)),
		});
	const others = new Map<string, LinkSample>();
	if (opts.unmapped) others.set("conn:9", base);
	return {
		at: t * 1_000,
		radios,
		others,
		negotiatedLatencyMs: null,
		claimed: new Set(radios.keys()),
	};
}

type Step = Partial<Omit<RoundInput, "at">> & {
	radio?: Partial<RadioView> | null;
	snapOpts?: Parameters<typeof snap>[1];
};

/** Run one round per second from `from` to `to` with the same inputs. */
function rounds(
	o: RoamingObserver,
	from: number,
	to: number,
	step: Step | ((t: number) => Step) = {},
): JournalEvent[] {
	const events: JournalEvent[] = [];
	for (let t = from; t <= to; t++) {
		const s = typeof step === "function" ? step(t) : step;
		events.push(
			...o.round({
				at: t * 1_000,
				radios: s.radio === null ? [] : [radio(s.radio)],
				skipped: s.skipped ?? [],
				snapshot: "snapshot" in s ? s.snapshot : snap(t, s.snapOpts),
				sender: s.sender ?? READY,
			}),
		);
	}
	return events;
}

const fading = { link: { bssid: AP1, ssid: "venue", signalDbm: -75 } };
const status = (o: RoamingObserver) => o.status()?.radios[0];

describe("a healthy radio", () => {
	test("is watched: no decision, no blocker", () => {
		const o = new RoamingObserver();
		const events = rounds(o, 1, 12);
		expect(status(o)).toMatchObject({
			condition: "headroom",
			decision: "none",
			blockers: [],
			wouldNudges: 0,
		});
		expect(events.map((e) => e.event)).toEqual(["radio-added"]);
	});
});

describe("a fading radio", () => {
	test("with every condition met: would nudge, once per cooldown", () => {
		const o = new RoamingObserver();
		rounds(o, 1, 5);
		const events = rounds(o, 6, 12, { radio: fading });
		expect(status(o)).toMatchObject({
			condition: "fade",
			stayers: ["wwan0"],
			wouldNudges: 1,
		});
		const nudges = events.filter((e) => e.event === "would-nudge");
		expect(nudges).toHaveLength(1);
		expect(nudges[0]).toMatchObject({
			radio: MAC,
			ifname: "wlan1",
			bssid: AP1,
			stayers: ["wwan0"],
		});
		expect(events.map((e) => e.event)).toContain("fade-start");
	});

	test("a steep slope above the level floor is a fade too", () => {
		const o = new RoamingObserver();
		const events = rounds(o, 1, 20, (t) => ({
			radio: { link: { bssid: AP1, ssid: "venue", signalDbm: -50 - 1.5 * t } },
		}));
		const first = events.find((e) => e.event === "fade-start");
		expect(first).toBeDefined();
		// It fired on the slope while the level was still above -70 dBm.
		expect((first as { signalDbm: number }).signalDbm).toBeGreaterThan(-70);
	});

	test("the cooldown doubles while the radio stays on its access point", () => {
		const o = new RoamingObserver();
		rounds(o, 1, 5);
		const first = rounds(o, 6, 6 + COOLDOWN_BASE_MS / 1_000, { radio: fading });
		expect(first.filter((e) => e.event === "would-nudge")).toHaveLength(2);
		const second = rounds(o, 22, 22 + COOLDOWN_BASE_MS / 1_000, {
			radio: fading,
		});
		// The second gap is 30 s: nothing within the next 15 s.
		expect(second.filter((e) => e.event === "would-nudge")).toHaveLength(0);
		expect(status(o)?.blockers).toEqual(["cooldown"]);
	});

	test("a radio that moved by itself is recorded and left alone for the dwell", () => {
		const o = new RoamingObserver();
		rounds(o, 1, 5);
		const events = rounds(o, 6, 8, (t) => ({
			radio:
				t < 8
					? fading
					: { link: { bssid: AP2, ssid: "venue", signalDbm: -75 } },
		}));
		expect(events.find((e) => e.event === "roamed")).toMatchObject({
			from: AP1,
			to: AP2,
		});
		expect(status(o)).toMatchObject({ roams: 1, blockers: ["cooldown"] });
		const later = rounds(o, 9, 7 + ROAM_DWELL_MS / 1_000, {
			radio: { link: { bssid: AP2, ssid: "venue", signalDbm: -75 } },
		});
		expect(later.filter((e) => e.event === "would-nudge")).toHaveLength(0);
		const after = rounds(
			o,
			8 + ROAM_DWELL_MS / 1_000,
			9 + ROAM_DWELL_MS / 1_000,
			{
				radio: { link: { bssid: AP2, ssid: "venue", signalDbm: -75 } },
			},
		);
		expect(after.filter((e) => e.event === "would-nudge")).toHaveLength(1);
	});
});

describe("what keeps a fading radio from a nudge", () => {
	const blockersFor = (step: Step) => {
		const o = new RoamingObserver();
		rounds(o, 1, 5);
		rounds(o, 6, 12, {
			...step,
			radio: { ...fading, ...(step.radio ?? {}) },
		});
		return status(o)?.blockers;
	};

	test("a hotspot on the radio or its phy", () => {
		expect(blockersFor({ radio: { reserved: true } })).toEqual(["hotspot"]);
		expect(blockersFor({ radio: { reserved: null } })).toEqual([
			"hotspot-unknown",
		]);
	});

	test("not activated as a station", () => {
		expect(blockersFor({ radio: { station: false } })).toEqual([
			"not-a-station",
		]);
	});

	test("no sender evidence", () => {
		expect(blockersFor({ snapshot: undefined })).toContain(
			"no-sender-evidence",
		);
	});

	test("a sender link that maps to no interface", () => {
		expect(blockersFor({ snapOpts: { unmapped: true } })).toEqual([
			"unmapped-sender-link",
		]);
	});

	test("the radio's own link not mapped", () => {
		expect(blockersFor({ snapOpts: { radioMapped: false } })).toEqual([
			"radio-link-not-mapped",
		]);
	});

	test("no other link that delivers", () => {
		expect(blockersFor({ snapOpts: { stayer: false } })).toEqual([
			"no-delivering-stayer",
		]);
		expect(blockersFor({ snapOpts: { deliver: 0.5 } })).toEqual([
			"no-delivering-stayer",
		]);
	});

	test("a sender without the standby, or not known to have it", () => {
		expect(blockersFor({ sender: { ...READY, standby: false } })).toEqual([
			"sender-without-standby",
		]);
		expect(blockersFor({ sender: { ...READY, standby: null } })).toEqual([
			"sender-without-standby",
		]);
	});

	test("the blocked reasons are journalled when they change, not every round", () => {
		const o = new RoamingObserver();
		rounds(o, 1, 5);
		const events = rounds(o, 6, 20, {
			radio: { ...fading, reserved: true },
		});
		expect(events.filter((e) => e.event === "blocked")).toHaveLength(1);
	});
});

describe("radios by physical identity", () => {
	test("a radio replugged under the same name inherits no cooldown", () => {
		const o = new RoamingObserver();
		rounds(o, 1, 5);
		rounds(o, 6, 12, { radio: fading });
		expect(status(o)?.wouldNudges).toBe(1);
		const events = rounds(o, 13, 13, {
			radio: { ...fading, id: `${MAC}/52:5:/devices/pci/phy5` },
		});
		expect(events.map((e) => e.event)).toEqual(
			expect.arrayContaining(["radio-added", "radio-gone"]),
		);
		// The old radio would still be cooling down (15 s from second 6); the
		// new one inherits nothing and qualifies at once.
		expect(status(o)).toMatchObject({
			wouldNudges: 1,
			lastWouldNudgeAt: 13_000,
			roams: 0,
		});
	});

	test("skipped radios are reported as given", () => {
		const o = new RoamingObserver();
		rounds(o, 1, 1, {
			radio: null,
			skipped: [{ ifname: "wlan9", reason: "not-admitted" }],
		});
		expect(o.status()?.skipped).toEqual([
			{ ifname: "wlan9", reason: "not-admitted" },
		]);
		expect(o.status()?.radios).toEqual([]);
	});
});

describe("stayers", () => {
	test("a missing sender read breaks the span: no stayer until it is complete again", () => {
		const snaps = [1, 2, 3, 4, 5, 6].map((t) => snap(t));
		expect(deliveringStayers(snaps, "wlan1")).toEqual(["wwan0"]);
		expect(deliveringStayers(snaps.slice(-2), "wlan1")).toEqual([]);
		const o = new RoamingObserver();
		rounds(o, 1, 5);
		rounds(o, 6, 6, { snapshot: undefined, radio: fading });
		rounds(o, 7, 8, { radio: fading });
		expect(status(o)?.blockers).toContain("no-delivering-stayer");
	});

	test("the radio itself is never its own stayer", () => {
		const snaps = [1, 2, 3, 4, 5, 6].map((t) => snap(t, { stayer: false }));
		expect(deliveringStayers(snaps, "wlan1")).toEqual([]);
		expect(deliveringStayers(snaps, "wlan2")).toEqual(["wlan1"]);
	});
});
