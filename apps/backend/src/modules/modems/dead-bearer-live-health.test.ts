import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { SenderStats } from "@ceraui/srtla-send/control";
import type { Telemetry } from "@ceraui/srtla-send/telemetry";
import { resetClatTranslationStateForTest } from "../network/clat-translation.ts";
import type { ProbeCandidate } from "../network/connectivity-candidates.ts";
import type { NetworkInterface } from "../network/network-interfaces.ts";
import {
	UPLINK_HEALTH_CONFIG,
	UplinkHealthEngine,
	type UplinkHealthOutcome,
	type UplinkHealthRecord,
} from "../network/uplink-health/model.ts";
import { UplinkHealthRuntimeCore } from "../network/uplink-health/runtime-core.ts";
import type { BondEntry } from "../streaming/bind-map.ts";
import {
	clearBindMapReport,
	noteWriterBindMapReport,
	resetBindMapReportListeners,
} from "../streaming/bind-map-disposition.ts";
import { setForwardActive } from "../streaming/forward-activity.ts";
import { resetLifecycleInterlock } from "../streaming/lifecycle-admission.ts";
import { setLinkIdentityDetailResolverForTest } from "../streaming/link-registry.ts";
import {
	buildLinkTelemetry,
	ingestTelemetryForTest,
	linkCarryingState,
	linkQuietForMs,
	registerSrtlaBond,
	setCarryingClockForTest,
	setIfaceResolverForTest,
	setTelemetryClockForTest,
	startLinkTelemetry,
	stopLinkTelemetry,
} from "../streaming/link-telemetry.ts";
import { resetRecoveryBarrier } from "../streaming/recovery-barrier.ts";
import {
	DEAD_BEARER_ALONE_HOLD_MS,
	DEAD_BEARER_HOLD_MS,
	runDeadBearerRecovery,
	setDeadBearerDepsForTest,
} from "./dead-bearer-recovery.ts";
import {
	getModemIds,
	type Modem,
	removeModem,
	setModem,
} from "./modems-state.ts";

/*
  Mid-stream recovery end to end: sender snapshots go through the real
  telemetry module once a second, the real uplink health core runs its 5 s
  round on that telemetry (the probe is the only fake), and the dead-bearer
  poll runs every 30 s against the health records the core produced.

  A black-holed bearer looks healthy to the passive path: the sender keeps a
  fresh row with its last RTT and no NAKs. Only its byte counter stands still.
  The health record therefore has to come from the link's own probe while the
  sender reads it as carrying nothing, or #146 never sees an outage.
*/

const UUID = "9b0c1f3e-4f4f-4a51-9a51-3a0d1b7e2c11";
const KEY = "platform-xhci-hcd.0.auto-usb-0:1.4";
const SENDER_EPOCH = 1_790_000_000_000;
const HEALTH_MS = 5_000;
const POLL_MS = 30_000;

const MODEM: BondEntry = {
	ip: "10.64.0.2",
	iface: "wwan0",
	linkId: "lnk_modem00000000000",
};
const ETH: BondEntry = {
	ip: "192.168.1.20",
	iface: "eth0",
	linkId: "lnk_eth0000000000000",
};

type Conn = Partial<Telemetry["connections"][number]> & {
	iface?: string;
	link_id?: string;
	/** Reported over the control socket; absent on the stats-file path. */
	stall_gated?: boolean;
};

/** Monotonic ms since the test began; drives the poll and the dwell. */
let now = 0;
/** Wall clock for health and telemetry timestamps. */
let wall = 0;
let calls: string[];
let engine: UplinkHealthEngine;
let health: UplinkHealthRuntimeCore;
let probes: string[];
/** The probe's answer per interface at the current time. */
let probeAnswer: (iface: string, t: number) => UplinkHealthOutcome;

const interfaces: Record<string, NetworkInterface> = {
	wwan0: { ip: MODEM.ip, error: 0, tp: 0, txb: 0 },
	eth0: { ip: ETH.ip, error: 0, tp: 0, txb: 0 },
};

function snapshot(connections: Conn[]): Telemetry {
	return {
		schema_version: 1,
		last_updated_ms: SENDER_EPOCH + now,
		connections: connections.map((c, i) => ({
			conn_id: String(i),
			rtt_ms: 80,
			nak_count: 0,
			weight_percent: 50,
			window: 1000,
			in_flight: 0,
			bitrate_bps: 0,
			...c,
		})),
	} as Telemetry;
}

