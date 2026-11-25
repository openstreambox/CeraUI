import { describe, expect, test } from "bun:test";
import {
	ADC_FULL_SCALE_RAW,
	applyInputVoltage,
	BOARD_INPUT_PROFILES,
	createInputVoltageReader,
	formatInputVoltage,
	INPUT_VOLTAGE_SENSOR,
	type InputVoltageDeps,
	inputProfileFor,
	inputVoltsFromAdc,
	ROCK_5B_PLUS_DIVIDER,
} from "./input-voltage.ts";

const ROCK_5B_PLUS = "radxa,rock-5b-plus\0rockchip,rk3588\0";
const ORANGE_PI_5_PLUS = "xunlong,orangepi-5-plus\0rockchip,rk3588\0";
// The vendor 5.10 kernel's name for the same board (read on a board).
const ORANGE_PI_5_PLUS_VENDOR =
	"rockchip,rk3588-orangepi-5-plus\0rockchip,rk3588\0";
const UNKNOWN_RK3588 = "vendor,some-rk3588-board\0rockchip,rk3588\0";

// in_voltage_scale on the board's 1.8 V / 12-bit SARADC.
const SCALE = "0.439453125";

function board(
	files: Record<string, string>,
	compatible = ROCK_5B_PLUS,
): InputVoltageDeps & { reads: string[] } {
	const reads: string[] = [];
	return {
		reads,
		readCompatible: async () => compatible,
		listIioDevices: async () =>
			Object.keys(files)
				.map((path) => path.split("/")[5])
				.filter((entry): entry is string => entry !== undefined)
				.filter((entry, i, all) => all.indexOf(entry) === i),
		readText: async (path) => {
			reads.push(path);
			const value = files[path];
			if (value === undefined) throw new Error(`ENOENT ${path}`);
			return value;
		},
	};
}

const dev = (n: number, file: string) =>
	`/sys/bus/iio/devices/iio:device${n}/${file}`;

describe("inputProfileFor", () => {
	test("the ROCK 5B+ reads ADC channel 6 through its 100k/8.2k divider", () => {
		expect(inputProfileFor(ROCK_5B_PLUS)?.sense).toEqual({
			kind: "adc",
			channel: 6,
			ratio: ROCK_5B_PLUS_DIVIDER,
		});
	});

	test("the Orange Pi 5 Plus is known and has no input sense, on either kernel", () => {
		for (const compatible of [ORANGE_PI_5_PLUS, ORANGE_PI_5_PLUS_VENDOR]) {
			const profile = inputProfileFor(compatible);
			expect(profile?.board).toBe("orangepi-5-plus");
			expect(profile?.sense).toEqual({ kind: "none" });
		}
	});

	test("matches exact entries only; an unknown board has no profile", () => {
		expect(inputProfileFor("radxa,rock-5b\0rockchip,rk3588")).toBeUndefined();
		expect(inputProfileFor(UNKNOWN_RK3588)).toBeUndefined();
		expect(inputProfileFor("rockchip,rk3588")).toBeUndefined();
		expect(inputProfileFor("")).toBeUndefined();
	});

	test("no two profiles claim the same compatible", () => {
		const all = BOARD_INPUT_PROFILES.flatMap((p) => p.compatibles);
		expect(new Set(all).size).toBe(all.length);
	});
});

describe("inputVoltsFromAdc", () => {
	test("applies the 100k/8.2k divider", () => {
		// 2104 * 0.439453125 mV = 924.6 mV at the pin -> 12.2 V at DC-in
		const volts = inputVoltsFromAdc(
			"2104\n",
			`${SCALE}\n`,
			ROCK_5B_PLUS_DIVIDER,
		);
		expect(volts).not.toBeNull();
		expect(volts as number).toBeCloseTo(12.2, 1);
	});

	test("a 5 V input reads about 5 V", () => {
		expect(
			inputVoltsFromAdc("862", SCALE, ROCK_5B_PLUS_DIVIDER) as number,
		).toBeCloseTo(5.0, 1);
	});

	test("a saturated 12-bit read is no reading, one count below is a reading", () => {
		expect(
			inputVoltsFromAdc(
				String(ADC_FULL_SCALE_RAW),
				SCALE,
				ROCK_5B_PLUS_DIVIDER,
			),
		).toBeNull();
		expect(inputVoltsFromAdc("5000", SCALE, ROCK_5B_PLUS_DIVIDER)).toBeNull();
		const top = inputVoltsFromAdc(
			String(ADC_FULL_SCALE_RAW - 1),
			SCALE,
			ROCK_5B_PLUS_DIVIDER,
		);
		expect(top).not.toBeNull();
		expect(top as number).toBeCloseTo(23.7, 1);
	});

	test("the 0.5 V floor: just below is no reading, just above is", () => {
		// 86 counts = 0.4987 V at the input, 87 counts = 0.5045 V.
		expect(inputVoltsFromAdc("86", SCALE, ROCK_5B_PLUS_DIVIDER)).toBeNull();
		expect(inputVoltsFromAdc("87", SCALE, ROCK_5B_PLUS_DIVIDER)).not.toBeNull();
	});

	test("an implausible or garbled read is no reading", () => {
		expect(inputVoltsFromAdc("0", SCALE, ROCK_5B_PLUS_DIVIDER)).toBeNull();
		expect(inputVoltsFromAdc("4095", "10", ROCK_5B_PLUS_DIVIDER)).toBeNull();
		expect(inputVoltsFromAdc("abc", SCALE, ROCK_5B_PLUS_DIVIDER)).toBeNull();
		expect(inputVoltsFromAdc("2104", "0", ROCK_5B_PLUS_DIVIDER)).toBeNull();
		expect(inputVoltsFromAdc("-5", SCALE, ROCK_5B_PLUS_DIVIDER)).toBeNull();
	});
});

