import { describe, expect, test } from "bun:test";
import type { SenderLinkStats, SenderStats } from "@ceraui/srtla-send/control";
import { hasArrivalReports, snapshotOf, toLinkSample } from "./sender-links.ts";

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

	test("any sender gating flag marks the link held back, and names it", () => {
		for (const flag of [
			"stall_gated",
			"weak",
			"sole_carrier_excluded",
			"in_flight_cap_active",
		] as const) {
			const sample = toLinkSample(link({ [flag]: true }));
			expect(sample?.gated).toBe(true);
			expect(sample?.gatedBy).toBe(flag);
		}
		expect(toLinkSample(link({ weak: false }))?.gated).toBe(false);
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
