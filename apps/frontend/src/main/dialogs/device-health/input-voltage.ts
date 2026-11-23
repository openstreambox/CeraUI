/**
 * The board's DC-in voltage, as the backend reads it from the SoC ADC (ROCK 5B+
 * only). Voltage is all the board can measure: no PD contract and no current,
 * so a level here describes the reading and never the supply's wattage.
 *
 * The ROCK 5B+ boxes are built for a 12 V USB-C PD supply. Measured on boxes in
 * use: 12.1-12.3 V on a 12 V supply, idle and under encode load; 4.7-4.9 V on a
 * supply that gave no 12 V. Thresholds sit well clear of both.
 */

export type InputVoltageLevel = "very-low" | "low" | "ok" | "high";

/** Below this the board is on a 5 V feed (or no PD contract at all). */
export const INPUT_VERY_LOW_V = 7;
/** Below this the board is not on 12 V, or the 12 V sags under load. */
export const INPUT_LOW_V = 11;
/** Above this the supply gave more than the 12 V the board usually gets. */
export const INPUT_HIGH_V = 13.5;

export function inputVoltageLevel(volts: number): InputVoltageLevel {
	if (volts < INPUT_VERY_LOW_V) return "very-low";
	if (volts < INPUT_LOW_V) return "low";
	if (volts > INPUT_HIGH_V) return "high";
	return "ok";
}

export function formatInputVolts(volts: number): string {
	return `${volts.toFixed(1)} V`;
}
