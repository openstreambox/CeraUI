import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Telemetry } from "@ceraui/srtla-send/telemetry";
import { resetClatTranslationStateForTest } from "../network/clat-translation.ts";
import type { ProbeCandidate } from "../network/connectivity-candidates.ts";
import type { NetworkInterface } from "../network/network-interfaces.ts";
import {
	UplinkHealthEngine,
	type UplinkHealthOutcome,
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
  The stream and the dead-bearer recovery end to end: sender snapshots go
  through the real telemetry module once a second, the real uplink health
  core runs its 5 s round on that telemetry (the probe is the only fake), and
  the dead-bearer poll runs every 30 s against the health records the core
  produced.

  Mid-stream recovery is parked. While a stream runs nothing is torn down,
  and a quiet streamed link's own check is a diagnostic only: it is logged
  and kept, and changes no verdict. A black-holed bearer is recovered once
  the stream stops, on the idle path.
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
/** Whether a stream runs, for health and for the dead-bearer poll alike. */
let streaming = true;
const logged: string[] = [];

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
		if (next !== undefined) ingestTelemetryForTest(snapshot(next));
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
	streaming = true;
	logged.length = 0;
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
			streaming: () => streaming,
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
			logDiagnostic: ({ iface, outcome }) =>
				logged.push(`${now / 1000}:${iface}:${outcome}`),
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
		streaming: () => streaming,
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

function probesOf(iface: string): string[] {
	return probes.filter((probe) => probe.endsWith(`:${iface}`));
}

function diagnostic(iface: string) {
	return health.diagnostics().find((entry) => entry.iface === iface);
}

describe("while a stream runs, nothing is torn down and streamed checks are diagnostic", () => {
	test("a black-holed modem is never cut mid-stream; its checks are logged; after the stream it is recovered", async () => {
		startStream([MODEM, ETH]);
		const blackholeAt = 20_000;
		const stopAt = 300_000;
		const dead = (t: number) => t > blackholeAt && calls.length === 0;
		probeAnswer = (iface, t) =>
			iface === "wwan0" && dead(t) ? "failure" : "success";
		const at = await streamUntil(stopAt + 240_000, (t) => {
			if (t === stopAt) streaming = false;
			return [
				{
					link_id: MODEM.linkId,
					bytes_sent_total: Math.min(t, blackholeAt) * 200,
				},
				{ link_id: ETH.linkId, bytes_sent_total: t * 500, bitrate_bps: 4e6 },
			];
		});
		// Diagnostic checks saw the black hole while the stream ran...
		expect(logged.some((line) => line.endsWith(":wwan0:failure"))).toBe(true);
		// ...but changed nothing: the verdict stayed passive and up.
		expect(states.get("wwan0")?.slice(0, (stopAt - 5_000) / 5_000)).toMatch(
			/^U+$/,
		);
		// The idle path takes it down after the stream (three failed rounds)
		// and the reconnect follows: first outage poll, then the 60 s hold.
		expect(at).toHaveLength(1);
		expect((at[0] ?? 0) > stopAt).toBe(true);
		expect((at[0] ?? 0) - stopAt).toBeLessThanOrEqual(
			3 * POLL_MS + DEAD_BEARER_HOLD_MS,
		);
		expect(calls).toEqual([`down ${UUID}`, `up ${UUID}`]);
	});

	test("the last carrier is never cut while a stream runs, whatever its checks say", async () => {
		startStream([MODEM, ETH]);
		// eth0 is cut to the LAN: its checks fail and it stops carrying; the
		// modem carries everything, and its own checks fail too.
		probeAnswer = () => "failure";
		const at = await streamUntil(20 * 60_000, (t) => [
			{ link_id: MODEM.linkId, bytes_sent_total: t * 300, bitrate_bps: 2e6 },
			{ link_id: ETH.linkId, bytes_sent_total: Math.min(t, 20_000) * 500 },
		]);
		expect(at).toEqual([]);
		expect(calls).toEqual([]);
		// A modem that carries is never checked at all.
		expect(probesOf("wwan0")).toEqual([]);
		// The cut eth0 is checked as a diagnostic only; its verdict stays up
		// until the stream ends (parked: a LAN-limited path goes down on the
		// idle path).
		expect(diagnostic("eth0")?.outcome).toBe("failure");
		expect(states.get("eth0")).toMatch(/^U+$/);
	});

	test("a modem whose sibling row goes missing is never cut", async () => {
		startStream([MODEM, ETH]);
		probeAnswer = (iface) => (iface === "wwan0" ? "failure" : "success");
		const at = await streamUntil(20 * 60_000, (t) =>
			t < 60_000
				? [
						{ link_id: MODEM.linkId, bytes_sent_total: 0 },
						{ link_id: ETH.linkId, bytes_sent_total: t * 500 },
					]
				: [{ link_id: MODEM.linkId, bytes_sent_total: 0 }],
		);
		expect(at).toEqual([]);
		expect(calls).toEqual([]);
	});

	// A low-rate stream split across four links leaves each one a few KB/s.
	// With its checks failing, a modem that keeps delivering anything is never
	// cut (review rounds 3 and 4: 3,000 B/s was cut at 120 s).
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
				expect(probesOf("wwan0")).toEqual([]);
				expect(states.get("wwan0")).toMatch(/^U+$/);
			} finally {
				delete interfaces.eth1;
				delete interfaces.eth2;
			}
		});
	}

	test("a healthy modem the bond hardly uses gets diagnostic checks in its quiet stretches and nothing else", async () => {
		startStream([MODEM, ETH]);
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
		expect(probesOf("wwan0").length > 0).toBe(true);
		expect(diagnostic("wwan0")?.outcome).toBe("success");
		expect(states.get("wwan0")).toMatch(/^U+$/);
		// Logged once, when the answer first came in; not every check.
		expect(logged.filter((line) => line.includes(":wwan0:"))).toHaveLength(1);
	});

	test("between streams a black-holed modem goes down on its checks and is reconnected after the hold", async () => {
		streaming = false;
		probeAnswer = (iface, t) =>
			iface === "wwan0" && t > 20_000 && calls.length === 0
				? "failure"
				: "success";
		const at = await streamUntil(240_000, () => undefined);
		expect(at).toHaveLength(1);
		expect(calls).toEqual([`down ${UUID}`, `up ${UUID}`]);
		expect(health.diagnostics()).toEqual([]);
	});
});
