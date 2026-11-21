import { describe, expect, test } from "bun:test";

import {
	LINK_CARRYING_CLEAR_MS,
	LINK_CARRYING_EVIDENCE_MS,
	LINK_CARRYING_SHOW_MS,
	type LinkProgressRow,
	LinkProgressTracker,
	linkMadeProgress,
} from "./link-progress.ts";

const row = (
	iface: string,
	bytes: number | undefined,
	extra: Partial<LinkProgressRow> = {},
): LinkProgressRow => ({
	iface,
	...(bytes === undefined ? {} : { bytes_sent_total: bytes }),
	bitrate_bps: 0,
	...extra,
});

/** Feed one snapshot per second; `bytesAt(t)` gives each link's counter. */
function run(
	tracker: LinkProgressTracker,
	fromMs: number,
	toMs: number,
	rowsAt: (t: number) => LinkProgressRow[],
): void {
	for (let t = fromMs; t <= toMs; t += 1_000) tracker.observe(rowsAt(t), t);
}

describe("linkMadeProgress", () => {
	test("a moving byte counter is progress, a still one is not", () => {
		expect(linkMadeProgress(row("wwan0", 2_000), 1_000)).toBe(true);
		expect(linkMadeProgress(row("wwan0", 1_000), 1_000)).toBe(false);
	});

	test("a first sighting or a counter that went backwards is no progress", () => {
		expect(linkMadeProgress(row("wwan0", 5_000), undefined)).toBe(false);
		expect(linkMadeProgress(row("wwan0", 10), 5_000)).toBe(false);
	});

	test("a measured rate above zero counts on its own", () => {
		expect(
			linkMadeProgress(
				row("wwan0", undefined, { bitrate_bps: 800 }),
				undefined,
			),
		).toBe(true);
		expect(linkMadeProgress(row("wwan0", undefined), undefined)).toBe(false);
	});
});

