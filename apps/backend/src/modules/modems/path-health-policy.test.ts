import { expect, test } from "bun:test";
import {
	initialPathHealth,
	observeAvailability,
	observePathProbe,
	reservePathProbe,
} from "./path-health-policy.ts";

test("whole-device outage and 50-second return cannot count as carrier failures", () => {
	let state = observeAvailability(initialPathHealth(10_000), "one", 0).state;
	state = observePathProbe(state, "one", 0, true).state;
	state = observeAvailability(state, undefined, 1000).state;
	expect(state.ready).toBe(false);
	expect(observeAvailability(state, undefined, 51_000).availability).toBe(
		"usb-wait",
	);
	expect(observeAvailability(state, undefined, 76_000).availability).toBe(
		"usb-absent",
	);
	const returned = observeAvailability(state, "two", 51_000);
	expect(returned.availability).toBe("settling");
	expect(returned.state.reconnects).toBe(0);
	expect(reservePathProbe(returned.state, "two", 65_999, 100)).toBeUndefined();
	expect(
		observePathProbe(returned.state, "one", 70_000, true).state.ready,
	).toBe(false);
	expect(observeAvailability(returned.state, "two", 66_000).availability).toBe(
		"present",
	);
});

test("two failures reconnect with capped backoff; success resets hysteresis", () => {
	let state = observeAvailability(initialPathHealth(10_000), "one", 0).state;
	let now = 0;
	for (const delay of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
		const first = observePathProbe(state, "one", now, false);
		expect(first.reconnect).toBe(false);
		expect(first.state.ready).toBe(false);
		const second = observePathProbe(first.state, "one", now + 30_000, false);
		expect(second.reconnect).toBe(true);
		expect(second.state.nextProbe).toBe(now + 30_000 + delay);
		state = second.state;
		now = state.nextProbe;
	}
	const healthy = observePathProbe(state, "one", now, true).state;
	expect(healthy).toMatchObject({
		ready: true,
		reconnects: 0,
		failures: 0,
		nextProbe: now + 300_000,
	});
});

test("budget is reserved before probes and cannot reset on re-enumeration", () => {
	const state = observeAvailability(initialPathHealth(100), "one", 0).state;
	const reserved = reservePathProbe(state, "one", 0, 100);
	expect(reserved?.budgetRemaining).toBe(0);
	expect(
		reserved && reservePathProbe(reserved, "one", 30_000, 1),
	).toBeUndefined();
	expect(reservePathProbe(state, "other", 0, 1)).toBeUndefined();
	expect(reservePathProbe(state, "one", 0, -1)).toBeUndefined();
	if (!reserved) throw new Error("Expected reservation");
	const unplugged = observeAvailability(reserved, undefined, 100).state;
	const returned = observeAvailability(unplugged, "two", 1000).state;
	expect(returned.budgetRemaining).toBe(0);
});
