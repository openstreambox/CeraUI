import { afterEach, expect, spyOn, test } from "bun:test";
import {
	MOCK_CLOCK_EPOCH_MS,
	mixSeed,
	mockNow,
	mockRandom,
	mockRandomFor,
	mulberry32,
	pinMockClock,
	unpinMockClock,
} from "../mocks/mock-clock.ts";

afterEach(() => {
	unpinMockClock();
});

test("mulberry32 is a fixed sequence for a seed", () => {
	const a = mulberry32(4711);
	const b = mulberry32(4711);
	const first = [a(), a(), a()];
	expect([b(), b(), b()]).toEqual(first);
	for (const value of first) {
		expect(value).toBeGreaterThanOrEqual(0);
		expect(value).toBeLessThan(1);
	}
	expect(mulberry32(4712)()).not.toBe(first[0]);
});

test("unpinned, the mock clock is exactly Math.random and Date.now", () => {
	const random = spyOn(Math, "random").mockReturnValue(0.25);
	const now = spyOn(Date, "now").mockReturnValue(1_234);
	try {
		expect(mockRandom()).toBe(0.25);
		expect(mockRandomFor("relay.x")).toBe(0.25);
		expect(mockNow()).toBe(1_234);
		expect(random).toHaveBeenCalledTimes(2);
	} finally {
		random.mockRestore();
		now.mockRestore();
	}
});

test("a pinned step gives the same draws whenever it is pinned again", () => {
	pinMockClock(4711, 20_000);
	const first = [mockRandom(), mockRandom(), mockRandom()];
	expect(mockNow()).toBe(MOCK_CLOCK_EPOCH_MS + 20_000);
	pinMockClock(4711, 21_000);
	const other = mockRandom();
	pinMockClock(4711, 20_000);
	expect([mockRandom(), mockRandom(), mockRandom()]).toEqual(first);
	expect(other).not.toBe(first[0]);
});

test("a pinned clock ignores the host's clock and generator", () => {
	const random = spyOn(Math, "random");
	try {
		pinMockClock(1, 5_000);
		const before = mockNow();
		Bun.sleepSync(5);
		expect(mockNow()).toBe(before);
		mockRandom();
		mockRandomFor("relay.a");
		expect(random).not.toHaveBeenCalled();
	} finally {
		random.mockRestore();
	}
});

test("keyed draws are stable within a step, whatever the number of reads", () => {
	pinMockClock(7, 3_000);
	const a = mockRandomFor("relay.eu");
	mockRandom();
	mockRandom();
	expect(mockRandomFor("relay.eu")).toBe(a);
	expect(mockRandomFor("relay.us")).not.toBe(a);
	pinMockClock(7, 4_000);
	expect(mockRandomFor("relay.eu")).not.toBe(a);
});

test("seed and step both enter the mixed seed", () => {
	expect(mixSeed(1, 0)).not.toBe(mixSeed(2, 0));
	expect(mixSeed(1, 0)).not.toBe(mixSeed(1, 1000));
	expect(mixSeed(1, 1000)).toBe(mixSeed(1, 1000));
});

test("pinning refuses a non-integer seed or a negative step", () => {
	expect(() => pinMockClock(1.5, 0)).toThrow(RangeError);
	expect(() => pinMockClock(1, -1)).toThrow(RangeError);
});
