/**
 * The join tracker behind "A new device joined": the first reading of an access
 * point is the baseline, a device is new only the first time this page sees it,
 * and an absent roster (hotspot stopped, not read yet) forgets nothing.
 */
import type { WifiInterface, WifiStatus } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { createHotspotJoinTracker, HOTSPOT_SEEN_CAP } from "./hotspot-joins";

function ap(macs: readonly string[] | undefined): WifiInterface {
	return {
		ifname: "wlan0",
		conn: "hotspot-uuid",
		hw: "58:02:05:e1:79:1c",
		saved: {},
		mode: "hotspot",
		hotspot: {
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
	};
}

const wifi = (
	...entries: Array<[string, readonly string[] | undefined]>
): WifiStatus =>
	Object.fromEntries(entries.map(([id, macs]) => [id, ap(macs)]));

describe("createHotspotJoinTracker", () => {
	it("treats the first reading as the baseline", () => {
		const tracker = createHotspotJoinTracker();
		expect(
			tracker.observe(wifi(["0", ["aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02"]])),
		).toBe(0);
	});

	it("counts each address it has not seen before", () => {
		const tracker = createHotspotJoinTracker();
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
		const tracker = createHotspotJoinTracker();
		tracker.observe(wifi(["0", []]));
		expect(tracker.observe(wifi(["0", ["aa:aa:aa:aa:aa:01"]]))).toBe(1);
		expect(tracker.observe(wifi(["0", []]))).toBe(0);
		// The hotspot restarted (new password): its roster is absent for a while.
		expect(tracker.observe(wifi(["0", undefined]))).toBe(0);
		expect(tracker.observe(wifi(["0", ["aa:aa:aa:aa:aa:01"]]))).toBe(0);
	});

	it("an empty roster is a reading: the next device is new", () => {
		const tracker = createHotspotJoinTracker();
		expect(tracker.observe(wifi(["0", []]))).toBe(0);
		expect(tracker.observe(wifi(["0", ["aa:aa:aa:aa:aa:09"]]))).toBe(1);
	});

	it("keeps access points apart", () => {
		const tracker = createHotspotJoinTracker();
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
		const tracker = createHotspotJoinTracker();
		expect(tracker.observe(undefined)).toBe(0);
	});

	it("remembers a bounded number of addresses, dropping the oldest", () => {
		const tracker = createHotspotJoinTracker();
		const mac = (n: number) =>
			`cc:cc:cc:cc:${(n >> 8).toString(16).padStart(2, "0")}:${(n & 255).toString(16).padStart(2, "0")}`;
		tracker.observe(wifi(["0", []]));
		for (let n = 0; n <= HOTSPOT_SEEN_CAP; n++)
			tracker.observe(wifi(["0", [mac(n)]]));
		// The very first address fell out of the window; the newest did not.
		expect(tracker.observe(wifi(["0", [mac(HOTSPOT_SEEN_CAP)]]))).toBe(0);
		expect(tracker.observe(wifi(["0", [mac(0)]]))).toBe(1);
	});
});
