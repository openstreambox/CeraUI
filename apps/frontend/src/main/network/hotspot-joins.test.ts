/**
 * The join tracker behind "A new device joined": the first reading of each AP
 * lifetime is the baseline, a device is new only the first time this page sees
 * it on that lifetime, an unread roster on a live AP forgets nothing, and a
 * Stop, another radio or a replaced AP starts a new lifetime from nothing.
 */
import type { WifiInterface, WifiStatus } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { createHotspotJoinTracker, HOTSPOT_SEEN_CAP } from "./hotspot-joins";

function ap(
	macs: readonly string[] | undefined,
	overrides: Partial<WifiInterface> = {},
): WifiInterface {
	return {
		ifname: "wlan0",
		conn: "hotspot-uuid",
		hw: "58:02:05:e1:79:1c",
		saved: {},
		mode: "hotspot",
		hotspot: {
			available_channels: { auto: { name: "Automatic" } },
			name: "Box",
			password: "correcthorse",
			channel: "auto",
			...(macs === undefined
				? {}
				: {
						clients: {
							count: macs.length,
							stations: macs.map((mac) => ({ mac })),
						},
					}),
		},
		...overrides,
	};
}

/** The same radio with its AP stopped: a station row, no hotspot block. */
function stopped(): WifiInterface {
	return {
		ifname: "wlan0",
		conn: "",
		hw: "58:02:05:e1:79:1c",
		saved: {},
		mode: "station",
	};
}

const wifi = (
	...entries: Array<[string, readonly string[] | undefined]>
): WifiStatus =>
	Object.fromEntries(entries.map(([id, macs]) => [id, ap(macs)]));

/** The tracker, read as a total count of new devices per reading. */
function counting() {
	const tracker = createHotspotJoinTracker();
	return {
		observe: (snapshot: WifiStatus | undefined) =>
			tracker
				.observe(snapshot)
				.reduce((total, event) => total + event.count, 0),
	};
}

describe("createHotspotJoinTracker", () => {
	it("treats the first reading as the baseline", () => {
		const tracker = counting();
		expect(
			tracker.observe(wifi(["0", ["aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02"]])),
		).toBe(0);
	});

	it("counts each address it has not seen before", () => {
		const tracker = counting();
		tracker.observe(wifi(["0", ["aa:aa:aa:aa:aa:01"]]));
		expect(
			tracker.observe(
				wifi([
					"0",
					["aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02", "AA:AA:AA:AA:AA:03"],
				]),
			),
		).toBe(2);
		expect(tracker.observe(wifi(["0", ["aa:aa:aa:aa:aa:03"]]))).toBe(0);
	});

	it("does not re-announce a known phone that drops and rejoins", () => {
		const tracker = counting();
		tracker.observe(wifi(["0", []]));
		expect(tracker.observe(wifi(["0", ["aa:aa:aa:aa:aa:01"]]))).toBe(1);
		expect(tracker.observe(wifi(["0", []]))).toBe(0);
		// The AP is still up (a hotspot block) but its roster is unread for a
		// while, for example while it reapplies a new password: same lifetime.
		expect(tracker.observe(wifi(["0", undefined]))).toBe(0);
		expect(tracker.observe(wifi(["0", ["aa:aa:aa:aa:aa:01"]]))).toBe(0);
	});

	it("an empty roster is a reading: the next device is new", () => {
		const tracker = counting();
		expect(tracker.observe(wifi(["0", []]))).toBe(0);
		expect(tracker.observe(wifi(["0", ["aa:aa:aa:aa:aa:09"]]))).toBe(1);
	});

	it("keeps access points apart", () => {
		const tracker = counting();
		tracker.observe(wifi(["0", ["aa:aa:aa:aa:aa:01"]], ["1", undefined]));
		// The second AP's first reading is its own baseline.
		expect(
			tracker.observe(
				wifi(["0", ["aa:aa:aa:aa:aa:01"]], ["1", ["aa:aa:aa:aa:aa:01"]]),
			),
		).toBe(0);
		expect(
			tracker.observe(
				wifi(
					["0", ["aa:aa:aa:aa:aa:01"]],
					["1", ["aa:aa:aa:aa:aa:01", "bb:bb:bb:bb:bb:01"]],
				),
			),
		).toBe(1);
	});

	it("ignores a missing snapshot", () => {
		const tracker = counting();
		expect(tracker.observe(undefined)).toBe(0);
	});

	it("remembers a bounded number of addresses, dropping the oldest", () => {
		const tracker = counting();
		const mac = (n: number) =>
			`cc:cc:cc:cc:${(n >> 8).toString(16).padStart(2, "0")}:${(n & 255).toString(16).padStart(2, "0")}`;
		tracker.observe(wifi(["0", []]));
		for (let n = 0; n <= HOTSPOT_SEEN_CAP; n++)
			tracker.observe(wifi(["0", [mac(n)]]));
		// The very first address fell out of the window; the newest did not.
		expect(tracker.observe(wifi(["0", [mac(HOTSPOT_SEEN_CAP)]]))).toBe(0);
		expect(tracker.observe(wifi(["0", [mac(0)]]))).toBe(1);
	});

	it("names the access point each join happened on", () => {
		const tracker = createHotspotJoinTracker();
		const snapshot = (a: string[], b: string[]): WifiStatus => ({
			"0": { ...ap(a), incarnation: "radio-A" },
			"1": { ...ap(b), incarnation: "radio-B" },
		});
		tracker.observe(snapshot(["aa:aa:aa:aa:aa:01"], ["bb:bb:bb:bb:bb:01"]));
		expect(
			tracker.observe(
				snapshot(
					["aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02"],
					["bb:bb:bb:bb:bb:01"],
				),
			),
		).toEqual([
			{
				device: "0",
				incarnation: "radio-A",
				lifetime: tracker.lifetimeOf("0", snapshot([], [])["0"]),
				count: 1,
			},
		]);
	});
});

