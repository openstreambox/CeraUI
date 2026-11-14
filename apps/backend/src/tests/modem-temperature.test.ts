import { expect, test } from "bun:test";
import type { FreeAtResult } from "../modules/modems/free-at-port";
import {
	MODEM_PORT_RECHECK_MS,
	ModemTemperatureReader,
	parseModemTemperature,
} from "../modules/modems/temperature";
import { QTEMP_REPLY } from "./helpers/fake-at-modem";

const ok = (raw: string): FreeAtResult => ({ ok: true, raw });
const refused: FreeAtResult = {
	ok: false,
	unavailable: true,
	reason: "not-released",
};
const timedOut: FreeAtResult = {
	ok: false,
	unavailable: false,
	reason: "timeout",
};

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

test("the serial reply from the released port, echo and final OK included, is read", () => {
	expect(
		parseModemTemperature(`AT+QTEMP\r${QTEMP_REPLY}`.replace(/\r\n?/g, "\n")),
	).toBe(41);
	expect(parseModemTemperature(QTEMP_REPLY)).toBe(41);
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
		return ok('+QTEMP: "cpuss-0-usr",70\nOK');
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
		return new Promise<FreeAtResult>(() => {});
	});
	for (let t = 0; t <= 60000; t += 1000)
		expect(reader.sample([{ id: 1, identity: "a" }], t).value).toBeNull();
	expect(calls).toBe(1);
});

test("expectation is per modem: a seen modem that goes quiet is missing, an unplugged one is not", async () => {
	let fail = false;
	const reader = new ModemTemperatureReader(async () =>
		fail ? timedOut : ok('+QTEMP: "cpuss-0-usr","50"\nOK'),
	);
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
	const fresh = new ModemTemperatureReader(async () => timedOut);
	fresh.sample([a], 0);
	await settle();
	expect(fresh.sample([a], 1000).missing).toBe(false);
});

test("a refused port is logged once with its reason and not looked at again for ten minutes", async () => {
	let calls = 0;
	const logs: { message: string; meta?: Record<string, unknown> }[] = [];
	const reader = new ModemTemperatureReader(
		async () => {
			calls++;
			return refused;
		},
		{ warn: (message, meta) => logs.push({ message, meta }) },
	);
	const targets = [
		{ id: 1, identity: "a" },
		{ id: 2, identity: "b" },
	];
	reader.sample(targets, 0);
	await settle();
	for (let t = 1000; t < MODEM_PORT_RECHECK_MS; t += 1000) {
		const sample = reader.sample(targets, t);
		expect(sample).toEqual({
			value: null,
			missing: false,
			unavailable: true,
			reason: "not-released",
		});
		await settle();
	}
	expect(calls).toBe(2);
	expect(logs).toHaveLength(2); // once per modem, not per poll
	expect(logs[0]?.meta).toEqual({ modem: 1, reason: "not-released" });
	reader.sample(targets, MODEM_PORT_RECHECK_MS);
	expect(calls).toBe(4);
	// No modem, no claim either way.
	expect(reader.sample([], MODEM_PORT_RECHECK_MS + 1).unavailable).toBe(false);
});

test("one refused port does not hide another modem's reading", async () => {
	const reader = new ModemTemperatureReader(async (id) =>
		id === 1 ? refused : ok('+QTEMP: "cpuss-0-usr","55"\nOK'),
	);
	const targets = [
		{ id: 1, identity: "a" },
		{ id: 2, identity: "b" },
	];
	reader.sample(targets, 0);
	await settle();
	expect(reader.sample(targets, 1000)).toEqual({
		value: 55,
		missing: false,
		unavailable: false,
	});
});

test("a modem that has given readings and then loses its port blocks cooling", async () => {
	let result = ok('+QTEMP: "cpuss-0-usr","60"\nOK');
	const reader = new ModemTemperatureReader(async () => result);
	const a = { id: 1, identity: "a" };
	reader.sample([a], 0);
	await settle();
	expect(reader.sample([a], 1000).value).toBe(60);
	result = refused;
	reader.sample([a], 10000);
	await settle();
	expect(reader.sample([a], 11000)).toEqual({
		value: null,
		missing: true,
		unavailable: false,
	});
});

test("availability comes back after the recheck and is logged once", async () => {
	let result: FreeAtResult = refused;
	const info: string[] = [];
	const reader = new ModemTemperatureReader(async () => result, {
		warn: () => {},
		info: (message) => info.push(message),
	});
	const a = { id: 1, identity: "a" };
	reader.sample([a], 0);
	await settle();
	expect(reader.sample([a], 1000).unavailable).toBe(true);
	result = ok('+QTEMP: "cpuss-0-usr","45"\nOK');
	reader.sample([a], MODEM_PORT_RECHECK_MS);
	await settle();
	expect(reader.sample([a], MODEM_PORT_RECHECK_MS + 1000)).toEqual({
		value: 45,
		missing: false,
		unavailable: false,
	});
	expect(info).toHaveLength(1);
});