describe("createInputVoltageReader", () => {
	test("reads channel 6 of the fec10000 ADC on a ROCK 5B+", async () => {
		const deps = board({
			[dev(0, "name")]: "rockchip-thermal\n",
			[dev(1, "name")]: "fec10000.adc\n",
			[dev(1, "in_voltage6_raw")]: "2104\n",
			[dev(1, "in_voltage_scale")]: `${SCALE}\n`,
		});
		const read = createInputVoltageReader(deps);
		expect((await read()) as number).toBeCloseTo(12.2, 1);
	});

	test("accepts the older vendor kernel's saradc name", async () => {
		const deps = board({
			[dev(0, "name")]: "fec10000.saradc",
			[dev(0, "in_voltage6_raw")]: "2104",
			[dev(0, "in_voltage_scale")]: SCALE,
		});
		expect((await createInputVoltageReader(deps)()) as number).toBeCloseTo(
			12.2,
			1,
		);
	});

	test.each([
		["Orange Pi 5 Plus (mainline)", ORANGE_PI_5_PLUS],
		["Orange Pi 5 Plus (vendor kernel)", ORANGE_PI_5_PLUS_VENDOR],
		["an unknown RK3588 board", UNKNOWN_RK3588],
	])(
		"%s never touches the ADC, even with a plausible channel 6",
		async (_name, compatible) => {
			const deps = board(
				{
					[dev(0, "name")]: "fec10000.saradc",
					[dev(0, "in_voltage6_raw")]: "2104",
					[dev(0, "in_voltage_scale")]: SCALE,
				},
				compatible,
			);
			const read = createInputVoltageReader(deps);
			expect(await read()).toBeNull();
			expect(await read()).toBeNull();
			expect(deps.reads).toEqual([]);
		},
	);

	test("an unreadable device tree is no reading and never touches the ADC; the next read asks again", async () => {
		const deps = board({
			[dev(0, "name")]: "fec10000.adc",
			[dev(0, "in_voltage6_raw")]: "2104",
			[dev(0, "in_voltage_scale")]: SCALE,
		});
		let fail = true;
		deps.readCompatible = async () => {
			if (fail) throw new Error("ENOENT");
			return ROCK_5B_PLUS;
		};
		const read = createInputVoltageReader(deps);
		expect(await read()).toBeNull();
		expect(deps.reads).toEqual([]);
		fail = false;
		expect((await read()) as number).toBeCloseTo(12.2, 1);
	});

	test("no matching ADC is no reading, and the lookup retries", async () => {
		const files: Record<string, string> = {
			[dev(0, "name")]: "rockchip-thermal",
		};
		const deps = board(files);
		const read = createInputVoltageReader(deps);
		expect(await read()).toBeNull();
		files[dev(1, "name")] = "fec10000.adc";
		files[dev(1, "in_voltage6_raw")] = "862";
		files[dev(1, "in_voltage_scale")] = SCALE;
		expect((await read()) as number).toBeCloseTo(5.0, 1);
	});

	test("a failed channel read is no reading, never the previous value", async () => {
		const files: Record<string, string> = {
			[dev(0, "name")]: "fec10000.adc",
			[dev(0, "in_voltage6_raw")]: "2104",
			[dev(0, "in_voltage_scale")]: SCALE,
		};
		const read = createInputVoltageReader(board(files));
		expect(await read()).not.toBeNull();
		delete files[dev(0, "in_voltage6_raw")];
		expect(await read()).toBeNull();
	});

	test("after a failed channel read the ADC is looked up again, at its new place", async () => {
		const files: Record<string, string> = {
			[dev(0, "name")]: "fec10000.adc",
			[dev(0, "in_voltage6_raw")]: "2104",
			[dev(0, "in_voltage_scale")]: SCALE,
		};
		const read = createInputVoltageReader(board(files));
		expect(await read()).not.toBeNull();
		// The driver rebinds as another IIO device.
		delete files[dev(0, "name")];
		delete files[dev(0, "in_voltage6_raw")];
		delete files[dev(0, "in_voltage_scale")];
		files[dev(1, "name")] = "fec10000.adc";
		files[dev(1, "in_voltage6_raw")] = "862";
		files[dev(1, "in_voltage_scale")] = SCALE;
		expect(await read()).toBeNull();
		expect((await read()) as number).toBeCloseTo(5.0, 1);
	});
});

describe("applyInputVoltage", () => {
	test("sets the formatted reading, and deletes the key when there is none", () => {
		const sensors: Record<string, string> = { "SoC temperature": "50.0 °C" };
		applyInputVoltage(sensors, 12.18);
		expect(sensors[INPUT_VOLTAGE_SENSOR]).toBe("12.2 V");
		applyInputVoltage(sensors, null);
		expect(Object.hasOwn(sensors, INPUT_VOLTAGE_SENSOR)).toBe(false);
		expect(sensors["SoC temperature"]).toBe("50.0 °C");
	});
});

test("formatInputVoltage keeps one decimal", () => {
	expect(formatInputVoltage(12.149)).toBe("12.1 V");
	expect(formatInputVoltage(4.87)).toBe("4.9 V");
});
