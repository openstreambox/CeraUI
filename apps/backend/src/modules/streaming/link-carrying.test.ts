import { describe, expect, test } from "bun:test";
import { createCarryTracker } from "./link-carrying.ts";
import type {
	LinkTelemetryEntry,
	LinkTelemetryMessage,
} from "./link-telemetry-rows.ts";

function row(
	iface: string,
	bitrate_bps: number,
	extra: Partial<LinkTelemetryEntry> = {},
): LinkTelemetryEntry {
	return {
		conn_id: iface,
		iface,
		rtt_ms: 40,
		nak_count: 0,
		weight_percent: 50,
		bitrate_bps,
		stale: false,
		...extra,
	};
}
const frame = (...links: LinkTelemetryEntry[]): LinkTelemetryMessage => ({
	links,
	measured_bps: links.reduce((sum, link) => sum + link.bitrate_bps, 0),
	lastReadMs: 0,
});

function tracker() {
	let clock = 0;
	const t = createCarryTracker(() => clock, 10_000);
	return {
		t,
		at: (ms: number) => {
			clock = ms;
		},
	};
}

describe("is another link carrying the stream", () => {
	test("another link with throughput in the window is carrying", () => {
		const { t, at } = tracker();
		for (let ms = 0; ms <= 20_000; ms += 250) {
			at(ms);
			t.sample(frame(row("wwan0", 0), row("eth0", 4_000_000)));
		}
		expect(t.judge(["wwan0"], ["wwan0", "eth0"])).toBe("others_carrying");
	});

	test("a moving byte counter counts even when the rate reads zero", () => {
		const { t, at } = tracker();
		at(0);
		t.sample(frame(row("eth0", 0, { bytes_sent_total: 100 })));
		at(15_000);
		t.sample(frame(row("eth0", 0, { bytes_sent_total: 900 })));
		expect(t.judge(["wwan0"], ["wwan0", "eth0"])).toBe("others_carrying");
	});

	test("carrying longer ago than the window no longer counts", () => {
		const { t, at } = tracker();
		at(0);
		t.sample(frame(row("wwan0", 0), row("eth0", 4_000_000)));
		for (let ms = 250; ms <= 20_000; ms += 250) {
			at(ms);
			t.sample(frame(row("wwan0", 0), row("eth0", 0)));
		}
		expect(t.judge(["wwan0"], ["wwan0", "eth0"])).toBe("none_carrying");
	});

	test("the stuck link's own traffic does not count as another link", () => {
		const { t, at } = tracker();
		for (let ms = 0; ms <= 20_000; ms += 250) {
			at(ms);
			t.sample(frame(row("wwan0", 2_000_000), row("eth0", 0)));
		}
		expect(t.judge(["wwan0"], ["wwan0", "eth0"])).toBe("none_carrying");
	});

	test("a bond with no other link has nothing else carrying", () => {
		const { t } = tracker();
		expect(t.judge(["wwan0"], ["wwan0"])).toBe("none_carrying");
	});

	test("missing or stale telemetry is can't tell, never none carrying", () => {
		const { t, at } = tracker();
		for (let ms = 0; ms <= 20_000; ms += 250) {
			at(ms);
			t.sample(null);
		}
		expect(t.judge(["wwan0"], ["wwan0", "eth0"])).toBe("unknown");
		for (let ms = 20_250; ms <= 40_000; ms += 250) {
			at(ms);
			t.sample(frame(row("eth0", 0, { stale: true })));
		}
		expect(t.judge(["wwan0"], ["wwan0", "eth0"])).toBe("unknown");
	});

	test("fresh telemetry shorter than the window is can't tell", () => {
		const { t, at } = tracker();
		at(15_000);
		t.sample(frame(row("eth0", 0)));
		at(20_000);
		t.sample(frame(row("eth0", 0)));
		expect(t.judge(["wwan0"], ["wwan0", "eth0"])).toBe("unknown");
	});

	test("an unknown stuck interface is can't tell", () => {
		const { t } = tracker();
		expect(t.judge([undefined], ["wwan0"])).toBe("unknown");
		expect(t.judge([], ["wwan0"])).toBe("unknown");
	});
});
