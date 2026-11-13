import { expect, test } from "bun:test";
import {
	ModemTemperatureReader,
	parseModemTemperature,
} from "../modules/modems/temperature";

test("QTEMP admits known sensors only and requires successful completion", () => {
	expect(
		parseModemTemperature(
			'+QTEMP: "cpuss-0-usr",70\r\n+QTEMP: "modem-ambient-usr",40\r\nOK',
		),
	).toBe(70);
	expect(parseModemTemperature('+QTEMP: "cpuss-0-usr","70"\nOK')).toBe(70);
	for (const raw of [
		"",
		"ERROR",
		'+QTEMP: "unknown",90\nOK',
		'+QTEMP: "cpuss-0-usr",garbage\nOK',
		'+QTEMP: "cpuss-0-usr",151\nOK',
		'+QTEMP: "cpuss-0-usr",90\nERROR',
		'+QTEMP: "cpuss-0-usr",90',
	])
		expect(parseModemTemperature(raw)).toBeNull();
});
test("temperature reads are slow, failure expires evidence, identity changes invalidate", async () => {
	let calls = 0;
	const reader = new ModemTemperatureReader(async () => {
		calls++;
		return '+QTEMP: "cpuss-0-usr",70\nOK';
	});
	expect(reader.sample([{ id: 1, identity: "a" }], 0)).toBeNull();
	await Promise.resolve();
	await Promise.resolve();
	expect(reader.sample([{ id: 1, identity: "a" }], 1000)).toBe(70);
	expect(calls).toBe(1);
	expect(reader.sample([], 2000)).toBeNull();
	expect(reader.sample([{ id: 1, identity: "b" }], 3000)).toBeNull();
});

test("a modem read that never answers blocks neither the sample nor adds a second read", () => {
	let calls = 0;
	const reader = new ModemTemperatureReader(() => {
		calls++;
		return new Promise<string>(() => {});
	});
	for (let t = 0; t <= 60000; t += 1000)
		expect(reader.sample([{ id: 1, identity: "a" }], t)).toBeNull();
	expect(calls).toBe(1);
});
