import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
	Telemetry,
	watchTelemetry as WatchTelemetryFn,
} from "@ceraui/srtla-send/telemetry";
import {
	resetClatTranslationStateForTest,
	setClatTranslationsForTest,
} from "../modules/network/clat-translation.ts";
import type { BondEntry } from "../modules/streaming/bind-map.ts";
import {
	clearBindMapReport,
	noteWriterBindMapReport,
	resetBindMapReportListeners,
} from "../modules/streaming/bind-map-disposition.ts";
import { LINK_CARRYING_SHOW_MS } from "../modules/streaming/link-progress.ts";
import { setLinkIdentityDetailResolverForTest } from "../modules/streaming/link-registry.ts";
import {
	buildLinkTelemetry,
	ingestTelemetryForTest,
	linkCarryingState,
	registerSrtlaBond,
	setCarryingClockForTest,
	setIfaceResolverForTest,
	startLinkTelemetry,
	stopLinkTelemetry,
} from "../modules/streaming/link-telemetry.ts";

/*
  The field case behind this: srtla_send dialled one link to a receiver address
  that no longer existed. That link never registered and sent no stream data for
  the whole session, while its telemetry row stayed fresh with a plausible RTT.
  The row must not read as a working link.
*/

type Conn = Partial<Telemetry["connections"][number]> & {
	iface?: string;
	link_id?: string;
};

let clock = 0;

// The sender stamps each snapshot; a repeated read carries the same stamp.
const SENDER_EPOCH = 1_790_000_000_000;

function snapshot(connections: Conn[], at = clock): Telemetry {
	return {
		schema_version: 1,
		last_updated_ms: SENDER_EPOCH + at,
		connections: connections.map((c, i) => ({
			conn_id: String(i),
			rtt_ms: 40,
			nak_count: 0,
			weight_percent: 50,
			window: 1000,
			in_flight: 0,
			bitrate_bps: 0,
			...c,
		})),
	} as Telemetry;
}

const MODEM: BondEntry = {
	ip: "10.64.0.2",
	iface: "wwan0",
	linkId: "lnk_modem00000000000",
};
const WIFI: BondEntry = {
	ip: "192.168.1.30",
	iface: "wlan0",
	linkId: "lnk_wifi000000000000",
};
// An IPv6-only SIM: the bond sends from the translator, the modem owns it.
const CLAT: BondEntry = {
	ip: "192.0.0.1",
	iface: "clat0",
	parentIface: "wwan1",
	linkId: "lnk_clat000000000000",
};

function start(entries: readonly BondEntry[]): void {
	registerSrtlaBond(entries);
	noteWriterBindMapReport("bind-map-passed", entries);
	const watch: typeof WatchTelemetryFn = () => ({ stop: () => {} });
	startLinkTelemetry(
		"/tmp/unused-stats.json",
		entries.map((e) => e.ip),
		{ watch },
	);
}

/** One snapshot per second from `from` to `to`, rows from `at(t)`. */
function feed(from: number, to: number, at: (t: number) => Conn[]): void {
	for (let t = from; t <= to; t += 1_000) {
		clock = t;
		ingestTelemetryForTest(snapshot(at(t), t));
	}
}

function row(iface: string) {
	return buildLinkTelemetry()?.links.find((link) => link.iface === iface);
}

beforeEach(() => {
	clock = 0;
	setCarryingClockForTest(() => clock);
	setLinkIdentityDetailResolverForTest(() => ({}));
	setIfaceResolverForTest(() => undefined);
});

afterEach(() => {
	stopLinkTelemetry();
	clearBindMapReport();
	resetBindMapReportListeners();
	setCarryingClockForTest(null);
	setLinkIdentityDetailResolverForTest(null);
	setIfaceResolverForTest(null);
});