describe("LinkProgressTracker", () => {
	test("a link whose counter never moves reads not carrying after the dwell, not before", () => {
		const tracker = new LinkProgressTracker();
		const rows = (t: number) => [row("wwan0", 0), row("wlan0", t * 100)];
		run(tracker, 0, LINK_CARRYING_SHOW_MS - 1_000, rows);
		expect(
			tracker.stateFor(row("wwan0", 0), LINK_CARRYING_SHOW_MS - 1_000),
		).toBe("unknown");
		run(tracker, LINK_CARRYING_SHOW_MS, LINK_CARRYING_SHOW_MS, rows);
		expect(tracker.stateFor(row("wwan0", 0), LINK_CARRYING_SHOW_MS)).toBe(
			"not_carrying",
		);
		expect(tracker.stateFor(row("wlan0", 0), LINK_CARRYING_SHOW_MS)).toBe(
			"carrying",
		);
	});

	test("a link that stops carrying flips after the dwell from its last progress", () => {
		const tracker = new LinkProgressTracker();
		// Carries until 10 s, then its counter freezes.
		const rows = (t: number) => [row("wwan0", Math.min(t, 10_000) * 10)];
		run(tracker, 0, 14_000, rows);
		expect(tracker.stateFor(row("wwan0", 0), 14_000)).toBe("carrying");
		run(tracker, 15_000, 15_000, rows);
		expect(tracker.stateFor(row("wwan0", 0), 15_000)).toBe("not_carrying");
	});

	test("one stray packet does not clear it; progress that lasts does", () => {
		const tracker = new LinkProgressTracker();
		let bytes = 0;
		run(tracker, 0, LINK_CARRYING_SHOW_MS, () => [row("wwan0", bytes)]);
		expect(tracker.stateFor(row("wwan0", 0), LINK_CARRYING_SHOW_MS)).toBe(
			"not_carrying",
		);
		// One probe goes out, then nothing again.
		bytes += 1_400;
		tracker.observe([row("wwan0", bytes)], 6_000);
		tracker.observe([row("wwan0", bytes)], 7_000);
		expect(tracker.stateFor(row("wwan0", 0), 7_000)).toBe("not_carrying");
		// Real traffic resumes and keeps going.
		run(tracker, 8_000, 8_000 + LINK_CARRYING_CLEAR_MS, (t) => [
			row("wwan0", bytes + t),
		]);
		expect(
			tracker.stateFor(row("wwan0", 0), 8_000 + LINK_CARRYING_CLEAR_MS),
		).toBe("carrying");
	});

	test("a gap in the sender's reports starts every link over", () => {
		const tracker = new LinkProgressTracker();
		run(tracker, 0, LINK_CARRYING_SHOW_MS, () => [row("wwan0", 0)]);
		expect(tracker.stateFor(row("wwan0", 0), LINK_CARRYING_SHOW_MS)).toBe(
			"not_carrying",
		);
		tracker.markGap();
		tracker.observe([row("wwan0", 0)], 20_000);
		expect(tracker.stateFor(row("wwan0", 0), 20_000)).toBe("unknown");
	});

	test("a link that left the bond stops resolving", () => {
		const tracker = new LinkProgressTracker();
		run(tracker, 0, LINK_CARRYING_SHOW_MS, () => [row("wwan0", 0)]);
		tracker.observe([], 6_000);
		expect(tracker.stateFor(row("wwan0", 0), 6_000)).toBe("unknown");
		expect(tracker.stateForIface("wwan0", 6_000)).toBe("unknown");
	});

	test("rows are keyed by link id, so twins on one interface name stay apart", () => {
		const tracker = new LinkProgressTracker();
		const a = (b: number) => row("eth1", b, { link_id: "lnk_a" });
		const b = (v: number) => row("eth1", v, { link_id: "lnk_b" });
		run(tracker, 0, LINK_CARRYING_SHOW_MS, (t) => [a(t), b(0)]);
		expect(tracker.stateFor(a(0), LINK_CARRYING_SHOW_MS)).toBe("carrying");
		expect(tracker.stateFor(b(0), LINK_CARRYING_SHOW_MS)).toBe("not_carrying");
		// By interface, one carrying row is enough.
		expect(tracker.stateForIface("eth1", LINK_CARRYING_SHOW_MS)).toBe(
			"carrying",
		);
	});

	test("a CLAT translator's traffic counts for its modem", () => {
		const tracker = new LinkProgressTracker((iface) =>
			iface === "clat0" ? "wwan0" : undefined,
		);
		run(tracker, 0, LINK_CARRYING_SHOW_MS, () => [row("clat0", 0)]);
		expect(tracker.stateForIface("wwan0", LINK_CARRYING_SHOW_MS)).toBe(
			"not_carrying",
		);
		expect(tracker.stateForIface("clat0", LINK_CARRYING_SHOW_MS)).toBe(
			"unknown",
		);
		run(tracker, 6_000, 7_000, (t) => [row("clat0", t)]);
		expect(tracker.stateForIface("wwan0", 7_000)).toBe("not_carrying");
		run(tracker, 8_000, 8_000 + LINK_CARRYING_CLEAR_MS, (t) => [
			row("clat0", t),
		]);
		expect(tracker.stateForIface("wwan0", 8_000 + LINK_CARRYING_CLEAR_MS)).toBe(
			"carrying",
		);
	});

	test("not carrying by interface needs every row of it to be not carrying", () => {
		const tracker = new LinkProgressTracker();
		const a = row("wwan0", 0, { link_id: "lnk_a" });
		run(tracker, 0, LINK_CARRYING_SHOW_MS, () => [a]);
		// A second row of the same modem appears and has not had its dwell yet.
		tracker.observe(
			[a, row("wwan0", 0, { link_id: "lnk_b" })],
			LINK_CARRYING_SHOW_MS + 1_000,
		);
		expect(tracker.stateForIface("wwan0", LINK_CARRYING_SHOW_MS + 1_000)).toBe(
			"unknown",
		);
	});

	test("a sender without a byte counter never earns a 'not carrying'", () => {
		const tracker = new LinkProgressTracker();
		run(tracker, 0, 3 * LINK_CARRYING_SHOW_MS, () => [row("wwan0", undefined)]);
		expect(tracker.stateFor(row("wwan0", undefined), 15_000)).toBe("unknown");
	});

	test("a counter reset clears the verdict and restarts the dwell", () => {
		const tracker = new LinkProgressTracker();
		run(tracker, 0, LINK_CARRYING_SHOW_MS, () => [row("wwan0", 9_000)]);
		expect(tracker.stateFor(row("wwan0", 0), LINK_CARRYING_SHOW_MS)).toBe(
			"not_carrying",
		);
		// The sender rebuilt the link: its counter starts over at zero.
		tracker.observe([row("wwan0", 0)], 6_000);
		expect(tracker.stateFor(row("wwan0", 0), 6_000)).toBe("unknown");
		run(tracker, 7_000, 10_000, () => [row("wwan0", 0)]);
		expect(tracker.stateFor(row("wwan0", 0), 10_000)).toBe("unknown");
		run(tracker, 11_000, 11_000, () => [row("wwan0", 0)]);
		expect(tracker.stateFor(row("wwan0", 0), 11_000)).toBe("not_carrying");
	});

	test("a reset exactly at the dwell boundary earns no verdict from its first sample", () => {
		const tracker = new LinkProgressTracker();
		run(tracker, 0, LINK_CARRYING_SHOW_MS - 1_000, (t) => [row("wwan0", t)]);
		tracker.observe([row("wwan0", 0)], LINK_CARRYING_SHOW_MS + 5_000);
		expect(
			tracker.stateFor(row("wwan0", 0), LINK_CARRYING_SHOW_MS + 5_000),
		).toBe("unknown");
	});

	test("a missing counter in between clears the baseline", () => {
		const tracker = new LinkProgressTracker();
		run(tracker, 0, 4_000, () => [row("wwan0", 100)]);
		tracker.observe([row("wwan0", undefined)], 5_000);
		run(tracker, 6_000, 9_000, () => [row("wwan0", 100)]);
		expect(tracker.stateFor(row("wwan0", 0), 9_000)).toBe("unknown");
	});

	test("one sample after a long silence is not two samples", () => {
		// Two snapshots further apart than the evidence window are not a chain:
		// the second one starts the link over.
		const tracker = new LinkProgressTracker();
		tracker.observe([row("wwan0", 100)], 0);
		expect(tracker.stateFor(row("wwan0", 100), 4_999)).toBe("unknown");
		tracker.observe([row("wwan0", 100)], LINK_CARRYING_SHOW_MS);
		expect(tracker.stateFor(row("wwan0", 100), LINK_CARRYING_SHOW_MS)).toBe(
			"unknown",
		);
	});

	test("a zero-rate counter reset drops the progress the old counter showed", () => {
		const tracker = new LinkProgressTracker();
		tracker.observe([row("wwan0", 100)], 0);
		tracker.observe([row("wwan0", 200)], 1_000);
		tracker.observe([row("wwan0", 0)], 2_000);
		expect(tracker.stateFor(row("wwan0", 0), 2_000)).toBe("unknown");
	});

	test("a missing counter drops earlier progress too", () => {
		const tracker = new LinkProgressTracker();
		tracker.observe([row("wwan0", 100)], 0);
		tracker.observe([row("wwan0", 200)], 1_000);
		tracker.observe([row("wwan0", undefined)], 2_000);
		expect(tracker.stateFor(row("wwan0", undefined), 2_000)).toBe("unknown");
	});

	test("a reset with a measured rate is carrying from that rate alone", () => {
		const tracker = new LinkProgressTracker();
		tracker.observe([row("wwan0", 100)], 0);
		tracker.observe([row("wwan0", 0, { bitrate_bps: 900 })], 1_000);
		expect(tracker.stateFor(row("wwan0", 0), 1_000)).toBe("carrying");
	});

	test("a gap in the feed cannot supply the progress that clears a verdict", () => {
		const tracker = new LinkProgressTracker();
		run(tracker, 0, LINK_CARRYING_SHOW_MS, () => [row("wwan0", 0)]);
		expect(tracker.stateFor(row("wwan0", 0), LINK_CARRYING_SHOW_MS)).toBe(
			"not_carrying",
		);
		tracker.observe([row("wwan0", 10)], 6_000);
		tracker.observe([row("wwan0", 20)], 11_000);
		tracker.observe([row("wwan0", 20)], 16_000);
		expect(tracker.stateFor(row("wwan0", 20), 16_000)).toBe("unknown");
	});

	test("every verdict expires when the sender stops reporting", () => {
		const tracker = new LinkProgressTracker();
		run(tracker, 0, LINK_CARRYING_SHOW_MS, (t) => [
			row("wwan0", 0),
			row("wlan0", t),
		]);
		const later = LINK_CARRYING_SHOW_MS + LINK_CARRYING_EVIDENCE_MS + 1;
		expect(tracker.stateFor(row("wwan0", 0), later)).toBe("unknown");
		expect(tracker.stateFor(row("wlan0", 0), later)).toBe("unknown");
		expect(tracker.notCarryingIfaces(later)).toEqual([]);
		expect(tracker.notCarryingIfaces(LINK_CARRYING_SHOW_MS)).toEqual(["wwan0"]);
	});
});