describe("AP lifetimes", () => {
	const A1 = "aa:aa:aa:aa:aa:01";
	const A2 = "aa:aa:aa:aa:aa:02";
	const A3 = "aa:aa:aa:aa:aa:03";

	it("a Stop and Start is a new lifetime with its own baseline and roster", () => {
		const tracker = createHotspotJoinTracker();
		tracker.observe({ "0": ap([A1]) });
		const first = tracker.lifetimeOf("0", ap([A1]));
		expect(first).toBeTypeOf("number");
		expect(tracker.observe({ "0": stopped() })).toEqual([]);
		expect(tracker.lifetimeOf("0", stopped())).toBeUndefined();
		// The restarted AP's first reading is a baseline, even with a phone on it
		// that the previous lifetime never saw.
		expect(tracker.observe({ "0": ap([A2]) })).toEqual([]);
		const second = tracker.lifetimeOf("0", ap([A2]));
		expect(second).not.toBe(first);
		// Its roster starts from nothing: A1 joining now is this lifetime's join.
		expect(tracker.observe({ "0": ap([A2, A1]) })).toEqual([
			{ device: "0", incarnation: undefined, lifetime: second, count: 1 },
		]);
	});

	it("another radio under the same key starts over instead of diffing against the old one", () => {
		const tracker = createHotspotJoinTracker();
		tracker.observe({ "0": ap([A1], { incarnation: "radio-A" }) });
		// Radio B already has two phones on it: nothing is announced.
		expect(
			tracker.observe({ "0": ap([A2, A3], { incarnation: "radio-B" }) }),
		).toEqual([]);
		expect(
			tracker.lifetimeOf("0", ap([], { incarnation: "radio-A" })),
		).toBeUndefined();
	});

	it("a late frame from an earlier AP never announces against the current one", () => {
		const tracker = createHotspotJoinTracker();
		tracker.observe({ "0": ap([A1], { incarnation: "radio-A" }) });
		tracker.observe({ "0": ap([A2], { incarnation: "radio-B" }) });
		// A frame that still names radio A, now with a phone it never had.
		expect(
			tracker.observe({ "0": ap([A1, A3], { incarnation: "radio-A" }) }),
		).toEqual([]);
		// Back on B: a new lifetime again, so B's earlier roster is not diffed.
		expect(
			tracker.observe({ "0": ap([A2, A3], { incarnation: "radio-B" }) }),
		).toEqual([]);
	});

	it("a renamed interface under the same radio token is the same AP", () => {
		const tracker = createHotspotJoinTracker();
		tracker.observe({ "0": ap([A1], { incarnation: "radio-A" }) });
		const renamed = { incarnation: "radio-A", ifname: "wlx00c0ca000001" };
		expect(tracker.observe({ "0": ap([A1, A2], renamed) })).toHaveLength(1);
	});

	it("a replaced AP (other profile, other mode) is a new lifetime", () => {
		for (const replaced of [
			{ conn: "other-uuid" },
			{ mode: "station" as const },
		]) {
			const tracker = createHotspotJoinTracker();
			tracker.observe({ "0": ap([A1]) });
			expect(tracker.observe({ "0": ap([A1, A2], replaced) })).toEqual([]);
			expect(tracker.lifetimeOf("0", ap([]))).toBeUndefined();
		}
	});

	it("a profile UUID that only became known is the same AP", () => {
		const tracker = createHotspotJoinTracker();
		tracker.observe({ "0": ap([A1], { conn: "" }) });
		expect(tracker.observe({ "0": ap([A1, A2]) })).toHaveLength(1);
		// A hybrid AP's conn is the station's and never splits the lifetime.
		const hybrid = createHotspotJoinTracker();
		hybrid.observe({ "0": ap([A1], { mode: "station", conn: "sta-1" }) });
		expect(
			hybrid.observe({ "0": ap([A1, A2], { mode: "station", conn: "sta-2" }) }),
		).toHaveLength(1);
	});

	it("a radio that leaves the snapshot ends its lifetime", () => {
		const tracker = createHotspotJoinTracker();
		tracker.observe({ "0": ap([A1]) });
		tracker.observe({});
		expect(tracker.observe({ "0": ap([A1, A2]) })).toEqual([]);
	});
});