describe("a link that is in the bond but carries nothing", () => {
	test("its row says so once the dwell has passed, and the carrying link's row says it carries", () => {
		start([MODEM, WIFI]);
		feed(0, LINK_CARRYING_SHOW_MS, (t) => [
			{ link_id: MODEM.linkId, bytes_sent_total: 0 },
			{ link_id: WIFI.linkId, bytes_sent_total: t * 500, bitrate_bps: 4e6 },
		]);
		expect(row("wwan0")?.carrying).toBe(false);
		expect(row("wlan0")?.carrying).toBe(true);
		expect(linkCarryingState("wwan0")).toBe("not_carrying");
		expect(linkCarryingState("wlan0")).toBe("carrying");
	});

	test("no claim before the dwell, so a stream that just started shows nothing", () => {
		start([MODEM, WIFI]);
		feed(0, LINK_CARRYING_SHOW_MS - 1_000, () => [
			{ link_id: MODEM.linkId, bytes_sent_total: 0 },
			{ link_id: WIFI.linkId, bytes_sent_total: 0 },
		]);
		expect(row("wwan0")).not.toHaveProperty("carrying");
		expect(linkCarryingState("wwan0")).toBe("unknown");
	});

	test("a stale snapshot makes no claim, and fresh reports start the dwell again", () => {
		start([MODEM]);
		feed(0, LINK_CARRYING_SHOW_MS, () => [
			{ link_id: MODEM.linkId, bytes_sent_total: 0 },
		]);
		expect(row("wwan0")?.carrying).toBe(false);
		clock = LINK_CARRYING_SHOW_MS + 1_000;
		ingestTelemetryForTest(null);
		expect(row("wwan0")?.stale).toBe(true);
		expect(row("wwan0")).not.toHaveProperty("carrying");
		expect(linkCarryingState("wwan0")).toBe("unknown");
		feed(LINK_CARRYING_SHOW_MS + 2_000, LINK_CARRYING_SHOW_MS + 3_000, () => [
			{ link_id: MODEM.linkId, bytes_sent_total: 0 },
		]);
		expect(row("wwan0")).not.toHaveProperty("carrying");
	});

	test("an IPv6-only modem is judged by its translator's traffic", () => {
		start([CLAT]);
		feed(0, LINK_CARRYING_SHOW_MS, () => [
			{ link_id: CLAT.linkId, iface: "clat0", bytes_sent_total: 0 },
		]);
		expect(row("wwan1")?.carrying).toBe(false);
		expect(linkCarryingState("wwan1")).toBe("not_carrying");
	});

	test("stopping the stream forgets every link", () => {
		start([MODEM]);
		feed(0, LINK_CARRYING_SHOW_MS, () => [
			{ link_id: MODEM.linkId, bytes_sent_total: 0 },
		]);
		stopLinkTelemetry();
		expect(buildLinkTelemetry()).toBeNull();
		expect(linkCarryingState("wwan0")).toBe("unknown");
	});
});

describe("broadcasts do not count as reports", () => {
	test("building the payload many times between two snapshots changes nothing", () => {
		start([WIFI]);
		feed(0, 2_000, (t) => [{ link_id: WIFI.linkId, bytes_sent_total: t }]);
		for (let i = 0; i < 20; i++) {
			clock += 100;
			expect(row("wlan0")?.carrying).toBe(true);
		}
	});
});

describe("evidence is counted once and expires", () => {
	test("re-reading the same snapshot is not a second sample", () => {
		start([MODEM]);
		// One real snapshot, then the poll re-reads the unchanged file for 5 s.
		clock = 0;
		const once = snapshot([{ link_id: MODEM.linkId, bytes_sent_total: 0 }], 0);
		for (let t = 0; t <= LINK_CARRYING_SHOW_MS; t += 1_000) {
			clock = t;
			ingestTelemetryForTest(once);
		}
		expect(row("wwan0")).not.toHaveProperty("carrying");
		expect(linkCarryingState("wwan0")).toBe("unknown");
	});

	test("a silent sender leaves no verdict behind", () => {
		start([MODEM]);
		feed(0, LINK_CARRYING_SHOW_MS, () => [
			{ link_id: MODEM.linkId, bytes_sent_total: 0 },
		]);
		expect(row("wwan0")?.carrying).toBe(false);
		// No new snapshot arrives (a quiet subscription), the last one stays put.
		clock = LINK_CARRYING_SHOW_MS + 3_000;
		expect(row("wwan0")).not.toHaveProperty("carrying");
		expect(buildLinkTelemetry()?.not_carrying_ifaces).toEqual([]);
		expect(linkCarryingState("wwan0")).toBe("unknown");
	});

	test("a sender without a byte counter makes no negative claim", () => {
		start([MODEM]);
		feed(0, 3 * LINK_CARRYING_SHOW_MS, () => [
			{ link_id: MODEM.linkId, bitrate_bps: 0 },
		]);
		expect(row("wwan0")).not.toHaveProperty("carrying");
	});
});

describe("one answer per device", () => {
	test("a translator row the ladder left unresolved still counts for its modem", () => {
		setClatTranslationsForTest(
			new Map([
				["clat0", { parent: "wwan1", tun: "clat0", ipv4: "192.0.0.1" }],
			]),
		);
		try {
			start([]);
			feed(0, LINK_CARRYING_SHOW_MS, () => [
				{ iface: "clat0", bytes_sent_total: 0 },
			]);
			expect(buildLinkTelemetry()?.not_carrying_ifaces).toEqual(["wwan1"]);
		} finally {
			resetClatTranslationStateForTest();
		}
	});

	test("a sibling row that carries keeps the device off the list", () => {
		start([MODEM, { ...CLAT, parentIface: "wwan0" }]);
		feed(0, LINK_CARRYING_SHOW_MS, (t) => [
			{ link_id: MODEM.linkId, bytes_sent_total: t },
			{ link_id: CLAT.linkId, iface: "clat0", bytes_sent_total: 0 },
		]);
		expect(buildLinkTelemetry()?.not_carrying_ifaces).toEqual([]);
		expect(linkCarryingState("wwan0")).toBe("carrying");
	});
});
