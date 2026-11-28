import { describe, expect, test } from "bun:test";
import type { SenderLinkStats, SenderStats } from "@ceraui/srtla-send/control";
import {
	HOLD_OUT_EVIDENCE_MS,
	hasArrivalReports,
	heldBack,
	holderFailing,
	holderSidelined,
	holdOutConfirmed,
	RESTORE_EVIDENCE_MS,
	restoreConfirmed,
	snapshotOf,
	toLinkSample,
} from "./sender-links.ts";

const link = (over: Partial<SenderLinkStats>): SenderLinkStats => ({
	conn_id: 0,
	connected: true,
	timed_out: false,
	window: 8192,
	in_flight: 0,
	rtt_ms: 30,
	nak_count: 0,
	bitrate_bytes_per_sec: 0,
	base_score: 0,
	quality_multiplier: 1,
	data_packets_queued_total: 100,
	srtla_ack_entries_total: 90,
	srtla_ack_epoch: 3,
	...over,
});

const stats = (links: SenderLinkStats[], extra: Partial<SenderStats> = {}) =>
	({ mode: "enhanced", links, ...extra }) as SenderStats;

const radios = [
	{ ifname: "wlan1", addresses: ["192.168.1.10"] },
	{ ifname: "wlan2", addresses: ["192.168.2.10"] },
];

describe("arrival reports", () => {
	test("are detected by the epoch and totals, not the age", () => {
		expect(hasArrivalReports(link({}))).toBe(true);
		expect(hasArrivalReports(link({ srtla_ack_epoch: undefined }))).toBe(false);
		expect(hasArrivalReports(link({ last_srtla_ack_age_ms: undefined }))).toBe(
			true,
		);
	});

	test("a sender without them gives no snapshot", () => {
		const old = link({
			srtla_ack_epoch: undefined,
			data_packets_queued_total: undefined,
			srtla_ack_entries_total: undefined,
		});
		expect(snapshotOf(stats([old]), radios, 0)).toBeUndefined();
	});

	test("the age is null before the first ACK", () => {
		expect(toLinkSample(link({}))?.ageMs).toBeNull();
		expect(toLinkSample(link({ last_srtla_ack_age_ms: 40 }))?.ageMs).toBe(40);
	});

	test("the sender's flags map onto the two roles", () => {
		const sample = (over: Partial<SenderLinkStats>) =>
			toLinkSample(link(over)) as NonNullable<ReturnType<typeof toLinkSample>>;
		// Held back: a candidate can't be measured.
		expect(heldBack(sample({ stall_gated: true }))).toBe("stall_gated");
		expect(heldBack(sample({ sole_carrier_excluded: true }))).toBe(
			"sole_carrier_excluded",
		);
		expect(heldBack(sample({ weak: true, weak_reason: "low_share" }))).toBe(
			"weak: low_share",
		);
		// The in-flight cap is a per-tick queueing bound, not a hold-back.
		expect(heldBack(sample({ in_flight_cap_active: true }))).toBeNull();
		expect(holderFailing(sample({ in_flight_cap_active: true }))).toBeNull();
		expect(sample({ in_flight_cap_active: true }).inFlightCapActive).toBe(true);
		// The sender giving up on a holder's path.
		expect(holderFailing(sample({ stall_gated: true }))).toBe("stall_gated");
		expect(holderFailing(sample({ sole_carrier_excluded: true }))).toBe(
			"sole_carrier_excluded",
		);
		expect(holderFailing(sample({ weak: true, weak_reason: "high_rtt" }))).toBe(
			"weak: high_rtt",
		);
		expect(holderFailing(sample({ cc_loss_degraded: true }))).toBe(
			"cc_loss_degraded",
		);
		// The sender only preferring a sibling.
		for (const weak_reason of ["low_share", "no_traffic"]) {
			const s = sample({ weak: true, weak_reason });
			expect(holderFailing(s)).toBeNull();
			expect(holderSidelined(s)).toBe(`weak: ${weak_reason}`);
		}
		expect(
			holderSidelined(sample({ weak: true, weak_reason: "high_rtt" })),
		).toBeNull();
		expect(heldBack(sample({}))).toBeNull();
		expect(holderFailing(sample({}))).toBeNull();
		expect(holderSidelined(sample({}))).toBeNull();
	});

	test("the observed bitrate is kept in bits per second", () => {
		expect(
			toLinkSample(link({ bitrate_bytes_per_sec: 1_000 }))?.bitrateBps,
		).toBe(8_000);
	});

	test("the CC state is kept, null when not reported", () => {
		expect(toLinkSample(link({ cc_state: "holding" }))?.ccState).toBe(
			"holding",
		);
		expect(toLinkSample(link({}))?.ccState).toBeNull();
	});

	test("a zero capacity estimate means none", () => {
		expect(toLinkSample(link({ cc_target_bps: 0 }))?.ccTargetBps).toBeNull();
		expect(toLinkSample(link({ cc_target_bps: 5 }))?.ccTargetBps).toBe(5);
	});
});