function modem(): Modem {
	return {
		ifname: "wwan0",
		name: "Test modem",
		sim_network: "Test",
		network_type: { supported: {}, active: null },
		config: {
			conn: UUID,
			autoconfig: false,
			apn: "internet",
			username: "",
			password: "",
			roaming: false,
			network: "",
		},
	};
}

function startStream(entries: readonly BondEntry[]): void {
	registerSrtlaBond(entries);
	noteWriterBindMapReport("bind-map-passed", entries);
	startLinkTelemetry(
		"/tmp/unused-stats.json",
		entries.map((e) => e.ip),
		{ watch: () => ({ stop: () => {} }) },
	);
}

const states = new Map<string, string>();
/** wwan0 read "not carrying" after 90 s at least once (see streamUntil). */
let notCarryingSeen = false;

/**
 * Advance second by second until `until`, feeding the sender snapshot that
 * `rows(t)` returns, running a health round every 5 s and the dead-bearer
 * poll every 30 s. Returns the reconnect times; `states` collects each
 * interface's health state per round ("U", "g" or "D").
 */
async function streamUntil(
	until: number,
	rows: (t: number) => Conn[] | undefined,
): Promise<number[]> {
	const at: number[] = [];
	while (now < until) {
		now += 1_000;
		wall += 1_000;
		const next = rows(now);
		if (next !== undefined) {
			// Rows that say whether they are stall-gated arrive as the sender's
			// control-socket stats would; others as the stats file.
			const gated = next.map((row) => row.stall_gated);
			const plain = next.map(({ stall_gated: _gated, ...row }) => row);
			ingestTelemetryForTest(
				snapshot(plain),
				gated.some((g) => g !== undefined)
					? ({
							mode: "enhanced",
							links: gated.map((g) => ({ stall_gated: g === true })),
						} as unknown as SenderStats)
					: null,
			);
		}
		if (now > 90_000 && linkCarryingState("wwan0") === "not_carrying")
			notCarryingSeen = true;
		if (now % HEALTH_MS === 0) {
			await health.tick();
			for (const iface of Object.keys(interfaces)) {
				const state = engine.get(iface)?.state;
				const mark =
					state === "up"
						? "U"
						: state === "down"
							? "D"
							: state === "degraded"
								? "g"
								: "-";
				states.set(iface, (states.get(iface) ?? "") + mark);
			}
		}
		if (now % POLL_MS !== 0) continue;
		const before = calls.length;
		await runDeadBearerRecovery();
		if (calls.length > before) at.push(now);
	}
	return at;
}

beforeEach(() => {
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	setForwardActive(false);
	now = 0;
	wall = 1_800_000_000_000;
	calls = [];
	probes = [];
	states.clear();
	notCarryingSeen = false;
	probeAnswer = () => "success";
	resetClatTranslationStateForTest();
	setTelemetryClockForTest(() => wall);
	setCarryingClockForTest(() => now);
	setLinkIdentityDetailResolverForTest(() => ({}));
	setIfaceResolverForTest(() => undefined);
	for (const id of getModemIds()) removeModem(id);
	setModem(2, modem());
	engine = new UplinkHealthEngine();
	health = new UplinkHealthRuntimeCore(
		{
			now: () => wall,
			interfaces: () => interfaces,
			streaming: () => true,
			telemetry: buildLinkTelemetry,
			quietForMs: linkQuietForMs,
			monotonicNow: () => now,
			resolveTarget: async (family) =>
				family === 4 ? "192.0.2.204" : undefined,
			probe: async (candidate) => {
				probes.push(`${now / 1000}:${candidate.name}`);
				return probeAnswer(candidate.name, now);
			},
			publish: () => {},
			exclusionReason: (entry) => (entry?.ip ? undefined : "no address"),
			candidates: (all) =>
				Object.entries(all).flatMap(([name, entry]): ProbeCandidate[] =>
					entry.ip
						? [
								{
									name,
									ip: entry.ip,
									binding: { kind: "device", ifname: name },
								},
							]
						: [],
				),
			identity: (iface) => ({
				kind: iface === "eth0" ? "ethernet" : "cellular",
			}),
		},
		engine,
	);
	setDeadBearerDepsForTest({
		now: () => now,
		wallNow: () => wall,
		ids: () => getModemIds(),
		stableKey: (id) => (id === 2 ? KEY : undefined),
		health: (iface) => engine.get(iface),
		healthList: () => engine.list(),
		clatTun: () => undefined,
		clatParent: () => undefined,
		streaming: () => true,
		readAutoconnect: async () => "no",
		automaticReady: async () => true,
		nmState: async () => "100",
		mmState: async () => "connected",
		lastDial: () => undefined,
		noteDial: () => {},
		disconnect: async (uuid) => {
			calls.push(`down ${uuid}`);
		},
		connect: async (uuid) => {
			calls.push(`up ${uuid}`);
			return true;
		},
	});
});

