import { describe, expect, it } from "vitest";

import {
	EXPIRES_SOON_MS,
	formatExpiryDate,
	remoteAccessExpiry,
} from "./remote-access-expiry";

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("remoteAccessExpiry", () => {
	it("connected without an expiry never expires", () => {
		expect(remoteAccessExpiry({ state: "connected" }, NOW)).toEqual({
			kind: "never",
		});
	});

	it("warns within 30 days, and right at the boundary", () => {
		expect(
			remoteAccessExpiry(
				{ state: "connected", keyExpiry: iso(NOW + 90 * DAY) },
				NOW,
			)?.kind,
		).toBe("later");
		expect(
			remoteAccessExpiry(
				{ state: "connected", keyExpiry: iso(NOW + EXPIRES_SOON_MS + 1) },
				NOW,
			)?.kind,
		).toBe("later");
		expect(
			remoteAccessExpiry(
				{ state: "connected", keyExpiry: iso(NOW + EXPIRES_SOON_MS) },
				NOW,
			)?.kind,
		).toBe("soon");
		expect(
			remoteAccessExpiry({ state: "connected", keyExpiry: iso(NOW + DAY) }, NOW)
				?.kind,
		).toBe("soon");
		// tailscaled has not noticed yet: still a warning, not "expired"
		expect(
			remoteAccessExpiry({ state: "connected", keyExpiry: iso(NOW - DAY) }, NOW)
				?.kind,
		).toBe("soon");
	});

	it("an expired login is expired only once its date has passed, by the viewer clock", () => {
		expect(
			remoteAccessExpiry({ state: "needs_key", keyExpiry: iso(NOW - DAY) }, NOW)
				?.kind,
		).toBe("expired");
		expect(
			remoteAccessExpiry(
				{ state: "needs_key", keyExpiry: iso(NOW + DAY) },
				NOW,
			),
		).toBeUndefined();
		expect(remoteAccessExpiry({ state: "needs_key" }, NOW)).toBeUndefined();
	});

	it("says nothing for other states or no status", () => {
		for (const state of [
			"off",
			"needs_approval",
			"joining",
			"unknown",
			"unavailable",
		] as const) {
			expect(
				remoteAccessExpiry({ state, keyExpiry: iso(NOW - DAY) }, NOW),
			).toBeUndefined();
		}
		expect(remoteAccessExpiry(undefined, NOW)).toBeUndefined();
	});

	it("formats the date in the viewer language without a time", () => {
		const at = new Date(Date.UTC(2027, 3, 2, 12));
		expect(formatExpiryDate(at, "en")).toBe("Apr 2, 2027");
		expect(formatExpiryDate(at, "de")).toBe("02.04.2027");
	});
});
