import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Telemetry } from "@ceraui/srtla-send/telemetry";
import {
	resetClatTranslationStateForTest,
	setClatTranslationsForTest,
} from "../network/clat-translation.ts";
import type { UplinkHealthRecord } from "../network/uplink-health/model.ts";
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
	ingestTelemetryForTest,
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
	DEAD_BEARER_MIN_FAILURES,
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
  The stream veto, driven through the real sender telemetry: rows go in as
  srtla_send snapshots, one per second, and the dead-bearer poll runs every
  15 s against whatever the shared carrying predicate makes of them. The
  probe-dead modem is wwan0; eth0 is up, so the 60 s hold applies.
*/

const UUID = "9b0c1f3e-4f4f-4a51-9a51-3a0d1b7e2c11";
const KEY = "platform-xhci-hcd.0.auto-usb-0:1.4";
// The sender stamps snapshots on the wall clock the staleness check reads, so a
// snapshot the test feeds is fresh when it is fed (`wall` starts here too).
const SENDER_EPOCH = 1_800_000_000_000;
const POLL_MS = 15_000;

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

function record(
	iface: string,
	kind: UplinkHealthRecord["kind"],
	state: "up" | "down",
): UplinkHealthRecord {
	return {
		iface,
		kind,
		state,
		weight: state === "up" ? 100 : 0,
		lastTransition: wall,
		staleAt: wall + 15_000,
		probes: {
			successes: 0,
			failures: state === "down" ? DEAD_BEARER_MIN_FAILURES : 0,
		},
		signals: {},
		...(state === "down" ? { reason: "probe_failed" as const } : {}),
	};
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

/**
 * Advance second by second until `until`, feeding the sender snapshot that
 * `rows(t)` returns (null: a stale read, undefined: no new snapshot) and
 * running the dead-bearer poll every 15 s. Returns the reconnect times.
 */
async function streamUntil(
	until: number,
	rows: (t: number) => Conn[] | null | undefined,
): Promise<number[]> {
	const at: number[] = [];
	while (now < until) {
		now += 1_000;
		wall += 1_000;
		const next = rows(now);
		if (next === null) ingestTelemetryForTest(null);
		else if (next !== undefined) ingestTelemetryForTest(snapshot(next));
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
	// Another file's translation must not make wwan0 look translated here.
	resetClatTranslationStateForTest();
	setTelemetryClockForTest(() => wall);
	setCarryingClockForTest(() => now);
	setLinkIdentityDetailResolverForTest(() => ({}));
	setIfaceResolverForTest(() => undefined);
	for (const id of getModemIds()) removeModem(id);
	setModem(2, modem());
	// Everything about the stream comes from the real telemetry module.
	setDeadBearerDepsForTest({
		now: () => now,
		wallNow: () => wall,
		ids: () => getModemIds(),
		stableKey: (id) => (id === 2 ? KEY : undefined),
		health: (iface) =>
			iface === "wwan0"
				? record("wwan0", "cellular", "down")
				: iface === "clat0"
					? record("clat0", "other", "down")
					: undefined,
		healthList: () => [
			record("wwan0", "cellular", "down"),
			record("clat0", "other", "down"),
			record("eth0", "ethernet", "up"),
		],
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

describe("while a stream runs, the dead-bearer veto follows the link's own traffic", () => {
	test("a bonded link whose row is fresh but sends nothing is reconnected after the hold", async () => {
		startStream([MODEM, ETH]);
		const at = await streamUntil(120_000, (t) => [
			{ link_id: MODEM.linkId, bytes_sent_total: 0 },
			{ link_id: ETH.linkId, bytes_sent_total: t * 500, bitrate_bps: 4e6 },
		]);
		// The first poll at 15 s already sees "not carrying", so the 60 s hold
		// counts from there.
		expect(at).toEqual([POLL_MS + DEAD_BEARER_HOLD_MS]);
		expect(calls).toEqual([`down ${UUID}`, `up ${UUID}`]);
	});

	test("a link that carries stream data is never reconnected, whatever its probes say", async () => {
		startStream([MODEM, ETH]);
		const at = await streamUntil(20 * 60_000, (t) => [
			{ link_id: MODEM.linkId, bytes_sent_total: t * 300 },
			{ link_id: ETH.linkId, bytes_sent_total: t * 500 },
		]);
		expect(at).toEqual([]);
	});

	test("a link that stops carrying is reconnected only after the hold from then", async () => {
		startStream([MODEM, ETH]);
		const stopAt = 60_000;
		const at = await streamUntil(200_000, (t) => [
			{
				link_id: MODEM.linkId,
				bytes_sent_total: Math.min(t, stopAt) * 300,
			},
			{ link_id: ETH.linkId, bytes_sent_total: t * 500 },
		]);
		// Not carrying from 65 s (5 s of a still counter); first seen at the
		// 75 s poll, so the hold ends at 135 s.
		expect(at).toEqual([75_000 + DEAD_BEARER_HOLD_MS]);
	});

	test("no sender snapshot yet is unknown, and unknown never reconnects", async () => {
		startStream([MODEM, ETH]);
		expect(await streamUntil(20 * 60_000, () => undefined)).toEqual([]);
	});

	test("stale sender telemetry is unknown, and unknown never reconnects", async () => {
		startStream([MODEM, ETH]);
		const at = await streamUntil(20 * 60_000, (t) =>
			t <= 10_000
				? [
						{ link_id: MODEM.linkId, bytes_sent_total: 0 },
						{ link_id: ETH.linkId, bytes_sent_total: t * 500 },
					]
				: null,
		);
		expect(at).toEqual([]);
	});

	test("a sender that reports no byte counter is unknown, and unknown never reconnects", async () => {
		startStream([MODEM, ETH]);
		const at = await streamUntil(20 * 60_000, () => [
			{ link_id: MODEM.linkId },
			{ link_id: ETH.linkId },
		]);
		expect(at).toEqual([]);
	});
});

/*
  The translator row reaches the sender as `clat0`, unresolved by the identity
  ladder, and the carrying predicate folds it into wwan0. Health reads clat0
  down too, so the modem is judged by its translator's record, and the stream
  veto is what decides.
*/
describe("an IPv6-only modem's CLAT translator counts for the modem", () => {
	function translate(): void {
		setClatTranslationsForTest(
			new Map([
				["clat0", { parent: "wwan0", tun: "clat0", ipv4: "192.0.0.1" }],
			]),
		);
	}

	test("translator traffic protects the parent modem", async () => {
		translate();
		startStream([]);
		const at = await streamUntil(20 * 60_000, (t) => [
			{ iface: "clat0", bytes_sent_total: t * 300 },
			{ iface: "eth0", bytes_sent_total: t * 500 },
		]);
		expect(at).toEqual([]);
	});

	test("a translator that sends nothing lets the parent modem be reconnected", async () => {
		translate();
		startStream([]);
		const at = await streamUntil(120_000, (t) => [
			{ iface: "clat0", bytes_sent_total: 0 },
			{ iface: "eth0", bytes_sent_total: t * 500 },
		]);
		expect(at).toEqual([POLL_MS + DEAD_BEARER_HOLD_MS]);
	});
});