afterEach(() => {
	health.dispose();
	setDeadBearerDepsForTest(null);
	stopLinkTelemetry();
	clearBindMapReport();
	resetBindMapReportListeners();
	resetClatTranslationStateForTest();
	setTelemetryClockForTest(null);
	setCarryingClockForTest(null);
	setLinkIdentityDetailResolverForTest(null);
	setIfaceResolverForTest(null);
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	for (const id of getModemIds()) removeModem(id);
});

function probedIfaces(): string[] {
	return [...new Set(probes.map((probe) => probe.split(":")[1]))].sort();
}

function record(iface: string): UplinkHealthRecord | undefined {
	return engine.get(iface);
}

describe("while streaming, a bearer that carries nothing is judged by its own probe", () => {
	test("a black-holed modem goes down on its probes and is reconnected after the hold", async () => {
		startStream([MODEM, ETH]);
		// Black hole from 20 s until the reconnect: the modem's counter stops,
		// its row stays fresh with the RTT it last had and no NAKs.
		const blackholeAt = 20_000;
		const dead = (t: number) => t > blackholeAt && calls.length === 0;
		probeAnswer = (iface, t) =>
			iface === "wwan0" && dead(t) ? "failure" : "success";
		let bytes = 0;
		const at = await streamUntil(600_000, (t) => {
			if (!dead(t)) bytes += 200_000;
			return [
				{
					link_id: MODEM.linkId,
					bytes_sent_total: bytes,
					bitrate_bps: dead(t) ? 0 : 1_600_000,
				},
				{ link_id: ETH.linkId, bytes_sent_total: t * 500, bitrate_bps: 4e6 },
			];
		});
		// Not carrying from 25 s and quiet for 10 s by the 30 s round, so probed
		// from there: three failed rounds (30, 35, 40 s) take it down, six (55 s)
		// make an outage the 60 s poll sees (quiet 40 s, more than the 30 s
		// streak lead), and the 60 s hold ends at the 120 s poll.
		expect(states.get("wwan0")?.slice(0, 8)).toBe("UUUUUUUD");
		expect(at).toEqual([60_000 + DEAD_BEARER_HOLD_MS]);
		expect(calls).toEqual([`down ${UUID}`, `up ${UUID}`]);
		// Down from the 40 s round; after the 120 s reconnect it needs five
		// clean probe rounds (125–145 s) to come back, then stays up.
		expect(states.get("wwan0")).toMatch(/^U{7}D{21}U+$/);
		expect(record("wwan0")).toMatchObject({ state: "up" });
		// eth0 carried throughout and was never probed while streaming.
		expect(probedIfaces()).toEqual(["wwan0"]);
		expect(states.get("eth0")).toMatch(/^U+$/);
	});

	test("a modem the bond hardly uses at a low bitrate flickers between carrying and not, answers its probe and is never touched", async () => {
		startStream([MODEM, ETH]);
		// T1744's live-alt shape: eth0 carries nearly everything and the
		// healthy modem alternates 8–30 s stretches of a still counter with
		// bursts of traffic.
		let bytes = 0;
		const at = await streamUntil(20 * 60_000, (t) => {
			const phase = (t / 1000) % 37;
			if (phase < 9) bytes += 4_000;
			return [
				{ link_id: MODEM.linkId, bytes_sent_total: bytes },
				{ link_id: ETH.linkId, bytes_sent_total: t * 500, bitrate_bps: 4e6 },
			];
		});
		expect(at).toEqual([]);
		expect(states.get("wwan0")).toMatch(/^U+$/);
		// The quiet stretches were checked by probe, not waved through.
		expect(probedIfaces()).toEqual(["wwan0"]);
		expect(record("wwan0")?.probes.failures).toBe(0);
	});

	test("one lost probe in a quiet stretch does not take a healthy modem down", async () => {
		startStream([MODEM, ETH]);
		// Two failures in a row, then success: below the three-round threshold.
		probeAnswer = (iface, t) =>
			iface === "wwan0" && (t === 30_000 || t === 35_000)
				? "failure"
				: "success";
		const at = await streamUntil(10 * 60_000, (t) => [
			{ link_id: MODEM.linkId, bytes_sent_total: 1_332 },
			{ link_id: ETH.linkId, bytes_sent_total: t * 500, bitrate_bps: 4e6 },
		]);
		expect(at).toEqual([]);
		expect(states.get("wwan0")).toMatch(/^U+$/);
	});

	test("a modem that carries the stream is never probed or reconnected, even if a probe would fail", async () => {
		startStream([MODEM, ETH]);
		probeAnswer = (iface) => (iface === "wwan0" ? "failure" : "success");
		const at = await streamUntil(20 * 60_000, (t) => [
			{ link_id: MODEM.linkId, bytes_sent_total: t * 300, bitrate_bps: 2e6 },
			{ link_id: ETH.linkId, bytes_sent_total: t * 500, bitrate_bps: 4e6 },
		]);
		expect(at).toEqual([]);
		expect(probes).toEqual([]);
		expect(states.get("wwan0")).toMatch(/^U+$/);
	});

	test("a cut eth0 goes down while the modem carrying alone is never checked or reconnected", async () => {
		startStream([MODEM, ETH]);
		// eth0 is cut to the LAN at 20 s and stops carrying; the modem carries
		// the whole stream. Probes from the modem fail anyway (a blocked check
		// address on that carrier).
		probeAnswer = (iface, t) =>
			iface === "eth0" ? (t > 20_000 ? "failure" : "success") : "failure";
		const at = await streamUntil(20 * 60_000, (t) => [
			{ link_id: MODEM.linkId, bytes_sent_total: t * 300, bitrate_bps: 2e6 },
			{
				link_id: ETH.linkId,
				bytes_sent_total: Math.min(t, 20_000) * 500,
			},
		]);
		expect(at).toEqual([]);
		expect(record("eth0")).toMatchObject({
			state: "down",
			reason: "probe_failed",
		});
		expect(states.get("wwan0")).toMatch(/^U+$/);
	});

	for (const alternate of [true, false]) {
		test(`a modem whose check fails but that sends a burst every 5 s is never reconnected (alternate up: ${alternate})`, async () => {
			startStream([MODEM, ETH]);
			// The check address is blocked on the modem's carrier, so every check
			// fails; the sender latches "not carrying" through single bursts.
			probeAnswer = (iface) =>
				iface === "wwan0" ? "failure" : alternate ? "success" : "failure";
			const at = await streamUntil(20 * 60_000, (t) => [
				{
					link_id: MODEM.linkId,
					bytes_sent_total:
						Math.max(0, Math.floor((t - 5_000) / 5_000)) * 4_000,
				},
				{ link_id: ETH.linkId, bytes_sent_total: 0 },
			]);
			expect(at).toEqual([]);
			expect(calls).toEqual([]);
			// Never quiet for 10 s, so never checked and never down.
			expect(probes.filter((probe) => probe.endsWith(":wwan0"))).toEqual([]);
			expect(states.get("wwan0")).toMatch(/^U+$/);
		});
	}

	test("a modem whose check fails and that sends a burst every 20 s may go down but is never reconnected", async () => {
		startStream([MODEM, ETH]);
		probeAnswer = (iface) => (iface === "wwan0" ? "failure" : "success");
		const at = await streamUntil(20 * 60_000, (t) => [
			{
				link_id: MODEM.linkId,
				bytes_sent_total: Math.floor(t / 20_000) * 4_000,
			},
			{ link_id: ETH.linkId, bytes_sent_total: t * 500, bitrate_bps: 4e6 },
		]);
		// Quiet stretches are long enough to check, and the checks fail, but a
		// burst inside every outage starts it over: nothing is torn down.
		expect(probes.some((probe) => probe.endsWith(":wwan0"))).toBe(true);
		expect(at).toEqual([]);
		expect(calls).toEqual([]);
	});

	for (const alternate of [true, false]) {
		test(`a modem down on its checks that then sends bursts comes back up and is never cut (alternate up: ${alternate})`, async () => {
			startStream([MODEM, ETH]);
			probeAnswer = (iface) =>
				iface === "wwan0" ? "failure" : alternate ? "success" : "failure";
			// No sender report for the first 60 s: every link is checked, and the
			// modem goes down on its blocked check. Then its counter stands for
			// 10 s, so "not carrying" latches, and from 70 s it carries stream
			// data in bursts every 5 s, which leave that verdict latched.
			const at = await streamUntil(20 * 60_000, (t) =>
				t <= 60_000
					? undefined
					: [
							{
								link_id: MODEM.linkId,
								bytes_sent_total:
									Math.max(0, Math.floor((t - 70_000) / 5_000) + 1) * 4_000,
							},
							{ link_id: ETH.linkId, bytes_sent_total: 0 },
						],
			);
			// The pre-fix trigger: the sender reads it as not carrying throughout.
			expect(notCarryingSeen).toBe(true);
			// Down on its blocked check first; once it sends payload again its
			// sender row is evidence that the path works, and it comes back.
			expect(states.get("wwan0")).toMatch(/D.*U+$/);
			expect(at).toEqual([]);
			expect(calls).toEqual([]);
		});
	}

	test("a black hole after an hour of quiet that drained the check budget is still reconnected", async () => {
		startStream([MODEM, ETH]);
		// A healthy spare: it carries nothing for an hour and answers every
		// check, which spends its budget down to the hourly refill.
		const blackholeAt = 3_600_000;
		probeAnswer = (iface, t) =>
			iface === "wwan0" && t > blackholeAt && calls.length === 0
				? "failure"
				: "success";
		const at = await streamUntil(blackholeAt + 600_000, (t) => [
			{ link_id: MODEM.linkId, bytes_sent_total: 1_332 },
			{ link_id: ETH.linkId, bytes_sent_total: t * 500, bitrate_bps: 4e6 },
		]);
		const before = probes.filter(
			(probe) =>
				probe.endsWith(":wwan0") &&
				Number(probe.split(":")[0]) * 1000 <= blackholeAt,
		).length;
		const { perHour, burst } = UPLINK_HEALTH_CONFIG.streamingProbeBudget;
		expect(before).toBeLessThanOrEqual(perHour + burst);
		// Skipped rounds keep the failure streak, and the failing link's reserve
		// adds checks: reconnected 90 s after the fault (150 s on the hourly
		// refill alone).
		expect(at).toHaveLength(1);
		expect((at[0] ?? Infinity) - blackholeAt).toBeLessThanOrEqual(120_000);
	});

	for (const reported of [true, false]) {
		test(`a black hole whose counter still grows by duplicate probes (stall latch ${reported ? "reported" : "unknown"})`, async () => {
			startStream([MODEM, ETH]);
			const blackholeAt = 20_000;
			const dead = (t: number) => t > blackholeAt && calls.length === 0;
			probeAnswer = (iface, t) =>
				iface === "wwan0" && dead(t) ? "failure" : "success";
			let bytes = 0;
			const at = await streamUntil(300_000, (t) => {
				// Payload until the fault, then the sender holds the link out of
				// the payload rotation and sends one duplicate probe every 2 s.
				if (!dead(t)) bytes += 200_000;
				else if (t % 2_000 === 0) bytes += 1_332;
				const gated = dead(t) && t > blackholeAt + 3_000;
				return [
					{
						link_id: MODEM.linkId,
						bytes_sent_total: bytes,
						...(reported ? { stall_gated: gated } : {}),
					},
					{
						link_id: ETH.linkId,
						bytes_sent_total: t * 500,
						bitrate_bps: 4e6,
						...(reported ? { stall_gated: false } : {}),
					},
				];
			});
			if (reported) {
				// The sender says those bytes are duplicates: reconnected.
				expect(at).toHaveLength(1);
				expect(calls).toEqual([`down ${UUID}`, `up ${UUID}`]);
			} else {
				// Without that report any byte is payload, and a link that delivers
				// payload is never cut mid-stream (documented limit: it recovers
				// between streams).
				expect(at).toEqual([]);
				expect(calls).toEqual([]);
			}
		});
	}

	// A low-rate stream split across four links leaves each one a few KB/s.
	// With its checks failing, a modem that keeps delivering any payload is
	// never cut (review round 3: 3,000 B/s was cut at 120 s).
	for (const { name, modemBps, peerBps, checkFails } of [
		{
			name: "96 kbit/s audio, even split",
			modemBps: 24_000,
			peerBps: 24_000,
			checkFails: true,
		},
		{
			name: "300 kbit/s, uneven split",
			modemBps: 24_000,
			peerBps: 92_000,
			checkFails: true,
		},
		{
			name: "300 kbit/s, even split",
			modemBps: 75_000,
			peerBps: 75_000,
			checkFails: true,
		},
		{
			name: "500 kbit/s, even split",
			modemBps: 125_000,
			peerBps: 125_000,
			checkFails: true,
		},
		{
			name: "96 kbit/s audio, check answers",
			modemBps: 24_000,
			peerBps: 24_000,
			checkFails: false,
		},
		{
			name: "a few hundred bytes a second",
			modemBps: 2_400,
			peerBps: 24_000,
			checkFails: true,
		},
	]) {
		test(`a modem delivering a low-rate share is never cut: ${name}`, async () => {
			const entries = [
				MODEM,
				ETH,
				{ ip: "192.0.2.11", iface: "eth1", linkId: "lnk_eth1000000000000" },
				{ ip: "192.0.2.12", iface: "eth2", linkId: "lnk_eth2000000000000" },
			];
			for (const entry of entries.slice(2))
				interfaces[entry.iface] = { ip: entry.ip, error: 0, tp: 0, txb: 0 };
			try {
				startStream(entries);
				probeAnswer = (iface) =>
					checkFails && iface === MODEM.iface ? "failure" : "success";
				const at = await streamUntil(20 * 60_000, (t) =>
					entries.map((entry) => {
						const bitrate_bps =
							entry.iface === MODEM.iface ? modemBps : peerBps;
						return {
							link_id: entry.linkId,
							bytes_sent_total: Math.floor((t * bitrate_bps) / 8_000),
							bitrate_bps,
						};
					}),
				);
				expect(linkCarryingState(MODEM.iface)).toBe("carrying");
				expect(at).toEqual([]);
				expect(calls).toEqual([]);
				// It sent something every second: never quiet, never checked.
				expect(probes.filter((probe) => probe.endsWith(":wwan0"))).toEqual([]);
			} finally {
				delete interfaces.eth1;
				delete interfaces.eth2;
			}
		});
	}

	test("with every link black-holed, the modem waits for the alone hold", async () => {
		startStream([MODEM, ETH]);
		probeAnswer = (_iface, t) => (t > 20_000 ? "failure" : "success");
		const at = await streamUntil(600_000, (t) => [
			{ link_id: MODEM.linkId, bytes_sent_total: Math.min(t, 20_000) * 200 },
			{ link_id: ETH.linkId, bytes_sent_total: Math.min(t, 20_000) * 500 },
		]);
		expect(record("eth0")?.state).toBe("down");
		expect(at).toEqual([60_000 + DEAD_BEARER_ALONE_HOLD_MS]);
	});

	test("without a check address the quiet link's verdict ages out instead of staying fresh", async () => {
		startStream([MODEM, ETH]);
		const resolveNone = new UplinkHealthRuntimeCore(
			{
				now: () => wall,
				interfaces: () => interfaces,
				streaming: () => true,
				telemetry: buildLinkTelemetry,
				quietForMs: linkQuietForMs,
				monotonicNow: () => now,
				resolveTarget: async () => undefined,
				probe: async (candidate) => {
					probes.push(candidate.name);
					return "failure";
				},
				publish: () => {},
				exclusionReason: () => undefined,
				candidates: (all) =>
					Object.entries(all).map(([name, entry]) => ({
						name,
						ip: entry.ip as string,
						binding: { kind: "device" as const, ifname: name },
					})),
				identity: () => ({ kind: "cellular" }),
			},
			engine,
		);
		health = resolveNone;
		const at = await streamUntil(120_000, (t) => [
			{ link_id: MODEM.linkId, bytes_sent_total: 0 },
			{ link_id: ETH.linkId, bytes_sent_total: t * 500, bitrate_bps: 4e6 },
		]);
		expect(probes).toEqual([]);
		expect(at).toEqual([]);
		// Nothing measured it for 110 s: it is stale, so it reads unknown and
		// counts as nobody's working alternative.
		expect((record("wwan0")?.staleAt ?? 0) <= wall).toBe(true);
	});
});
