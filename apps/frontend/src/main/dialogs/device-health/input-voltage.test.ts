import { describe, expect, it } from "vitest";

import {
	formatInputVolts,
	INPUT_HIGH_V,
	INPUT_LOW_V,
	INPUT_VERY_LOW_V,
	inputVoltageLevel,
} from "./input-voltage";

describe("inputVoltageLevel", () => {
	it("pins each boundary on both sides", () => {
		expect(inputVoltageLevel(6.9)).toBe("very-low");
		expect(inputVoltageLevel(7.0)).toBe("low");
		expect(inputVoltageLevel(10.9)).toBe("low");
		expect(inputVoltageLevel(11.0)).toBe("ok");
		expect(inputVoltageLevel(13.5)).toBe("ok");
		expect(inputVoltageLevel(13.6)).toBe("high");
	});

	it("reads the measured supplies as expected", () => {
		expect(inputVoltageLevel(4.87)).toBe("very-low"); // a 5 V feed
		expect(inputVoltageLevel(12.13)).toBe("ok"); // 12 V under encode load
		expect(inputVoltageLevel(12.33)).toBe("ok");
	});

	it("keeps the thresholds where the copy says they are", () => {
		expect([INPUT_VERY_LOW_V, INPUT_LOW_V, INPUT_HIGH_V]).toEqual([
			7, 11, 13.5,
		]);
	});
});

describe("formatInputVolts", () => {
	it("prints one decimal and the unit", () => {
		expect(formatInputVolts(12.149)).toBe("12.1 V");
		expect(formatInputVolts(4.87)).toBe("4.9 V");
	});
});
