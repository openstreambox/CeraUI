import { describe, expect, it } from "vitest";

import { HOT_C, thermalBand, WARM_C } from "./thermal";

describe("thermalBand — when Settings says the box is warm or hot", () => {
	it("says nothing for a normal temperature or no reading", () => {
		expect(thermalBand(null)).toBeNull();
		expect(thermalBand(undefined)).toBeNull();
		expect(thermalBand(45)).toBeNull();
		expect(thermalBand(69.9)).toBeNull();
	});

	it("is warm from 70 °C, the line Phone home already treats as no longer fine", () => {
		expect(WARM_C).toBe(70);
		expect(thermalBand(70)).toBe("warm");
		expect(thermalBand(84.9)).toBe("warm");
	});

	it("is hot from 85 °C, the passive trip point in the RK3588 device trees", () => {
		expect(HOT_C).toBe(85);
		expect(thermalBand(85)).toBe("hot");
		expect(thermalBand(101)).toBe("hot");
	});

	it("ignores a reading that is not a finite number", () => {
		expect(thermalBand(Number.NaN)).toBeNull();
		expect(thermalBand(Number.POSITIVE_INFINITY)).toBeNull();
	});
});
