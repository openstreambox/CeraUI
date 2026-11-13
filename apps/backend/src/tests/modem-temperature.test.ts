import { expect, test } from "bun:test";
import {
	isAtCommandRefusal,
	ModemCommandUnavailableError,
	ModemTemperatureReader,
	parseModemTemperature,
	qtempResponseFromMmcli,
} from "../modules/modems/temperature";

const settle = async () => {
	for (let i = 0; i < 4; i++) await Promise.resolve();
};

test("QTEMP admits known sensors only and rejects error replies", () => {
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
		'+QTEMP: "cpuss-0-usr",90\n+CME ERROR: 100',
	])
		expect(parseModemTemperature(raw)).toBeNull();
});

test("the reply as ModemManager returns it (final OK stripped) is read", async () => {
	const json = await Bun.file(
		new URL("./fixtures/modem-qtemp-mmcli.json", import.meta.url),
	).text();
	const response = qtempResponseFromMmcli(json);
	expect(response).not.toContain("OK");
	expect(parseModemTemperature(response)).toBe(30);
	expect(parseModemTemperature('+QTEMP: "cpuss-0-usr","70"')).toBe(70);
	expect(qtempResponseFromMmcli("{}")).toBe("");
	expect(qtempResponseFromMmcli("not json")).toBe("");
});

test("a value outside the ladder's plausible range is dropped, not passed on", () => {
	expect(parseModemTemperature('+QTEMP: "cpuss-0-usr","130"')).toBeNull();
	expect(
		parseModemTemperature(
			'+QTEMP: "cpuss-0-usr","130"\r\n+QTEMP: "modem-ambient-usr","60"',
		),
	).toBe(60);
	expect(parseModemTemperature('+QTEMP: "cpuss-0-usr","-30"')).toBeNull();
});

test("temperature reads are slow, failure expires evidence, identity changes invalidate", async () => {
	let calls = 0;
	const reader = new ModemTemperatureReader(async () => {
		calls++;
		return '+QTEMP: "cpuss-0-usr",70\nOK';
	});
	expect(reader.sample([{ id: 1, identity: "a" }], 0).value).toBeNull();
	await settle();
	expect(reader.sample([{ id: 1, identity: "a" }], 1000).value).toBe(70);
	expect(calls).toBe(1);
	expect(reader.sample([], 2000).value).toBeNull();
	expect(reader.sample([{ id: 1, identity: "b" }], 3000).value).toBeNull();
});

test("a modem read that never answers blocks neither the sample nor adds a second read", () => {
	let calls = 0;
	const reader = new ModemTemperatureReader(() => {
		calls++;
		return new Promise<string>(() => {});
	});
	for (let t = 0; t <= 60000; t += 1000)
		expect(reader.sample([{ id: 1, identity: "a" }], t).value).toBeNull();
	expect(calls).toBe(1);
});

test("expectation is per modem: a seen modem that goes quiet is missing, an unplugged one is not", async () => {
	let fail = false;
	const reader = new ModemTemperatureReader(async () => {
		if (fail) throw new Error("timeout");
		return '+QTEMP: "cpuss-0-usr","50"';
	});
	const a = { id: 1, identity: "a" };
	const b = { id: 2, identity: "b" };
	reader.sample([a, b], 0);
	await settle();
	expect(reader.sample([a, b], 1000)).toEqual({
		value: 50,
		missing: false,
		unavailable: false,
	});
	fail = true;
	reader.sample([a, b], 10000);
	await settle();
	expect(reader.sample([a, b], 13000).missing).toBe(true);
	// Unplugged: no expectation is left behind.
	expect(reader.sample([], 14000)).toEqual({
		value: null,
		missing: false,
		unavailable: false,
	});
	// A modem that never answered is not "missing".
	const fresh = new ModemTemperatureReader(async () => {
		throw new Error("timeout");
	});
	fresh.sample([a], 0);
	await settle();
	expect(fresh.sample([a], 1000).missing).toBe(false);
});

test("a ModemManager that refuses AT commands is detected once, logged once and not polled", async () => {
	let calls = 0;
	const logs: string[] = [];
	const reader = new ModemTemperatureReader(
		async () => {
			calls++;
			throw new ModemCommandUnavailableError();
		},
		{ warn: (message) => logs.push(message) },
	);
	const targets = [
		{ id: 1, identity: "a" },
		{ id: 2, identity: "b" },
	];
	reader.sample(targets, 0);
	await settle();
	for (let t = 1000; t <= 300000; t += 1000) {
		const sample = reader.sample(targets, t);
		expect(sample.unavailable).toBe(true);
		expect(sample.missing).toBe(false);
		await settle();
	}
	expect(calls).toBe(2);
	expect(logs.length).toBe(1);
	// Checked again rarely, in case ModemManager was restarted with --debug.
	reader.sample(targets, 600001);
	expect(calls).toBe(4);
	// No modem, no claim either way.
	expect(reader.sample([], 600002).unavailable).toBe(false);
});

test("the debug-mode refusal is recognised from ModemManager's error text", () => {
	expect(
		isAtCommandRefusal(
			"error: couldn't send command: 'GDBus.Error:org.freedesktop.ModemManager1.Error.Core.Unsupported: Cannot send AT command to modem: operation only allowed in debug mode'",
		),
	).toBe(true);
	expect(isAtCommandRefusal("Operation only allowed in debug mode")).toBe(true);
	expect(isAtCommandRefusal("error: couldn't find modem")).toBe(false);
	expect(isAtCommandRefusal("")).toBe(false);
});
