import { expect, test } from "bun:test";
import {
	advanceHeat,
	heatCeiling,
	initialHeat,
} from "../modules/streaming/heat-ladder";
import {
	parseSupervisor,
	supervisorCrc16,
} from "../modules/streaming/supervisor-status";

test("dwell, hysteresis, minimum hold, reverse undo and unknown freeze", () => {
	let s = initialHeat();
	let time = 0;
	const run = (duration: number, temperature: number | null) => {
		for (let end = time + duration; time <= end; time += 1000)
			s = advanceHeat(s, { soc: temperature }, time);
	};
	run(11000, 76);
	expect(s.stage).toBe(2);
	expect(heatCeiling(s, 6000)).toBe(4500);
	run(100000, 69);
	expect(s.stage).toBe(2);
	run(300000, null);
	expect(s.stage).toBe(2);
	run(65000, 69);
	expect(s.stage).toBe(1);
	run(370000, 60);
	expect(s.stage).toBe(0);
});
test("sawtooth does not enter; override and floor never raise own maximum", () => {
	let s = initialHeat();
	for (let t = 0; t < 120000; t += 1000)
		s = advanceHeat(s, { soc: t % 2000 ? 74 : 76 }, t);
	expect(s.stage).toBe(1);
	s = { ...s, stage: 3 };
	expect(heatCeiling(s, 1000)).toBe(1000);
	expect(heatCeiling({ ...s, keepQuality: true }, 6000)).toBe(6000);
});
test("status fixture preserves missing and uncalibrated temperatures, expires and rejects events", async () => {
	const line = await Bun.file(
		new URL("./fixtures/supervisor-status.txt", import.meta.url),
	).text();
	expect(parseSupervisor(line, 0, 0)?.temperatures).toEqual({
		pack: 30,
		bankA: null,
		bankB: 30,
	});
	expect(
		parseSupervisor(line.replace("pack=ready/30.0C", "pack=ready/uncal"), 0, 0)
			?.temperatures.pack,
	).toBeNull();
	expect(parseSupervisor(line, 0, 10000)).toBeNull();
	expect(parseSupervisor("OSB1 EVT thermal hot", 0, 0)).toBeNull();
});

test("flap stop latches steps until every input is normal", () => {
	let s = {
		...initialHeat(),
		stage: 1,
		enteredAt: -300000,
		entries: { 2: [0, 200000] },
	};
	for (let t = 400000; t <= 412000; t += 1000)
		s = advanceHeat(s, { soc: 76 }, t);
	expect(s.stage).toBe(2);
	expect(s.flap).toBe(true);
	for (let t = 413000; t <= 900000; t += 1000)
		s = advanceHeat(s, { soc: 69 }, t);
	expect(s.stage).toBe(2);
	expect(s.flap).toBe(true);
	for (let t = 901000; t <= 970000; t += 1000)
		s = advanceHeat(s, { soc: 60 }, t);
	expect(s.flap).toBe(false);
	expect(s.stage).toBe(1);
});
test("critical cap restores in one step after hot releases; undo is reverse and spaced", () => {
	let s = initialHeat();
	const tick = (a: number, b: number, temp: number) => {
		for (let t = a; t <= b; t += 1000) s = advanceHeat(s, { soc: temp }, t);
	};
	tick(0, 12000, 81);
	expect(s.stage).toBe(3);
	expect(heatCeiling(s, 8000)).toBe(4000);
	tick(13000, 320000, 69);
	expect(s.stage).toBe(2);
	expect(heatCeiling(s, 8000)).toBe(4000);
	tick(321000, 450000, 69);
	expect(s.stage).toBe(1);
	expect(heatCeiling(s, 8000)).toBe(8000);
});

test("stale sample gaps reset dwell and input unknown blocks recovery", () => {
	let s = advanceHeat(initialHeat(), { soc: 80 }, 0);
	s = advanceHeat(s, { soc: 80 }, 10000);
	expect(s.stage).toBe(0);
	s = { ...s, stage: 3, capStage: 3, enteredAt: 0 };
	for (let t = 11000; t < 400000; t += 1000)
		s = advanceHeat(s, { soc: 20, pack: null }, t);
	expect(s.stage).toBe(3);
	expect(s.unknown).toBe(true);
});

test("updated status fixture verifies CRC and parses appended fields", async () => {
	const line = await Bun.file(
		new URL("./fixtures/supervisor-status-crc.txt", import.meta.url),
	).text();
	const status = parseSupervisor(line, 0, 0);
	expect(status).not.toBeNull();
	expect(status?.seq).toBe(280);
	expect(status?.boot).toBe("7c1e04a2");
	expect(status?.rst).toBe("poweron");
	expect(status?.alive).toBe(true);
	expect(status?.hot).toEqual(["a"]);
	expect(status?.shutdowns).toBe(0);
	expect(status?.fw).toBe("field-cb4b75b2");
	expect(status?.crc).toBe("3B45");
	expect(parseSupervisor(line.replace("30.0C", "31.0C"), 0, 0)).toBeNull();
	expect(parseSupervisor(`${line.trim()} future=value`, 0, 0)).toBeNull();
});

test("CRC reference vector and checksum protection include unknown future fields", async () => {
	expect(supervisorCrc16("123456789")).toBe("29B1");
	const line = (
		await Bun.file(
			new URL("./fixtures/supervisor-status-crc.txt", import.meta.url),
		).text()
	).trim();
	const prefix = `${line.split(" crc=")[0]} future=extension`;
	const extended = `${prefix} crc=${supervisorCrc16(prefix)}`;
	expect(parseSupervisor(extended, 0, 0)?.seq).toBe(280);
	expect(
		parseSupervisor(extended.replace("extension", "changed"), 0, 0),
	).toBeNull();
	expect(parseSupervisor(line.replace("3B45", "XXXX"), 0, 0)).toBeNull();
	expect(parseSupervisor(line, 0, 6000)).toBeNull();
});
