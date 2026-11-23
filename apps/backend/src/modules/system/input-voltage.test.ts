import { describe, expect, test } from "bun:test";
import {
	createInputVoltageReader,
	formatInputVoltage,
	type InputVoltageDeps,
	inputVoltsFromAdc,
	isRock5bPlus,
} from "./input-voltage.ts";

const ROCK_5B_PLUS = "radxa,rock-5b-plus\0rockchip,rk3588\0";
const ORANGE_PI_5_PLUS = "xunlong,orangepi-5-plus\0rockchip,rk3588\0";

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

describe("isRock5bPlus", () => {
	test("matches the exact compatible entry only", () => {
		expect(isRock5bPlus(ROCK_5B_PLUS)).toBe(true);
		expect(isRock5bPlus(ORANGE_PI_5_PLUS)).toBe(false);
		expect(isRock5bPlus("radxa,rock-5b\0rockchip,rk3588")).toBe(false);
		expect(isRock5bPlus("")).toBe(false);
	});
});

describe("inputVoltsFromAdc", () => {
	test("applies the 100k/8.2k divider", () => {
		// 2104 * 0.439453125 mV = 924.6 mV at the pin -> 12.2 V at DC-in
		const volts = inputVoltsFromAdc("2104\n", `${SCALE}\n`);
		expect(volts).not.toBeNull();
		expect(volts as number).toBeCloseTo(12.2, 1);
	});

	test("a 5 V input reads about 5 V", () => {
		expect(inputVoltsFromAdc("862", SCALE) as number).toBeCloseTo(5.0, 1);
	});

	test("an implausible or garbled read is no reading", () => {
		expect(inputVoltsFromAdc("0", SCALE)).toBeNull();
		expect(inputVoltsFromAdc("4095", "10")).toBeNull();
		expect(inputVoltsFromAdc("abc", SCALE)).toBeNull();
		expect(inputVoltsFromAdc("2104", "0")).toBeNull();
		expect(inputVoltsFromAdc("-5", SCALE)).toBeNull();
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

	test("another RK3588 board never touches the ADC", async () => {
		const deps = board(
			{
				[dev(0, "name")]: "fec10000.adc",
				[dev(0, "in_voltage6_raw")]: "2104",
				[dev(0, "in_voltage_scale")]: SCALE,
			},
			ORANGE_PI_5_PLUS,
		);
		const read = createInputVoltageReader(deps);
		expect(await read()).toBeNull();
		expect(await read()).toBeNull();
		expect(deps.reads).toEqual([]);
	});

	test("an unreadable device tree is not a ROCK 5B+", async () => {
		const deps = board({});
		deps.readCompatible = async () => {
			throw new Error("ENOENT");
		};
		expect(await createInputVoltageReader(deps)()).toBeNull();
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
});

test("formatInputVoltage keeps one decimal", () => {
	expect(formatInputVoltage(12.149)).toBe("12.1 V");
	expect(formatInputVoltage(4.87)).toBe("4.9 V");
});