describe("mapping links to radios", () => {
	test("by iface first, then by source address", () => {
		const snap = snapshotOf(
			stats([
				link({ conn_id: 0, iface: "wlan1", ip: "192.168.2.10" }),
				link({ conn_id: 1, ip: "192.168.2.10", srtla_ack_epoch: 9 }),
			]),
			radios,
			5,
		);
		expect(snap?.radios.get("wlan1")?.epoch).toBe(3);
		expect(snap?.radios.get("wlan2")?.epoch).toBe(9);
		expect(snap?.at).toBe(5);
	});

	test("a radio claimed by two links is left out", () => {
		const snap = snapshotOf(
			stats([
				link({ conn_id: 0, ip: "192.168.1.10" }),
				link({ conn_id: 1, iface: "wlan1" }),
			]),
			radios,
			0,
		);
		expect(snap?.radios.has("wlan1")).toBe(false);
	});

	test("a link matching two radios is left out", () => {
		const shared = [
			{ ifname: "wlan1", addresses: ["10.0.0.5"] },
			{ ifname: "wlan2", addresses: ["10.0.0.5"] },
		];
		const snap = snapshotOf(stats([link({ ip: "10.0.0.5" })]), shared, 0);
		expect(snap?.radios.size).toBe(0);
		expect(snap?.others.size).toBe(0);
	});

	test("unmapped links are kept by a stable key for the witness rule", () => {
		const snap = snapshotOf(
			stats([
				link({ conn_id: 0, link_id: "modem-a", iface: "wwan0" }),
				link({ conn_id: 1, ip: "100.64.0.2" }),
				link({ conn_id: 2 }),
			]),
			radios,
			0,
		);
		expect([...(snap?.others.keys() ?? [])]).toEqual([
			"modem-a",
			"100.64.0.2",
			"conn:2",
		]);
	});

	test("the negotiated latency is kept when known", () => {
		expect(
			snapshotOf(stats([link({})], { negotiated_latency_ms: 2000 }), radios, 0)
				?.negotiatedLatencyMs,
		).toBe(2000);
		expect(
			snapshotOf(stats([link({})], { negotiated_latency_ms: 0 }), radios, 0)
				?.negotiatedLatencyMs,
		).toBeNull();
	});
});

describe("evidence for hold-outs and restores", () => {
	test("the deadlines are explicit", () => {
		expect(HOLD_OUT_EVIDENCE_MS).toBe(5_000);
		expect(RESTORE_EVIDENCE_MS).toBe(10_000);
	});

	test("a hold-out is confirmed once no link maps to the radio, even ambiguously", () => {
		const present = snapshotOf(
			stats([
				link({ ip: "192.168.1.10" }),
				link({ conn_id: 1, ip: "100.64.0.2" }),
			]),
			radios,
			0,
		);
		expect(present && holdOutConfirmed(present, "wlan1")).toBe(false);
		const gone = snapshotOf(
			stats([link({ conn_id: 1, ip: "100.64.0.2" })]),
			radios,
			0,
		);
		expect(gone && holdOutConfirmed(gone, "wlan1")).toBe(true);
		// Two links claiming the radio leave it unmapped, but not held out.
		const twice = snapshotOf(
			stats([
				link({ ip: "192.168.1.10" }),
				link({ conn_id: 1, iface: "wlan1" }),
			]),
			radios,
			0,
		);
		expect(twice?.radios.has("wlan1")).toBe(false);
		expect(twice && holdOutConfirmed(twice, "wlan1")).toBe(false);
	});

	test("one link matching two radios blocks a hold-out on both", () => {
		const shared = [
			{ ifname: "wlan1", addresses: ["10.0.0.5"] },
			{ ifname: "wlan2", addresses: ["10.0.0.5"] },
		];
		const snap = snapshotOf(stats([link({ ip: "10.0.0.5" })]), shared, 0);
		expect(snap?.radios.size).toBe(0);
		expect(snap && holdOutConfirmed(snap, "wlan1")).toBe(false);
		expect(snap && holdOutConfirmed(snap, "wlan2")).toBe(false);
	});

	test("a restore needs a new epoch, registration and a first ACK", () => {
		const snap = (over: Partial<SenderLinkStats>) =>
			snapshotOf(
				stats([link({ ip: "192.168.1.10", ...over })]),
				radios,
				0,
			) as NonNullable<ReturnType<typeof snapshotOf>>;
		const ok = { srtla_ack_epoch: 8, last_srtla_ack_age_ms: 50 };
		expect(restoreConfirmed(snap(ok), "wlan1", 3)).toBe(true);
		expect(restoreConfirmed(snap(ok), "wlan1", 8)).toBe(false);
		expect(
			restoreConfirmed(
				snap({ ...ok, last_srtla_ack_age_ms: undefined }),
				"wlan1",
				3,
			),
		).toBe(false);
		expect(
			restoreConfirmed(snap({ ...ok, connected: false }), "wlan1", 3),
		).toBe(false);
		expect(restoreConfirmed(snap({ ...ok, timed_out: true }), "wlan1", 3)).toBe(
			false,
		);
		expect(restoreConfirmed(snap(ok), "wlan2", 3)).toBe(false);
	});
});
