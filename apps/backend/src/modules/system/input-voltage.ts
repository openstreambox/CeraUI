/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
  Board input voltage (DC-in) read from the SoC's own ADC.

  Which boards can measure it is a per-board fact from the schematic, kept in
  BOARD_INPUT_PROFILES and matched on the exact device-tree compatible entry.
  A board that is not in the table, or whose profile says it has no input
  sense, publishes nothing: a number from an unwired ADC channel would be
  fabricated, so "not available" is the only safe answer there.

  - Radxa ROCK 5B+: the USB-C power input reaches SARADC channel 6 through a
    100k / 8.2k divider (Radxa schematic), so the input is
    `in_voltage6_raw * in_voltage_scale * (100 + 8.2) / 8.2` mV. Board-checked
    against a manual read on the current image.
  - Orange Pi 5 Plus: no SARADC channel is wired to the power input. The
    schematic (V1.1) puts the boot strap, recovery key, LCD ID, headphone
    hook and expansion on channels 0-4 and leaves 5-7 unused; channels 5-7
    read as floating on a board. Its USB-C power input is a fixed 5 V supply.

  It is the voltage only. The PD contract and the current are not measurable
  from these boards, so nothing here claims either. The ADC is found by its
  platform name: `fec10000.adc` on the current kernel, `fec10000.saradc` on
  the older vendor kernel.
*/

import { readdir } from "node:fs/promises";

export const INPUT_VOLTAGE_SENSOR = "Input voltage";

/** How a board can (or cannot) measure its own power input. */
export type InputSense =
	| { readonly kind: "adc"; readonly channel: number; readonly ratio: number }
	| { readonly kind: "none" };

export interface BoardInputProfile {
	readonly board: string;
	/** Exact device-tree compatible entries, any of which selects the board. */
	readonly compatibles: readonly string[];
	readonly sense: InputSense;
}

/** (100k + 8.2k) / 8.2k, the ROCK 5B+ input divider. */
export const ROCK_5B_PLUS_DIVIDER = (100 + 8.2) / 8.2;

export const BOARD_INPUT_PROFILES: readonly BoardInputProfile[] = [
	{
		board: "rock-5b-plus",
		compatibles: ["radxa,rock-5b-plus"],
		sense: { kind: "adc", channel: 6, ratio: ROCK_5B_PLUS_DIVIDER },
	},
	{
		board: "orangepi-5-plus",
		// Mainline and the vendor 5.10 kernel name the board differently.
		compatibles: ["xunlong,orangepi-5-plus", "rockchip,rk3588-orangepi-5-plus"],
		sense: { kind: "none" },
	},
];

const IIO_ROOT = "/sys/bus/iio/devices";
const ADC_NAME_RE = /^fec10000\.(?:sar)?adc$/;

/** Below this the input is off or the read is bad, not a reading. */
const MIN_VOLTS = 0.5;
/**
 * The RK3588 SARADC is 12-bit: 4095 is full scale, and a full-scale read means
 * the pin is at or above the reference, so the true input is unknown (on the
 * ROCK 5B+ divider that is anything from about 23.7 V up). Rejected, never
 * shown as a number.
 */
export const ADC_FULL_SCALE_RAW = 4095;

export type InputVoltageDeps = {
	readCompatible: () => Promise<string>;
	listIioDevices: () => Promise<string[]>;
	readText: (path: string) => Promise<string>;
};

export const defaultInputVoltageDeps: InputVoltageDeps = {
	readCompatible: () => Bun.file("/proc/device-tree/compatible").text(),
	listIioDevices: () => readdir(IIO_ROOT),
	readText: (path) => Bun.file(path).text(),
};

/**
 * The profile for a device-tree compatible list (NUL-separated), or undefined
 * for a board this table does not know.
 */
export function inputProfileFor(
	compatible: string,
): BoardInputProfile | undefined {
	const entries = new Set(compatible.split("\0").map((entry) => entry.trim()));
	return BOARD_INPUT_PROFILES.find((profile) =>
		profile.compatibles.some((name) => entries.has(name)),
	);
}

/**
 * Convert one ADC read to volts at the board input, or null when the read is
 * not a plausible DC-in voltage: garbled, saturated, or below MIN_VOLTS.
 */
export function inputVoltsFromAdc(
	raw: string,
	scale: string,
	ratio: number,
): number | null {
	const r = Number.parseInt(raw.trim(), 10);
	const s = Number.parseFloat(scale.trim());
	if (!Number.isFinite(r) || !Number.isFinite(s) || r < 0 || s <= 0) {
		return null;
	}
	if (r >= ADC_FULL_SCALE_RAW) return null;
	const volts = (r * s * ratio) / 1000;
	return volts >= MIN_VOLTS ? volts : null;
}

/**
 * Reader with the board profile and the ADC lookup resolved once. A board with
 * no ADC input sense (or none in the table) stays off for the life of the
 * process. An unreadable device tree, a missing ADC and a failed channel read
 * are each retried on the next read (the driver can bind late, and the IIO
 * device number can change when it rebinds).
 */
export function createInputVoltageReader(
	deps: InputVoltageDeps = defaultInputVoltageDeps,
) {
	let sense: InputSense | undefined;
	let adcDir: string | undefined;

	async function findAdc(): Promise<string | undefined> {
		let entries: string[];
		try {
			entries = await deps.listIioDevices();
		} catch {
			return undefined;
		}
		for (const entry of entries
			.filter((e) => e.startsWith("iio:device"))
			.sort()) {
			const dir = `${IIO_ROOT}/${entry}`;
			try {
				if (ADC_NAME_RE.test((await deps.readText(`${dir}/name`)).trim())) {
					return dir;
				}
			} catch {
				// unreadable entry: try the next one
			}
		}
		return undefined;
	}

	return async function readInputVoltage(): Promise<number | null> {
		if (sense === undefined) {
			try {
				sense = inputProfileFor(await deps.readCompatible())?.sense ?? {
					kind: "none",
				};
			} catch {
				// Unknown board for now: no reading, and ask again next time
				// rather than deciding the board for the life of the process.
				return null;
			}
		}
		if (sense.kind !== "adc") return null;
		adcDir ??= await findAdc();
		if (adcDir === undefined) return null;
		try {
			const [raw, scale] = await Promise.all([
				deps.readText(`${adcDir}/in_voltage${sense.channel}_raw`),
				deps.readText(`${adcDir}/in_voltage_scale`),
			]);
			return inputVoltsFromAdc(raw, scale, sense.ratio);
		} catch {
			adcDir = undefined;
			return null;
		}
	};
}

/** Wire format of the sensor value: one decimal and a unit, e.g. "12.2 V". */
export function formatInputVoltage(volts: number): string {
	return `${volts.toFixed(1)} V`;
}

/**
 * Put one reading into the sensors record: the formatted value, or no key at
 * all when there is no reading, so an old number never stays on screen.
 */
export function applyInputVoltage(
	sensors: Record<string, string>,
	volts: number | null,
): void {
	if (volts === null) delete sensors[INPUT_VOLTAGE_SENSOR];
	else sensors[INPUT_VOLTAGE_SENSOR] = formatInputVoltage(volts);
}
