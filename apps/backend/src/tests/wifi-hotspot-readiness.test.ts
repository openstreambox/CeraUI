import { expect, test } from "bun:test";
import {
	HOTSPOT_READINESS_TIMEOUT_MS,
	waitForHotspotReadiness,
} from "../modules/wifi/wifi-hotspot-readiness.ts";

function fakeClock() {
	let time = 0;
	return {
		now: () => time,
		wait: async (ms: number) => {
			time += ms;
		},
	};
}

for (const delay of [3500, 7900, 15_000]) {
	test(`delayed steering readback at ${delay}ms completes ready without retrying Start`, async () => {
		const clock = fakeClock();
		const result = await waitForHotspotReadiness(
			"wlan0",
			async () => clock.now() >= delay,
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
		await waitForHotspotReadiness("wlan0", async () => false, clock),
	).toEqual({
		success: true,
		pending: true,
		reason: "steering-readiness-timeout",
	});
	expect(clock.now()).toBe(20_000);
});
test("a readback exception can recover inside the readiness window", async () => {
	const clock = fakeClock();
	expect(
		await waitForHotspotReadiness(
			"wlan0",
			async () => {
				if (clock.now() < 5000) throw new Error("read unavailable");
				return true;
			},
			clock,
		),
	).toEqual({ success: true });
});

test("a stuck reconciliation cannot extend the hard deadline", async () => {
	const started = performance.now();
	const result = await waitForHotspotReadiness(
		"wlan0",
		() => new Promise(() => {}),
	);
	expect(result).toEqual({
		success: true,
		pending: true,
		reason: "steering-readiness-timeout",
	});
	expect(performance.now() - started).toBeLessThan(22_000);
}, 25_000);
