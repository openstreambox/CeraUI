/**
 * When Settings mentions the box's temperature at all.
 *
 * The full temperature reading lives in Device stats and, over time, in Device
 * Health. The top of Settings only says something when the reading asks for
 * attention: warm from 70 °C (the line the phone home screen already treats as
 * no longer fine) and hot from 85 °C (the passive trip point in the RK3588
 * device trees, where the kernel starts cooling the CPU by slowing it).
 */
export const WARM_C = 70;
export const HOT_C = 85;

export type ThermalBand = "warm" | "hot";

export function thermalBand(
	celsius: number | null | undefined,
): ThermalBand | null {
	if (typeof celsius !== "number" || !Number.isFinite(celsius)) return null;
	if (celsius >= HOT_C) return "hot";
	if (celsius >= WARM_C) return "warm";
	return null;
}
