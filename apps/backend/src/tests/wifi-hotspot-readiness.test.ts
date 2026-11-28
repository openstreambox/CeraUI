import { afterEach, expect, test } from "bun:test";
import {
	beginSteeringVerification,
	enableSteeringReadiness,
	hotspotSteeringPending,
	hotspotSteeringVerified,
	publishSteeringReadiness,
	resetSteeringReadinessForTest,
	steeringVerificationMark,
} from "../modules/network/uplink-steering/readiness.ts";
import {
	awaitHotspotSteering,
	HOTSPOT_READINESS_TIMEOUT_MS,
	type HotspotSteeringFence,
} from "../modules/wifi/wifi-hotspot-readiness.ts";

afterEach(resetSteeringReadinessForTest);

function fakeClock() {
	let time = 0;
	return {
		now: () => time,
		wait: async (ms: number) => {
			time += ms;
		},
	};
}

function fence(owned: () => boolean = () => true): HotspotSteeringFence {
	return { apIfname: "wlan0", uuid: "ap0", incarnation: 7, since: 0, owned };
}

for (const delay of [3500, 7900, 15_000]) {
	test(`delayed steering readback at ${delay}ms completes ready without retrying Start`, async () => {
		const clock = fakeClock();
		const result = await awaitHotspotSteering(
			fence(),
			{ reconcile: async () => {}, verified: () => clock.now() >= delay },
			clock,
		);
		expect(result).toEqual({ success: true });
		expect(clock.now()).toBeGreaterThanOrEqual(delay);
		expect(clock.now()).toBeLessThan(HOTSPOT_READINESS_TIMEOUT_MS);
	});
}

test("unconfirmed steering at deadline is pending, without a failure verdict", async () => {
	const clock = fakeClock();
	expect(
		await awaitHotspotSteering(
			fence(),
			{ reconcile: async () => {}, verified: () => false },
			clock,
		),
	).toEqual({
		success: true,
		pending: true,
		reason: "steering-readiness-timeout",
	});
	expect(clock.now()).toBe(20_000);
});

test("a reconcile exception can recover inside the readiness window", async () => {
	const clock = fakeClock();
	expect(
		await awaitHotspotSteering(
			fence(),
			{
				reconcile: async () => {
					if (clock.now() < 5000) throw new Error("read unavailable");
				},
				verified: () => clock.now() >= 5000,
			},
			clock,
		),
	).toEqual({ success: true });
});

test("a superseded Start returns nothing, even when verification arrives", async () => {
	const clock = fakeClock();
	let current = true;
	const result = await awaitHotspotSteering(
		fence(() => current),
		{
			reconcile: async () => {
				current = false;
			},
			// The verification lands only after the Start was superseded.
			verified: () => !current,
		},
		clock,
	);
	expect(result).toBeUndefined();
});

test("a stuck reconciliation cannot extend the hard deadline", async () => {
	const started = performance.now();
	const result = await awaitHotspotSteering(fence(), {
		reconcile: () => new Promise(() => {}),
		verified: () => false,
	});
	expect(result).toEqual({
		success: true,
		pending: true,
		reason: "steering-readiness-timeout",
	});
	expect(performance.now() - started).toBeLessThan(22_000);
}, 25_000);

const ZONE = [{ ifname: "wlan0", ipv4Cidr: "10.42.0.0/24" }];

/** A verification whose plan saw `wlan0` at lifetime `entry` and read back `after`. */
function verify(entry: number | undefined, after: number | undefined = entry) {
	const begun = beginSteeringVerification(["wlan0"], () => entry);
	publishSteeringReadiness(ZONE, begun, () => after);
}

test("only a verification after the confirmation, for the same AP lifetime, counts", () => {
	enableSteeringReadiness();
	verify(7);
	const since = steeringVerificationMark();
	// Verified before the confirmation: not proof for this Start.
	expect(hotspotSteeringVerified("wlan0", 7, since)).toBe(false);
	verify(8);
	// A newer verification of another lifetime under the same name.
	expect(hotspotSteeringVerified("wlan0", 7, since)).toBe(false);
	verify(7);
	expect(hotspotSteeringVerified("wlan0", 7, since)).toBe(true);
	expect(hotspotSteeringVerified("wlan0", undefined, since)).toBe(false);
	publishSteeringReadiness([]);
	expect(hotspotSteeringVerified("wlan0", 7, since)).toBe(false);
});

test("a verification in flight at the confirmation does not certify it", () => {
	enableSteeringReadiness();
	// Planned (and its lifetimes taken) before NM confirmed the AP...
	const inFlight = beginSteeringVerification(["wlan0"], () => 7);
	const since = steeringVerificationMark();
	// ...and read back after: same lifetime, but it began too early.
	publishSteeringReadiness(ZONE, inFlight, () => 7);
	expect(hotspotSteeringVerified("wlan0", 7, since)).toBe(false);
	verify(7);
	expect(hotspotSteeringVerified("wlan0", 7, since)).toBe(true);
});

test("a zone whose AP lifetime changed between plan and readback is left out", () => {
	enableSteeringReadiness();
	const since = steeringVerificationMark();
	// The plan was built for lifetime 7; the readback finds a new lifetime 8.
	verify(7, 8);
	expect(hotspotSteeringVerified("wlan0", 7, since)).toBe(false);
	expect(hotspotSteeringVerified("wlan0", 8, since)).toBe(false);
	expect(hotspotSteeringPending("wlan0", 8)).toBe(true);
	// An interface that had no lifetime at plan time is never verified.
	verify(undefined, 8);
	expect(hotspotSteeringVerified("wlan0", 8, since)).toBe(false);
	// Without the plan's entry nothing is verified either.
	publishSteeringReadiness(ZONE);
	expect(hotspotSteeringPending("wlan0", 8)).toBe(true);
	verify(8);
	expect(hotspotSteeringVerified("wlan0", 8, since)).toBe(true);
	expect(hotspotSteeringPending("wlan0", 8)).toBe(false);
});

test("the status hint names the AP lifetime, not just the name", () => {
	enableSteeringReadiness();
	verify(7);
	expect(hotspotSteeringPending("wlan0", 7)).toBe(false);
	// The same name with a new lifetime is still waiting.
	expect(hotspotSteeringPending("wlan0", 8)).toBe(true);
	expect(hotspotSteeringPending("wlan0", undefined)).toBe(true);
});

test("without steering nothing waits and no AP shows as pending", () => {
	expect(hotspotSteeringVerified("wlan0", undefined, 0)).toBe(true);
	expect(hotspotSteeringPending("wlan0", 7)).toBe(false);
	enableSteeringReadiness();
	expect(hotspotSteeringPending("wlan0", 7)).toBe(true);
});
