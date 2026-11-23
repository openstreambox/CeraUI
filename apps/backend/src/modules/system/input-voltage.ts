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

  The Radxa ROCK 5B+ routes its USB-C power input through a 100k / 8.2k
  divider into SARADC channel 6 (Radxa schematic). The reading is therefore
  `in_voltage6_raw * in_voltage_scale` (mV at the pin) times
  (100 + 8.2) / 8.2 = 13.195..., which gives the input in volts after /1000.

  It is the voltage only. The PD contract and the current are not measurable
  from the board, so nothing here claims either.

  Board gate: only a device tree that names `radxa,rock-5b-plus` is read. Other
  RK3588 boards expose the same ADC, but channel 6 is wired to something else
  (or nothing) on them, so a number from it would be fabricated. The ADC is
  found by its platform name: `fec10000.adc` on the current kernel,
  `fec10000.saradc` on the older vendor kernel.
*/

import { readdir } from "node:fs/promises";

export const INPUT_VOLTAGE_SENSOR = "Input voltage";

/** (100k + 8.2k) / 8.2k, the board's divider ratio. */
export const ROCK_5B_PLUS_DIVIDER = (100 + 8.2) / 8.2;

const ROCK_5B_PLUS_COMPATIBLE = "radxa,rock-5b-plus";
const IIO_ROOT = "/sys/bus/iio/devices";
const ADC_NAME_RE = /^fec10000\.(?:sar)?adc$/;
const CHANNEL = 6;

/** Plausible DC-in range; anything outside is a bad read, not a reading. */
const MIN_VOLTS = 0.5;
const MAX_VOLTS = 30;

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

/** True when the device tree names the ROCK 5B+ (NUL-separated list). */
export function isRock5bPlus(compatible: string): boolean {
	return compatible
		.split("\0")
		.some((entry) => entry.trim() === ROCK_5B_PLUS_COMPATIBLE);
}

/**
 * Convert one ADC read to volts at the board input, or null when the read is
 * not a plausible DC-in voltage.
 */
export function inputVoltsFromAdc(raw: string, scale: string): number | null {
	const r = Number.parseInt(raw.trim(), 10);
	const s = Number.parseFloat(scale.trim());
	if (!Number.isFinite(r) || !Number.isFinite(s) || r < 0 || s <= 0) {
		return null;
	}
	const volts = (r * s * ROCK_5B_PLUS_DIVIDER) / 1000;
	return volts >= MIN_VOLTS && volts <= MAX_VOLTS ? volts : null;
}

/**
 * Reader with the board check and the ADC lookup resolved once. A board that
 * is not a ROCK 5B+ stays off for the life of the process; a missing ADC is
 * looked up again on the next read (the driver can bind late).
 */
export function createInputVoltageReader(
	deps: InputVoltageDeps = defaultInputVoltageDeps,
) {
	let supported: boolean | undefined;
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
		if (supported === undefined) {
			try {
				supported = isRock5bPlus(await deps.readCompatible());
			} catch {
				supported = false;
			}
		}
		if (!supported) return null;
		adcDir ??= await findAdc();
		if (adcDir === undefined) return null;
		try {
			const [raw, scale] = await Promise.all([
				deps.readText(`${adcDir}/in_voltage${CHANNEL}_raw`),
				deps.readText(`${adcDir}/in_voltage_scale`),
			]);
			return inputVoltsFromAdc(raw, scale);
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
