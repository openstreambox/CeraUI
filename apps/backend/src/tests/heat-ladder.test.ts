import { expect, test } from "bun:test";
import {
	advanceHeat,
	type HeatState,
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
	expect(heatCeiling({ ...s, keepQuality: true }, 6000)).toBe(3000);
	expect(heatCeiling({ ...s, keepQuality: true, unknown: true }, 6000)).toBe(
		6000,
	);
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
	expect(status?.fw).toBe("field-5367fef5");
	expect(status?.crc).toBe("F362");
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
	expect(parseSupervisor(line.replace("F362", "XXXX"), 0, 0)).toBeNull();
	expect(parseSupervisor(line, 0, 6000)).toBeNull();
});

test("C5: implausible SoC readings are unknown, never a step or an undo", async () => {
	const { parseThermalZone } = await import("../modules/streaming/heat-ladder");
	expect(parseThermalZone("45000\n")).toBe(45);
	expect(parseThermalZone("45000abc")).toBeNull();
	expect(parseThermalZone("")).toBeNull();
	expect(parseThermalZone("1000000000")).toBeNull();
	expect(parseThermalZone("-40000")).toBeNull();
	let s = { ...initialHeat(), stage: 3, capStage: 3, enteredAt: -400000 };
	expect(parseThermalZone("0")).toBeNull();
	for (let t = 0; t <= 700000; t += 1000)
		s = advanceHeat(s, { soc: parseThermalZone("0") }, t);
	expect(s.stage).toBe(3);
	expect(s.unknown).toBe(true);
	let fresh = initialHeat();
	for (let t = 0; t <= 20000; t += 1000)
		fresh = advanceHeat(fresh, { soc: 1e6 }, t);
	expect(advanceHeat(initialHeat(), { soc: -40 }, 0).unknown).toBe(true);
	expect(fresh.stage).toBe(0);
	expect(fresh.unknown).toBe(true);
});

test("a single unknown sample pauses but does not restart the cool-down; a long gap does", () => {
	const hot = {
		...initialHeat(),
		stage: 2,
		capStage: 2,
		enteredAt: -600000,
	};
	const cool = (from: HeatState, start: number, glitchEvery: number) => {
		let s = from;
		for (let t = start; t <= start + 70000; t += 1000)
			s = advanceHeat(
				s,
				{ soc: glitchEvery && t % glitchEvery === 0 ? null : 60 },
				t,
			);
		return s;
	};
	// One unreadable sample every 30 s: the cool-down still completes.
	expect(cool(hot, 1000, 30000).stage).toBe(1);
	// Ten unknown seconds are missing evidence: the cool-down starts over.
	let s: HeatState = hot;
	for (let t = 1000; t <= 50000; t += 1000) s = advanceHeat(s, { soc: 60 }, t);
	for (let t = 51000; t <= 60000; t += 1000)
		s = advanceHeat(s, { soc: null }, t);
	expect(s.unknown).toBe(true);
	for (let t = 61000; t <= 80000; t += 1000) s = advanceHeat(s, { soc: 60 }, t);
	expect(s.stage).toBe(2);
	for (let t = 81000; t <= 125000; t += 1000)
		s = advanceHeat(s, { soc: 60 }, t);
	expect(s.stage).toBe(1);
	// An unknown sample never takes or undoes a step by itself.
	const frozen = advanceHeat(
		{ ...hot, coolAt: -100000, lastAt: 0 },
		{ soc: null },
		1000,
	);
	expect(frozen.stage).toBe(2);
});

test("the supervisor parser and the ladder share one plausible range", () => {
	const line =
		"OSB1 up=1 a=healthy/0/0/30.0C b=healthy/0/0/30.0C pack=ready/115.0C thermal=ok";
	expect(parseSupervisor(line, 0, 0)?.temperatures.pack).toBe(115);
	expect(
		parseSupervisor(line.replace("115.0C", "126.0C"), 0, 0)?.temperatures.pack,
	).toBeNull();
	expect(
		parseSupervisor(line.replace("115.0C", "-21.0C"), 0, 0)?.temperatures.pack,
	).toBeNull();
});

test("protection gaps and calibration remain explicit including unknown bits", async () => {
	const line = (
		await Bun.file(
			new URL("./fixtures/supervisor-status-crc.txt", import.meta.url),
		).text()
	).trim();
	const status = parseSupervisor(line, 0, 0);
	expect(status?.packCalibration).toBe("datasheet");
	expect(status?.start).toBe("on");
	expect(status?.gaps).toBe(4);
	expect(status?.protectionReduced).toBe(true);
	expect(status?.packDatasheet).toBe(true);
	const prefix = (line.split(" crc=")[0] ?? "").replace(
		"gaps=0004",
		"gaps=8000",
	);
	expect(
		parseSupervisor(`${prefix} crc=${supervisorCrc16(prefix)}`, 0, 0)
			?.protectionReduced,
	).toBe(true);
});

test("missing optional modem evidence allows SoC escalation and blocks cooling", () => {
	let s = initialHeat();
	for (let t = 0; t <= 12000; t += 1000)
		s = advanceHeat(s, { soc: 76 }, t, false);
	expect(s.stage).toBe(2);
	for (let t = 13000; t <= 500000; t += 1000)
		s = advanceHeat(s, { soc: 30 }, t, false);
	expect(s.stage).toBe(2);
});

test("calibration, start reasons, all gaps and pack flag survive projection", async () => {
	const line =
		(
			await Bun.file(
				new URL("./fixtures/supervisor-status-crc.txt", import.meta.url),
			).text()
		)
			.trim()
			.split(" crc=")[0] ?? "";
	const parse = (payload: string) =>
		parseSupervisor(`${payload} crc=${supervisorCrc16(payload)}`, 0, 0);
	for (const calibration of ["datasheet", "bench", "none"])
		expect(
			parse(line.replace("pack_cal=datasheet", `pack_cal=${calibration}`))
				?.packCalibration,
		).toBe(calibration);
	for (const start of [
		"on",
		"off",
		"settling",
		"no_bank",
		"too_hot",
		"temp_unknown",
		"latched",
		"unarmed",
	])
		expect(parse(line.replace("start=on", `start=${start}`))?.start).toBe(
			start,
		);
	for (let bit = 0; bit < 16; bit++)
		expect(
			parse(
				line.replace(
					"gaps=0004",
					`gaps=${(1 << bit).toString(16).padStart(4, "0")}`,
				),
			)?.protectionReduced,
		).toBe(true);
	expect(parse(line.replace("gaps=0004", "gaps=0000"))?.protectionReduced).toBe(
		false,
	);
	// Present but malformed reads as reduced, never like 0000.
	for (const bad of ["wrong", "004", "0x04", "00040", ""])
		expect(
			parse(line.replace("gaps=0004", `gaps=${bad}`))?.protectionReduced,
		).toBe(true);
	expect(parse(line.replace(" gaps=0004", ""))?.protectionReduced).toBeNull();
	expect(parse(line.replace("pack_cal=datasheet ", ""))?.packDatasheet).toBe(
		true,
	);
});

test("extended protection masks and pack jump flags preserve their reasons", async () => {
	const line = (
		await Bun.file(
			new URL("./fixtures/supervisor-status-gaps2-crc.txt", import.meta.url),
		).text()
	).trim();
	const payload = line.split(" crc=")[0] ?? "";
	expect(supervisorCrc16(payload)).toBe("296D");
	expect(parseSupervisor(line, 0, 0)?.gaps2).toBe(0);
	expect(
		parseSupervisor(line.replace("gaps2=0000", "gaps2=0001"), 0, 0),
	).toBeNull();
	const parse = (value: string, flags = "10") => {
		const body = payload
			.replace("gaps=0004", "gaps=0000")
			.replace("gaps2=0000", `gaps2=${value}`)
			.replace("pack=ready/30.0C/10", `pack=ready/30.0C/${flags}`);
		return parseSupervisor(`${body} crc=${supervisorCrc16(body)}`, 0, 0);
	};
	expect(parse("0000")?.protectionReduced).toBe(false);
	expect(parse("0001")?.supplyUnproven).toBe(true);
	expect(parse("0001")?.packJump).toBe(false);
	expect(parse("0002")?.packJump).toBe(true);
	expect(parse("0002")?.supplyUnproven).toBe(false);
	expect(parse("0003")?.supplyUnproven).toBe(true);
	expect(parse("0003")?.packJump).toBe(true);
	for (let bit = 0; bit < 16; bit++) {
		const status = parse((1 << bit).toString(16).padStart(4, "0"));
		expect(status?.gaps2).toBe(1 << bit);
		expect(status?.protectionReduced).toBe(true);
	}
	for (const bad of ["wrong", "001", "0x01", "00001", "", "-001"])
		expect(parse(bad)?.protectionReduced).toBe(true);
	expect(parse("a000")?.protectionReduced).toBe(true);
	for (const flags of ["40", "50", "48", "7f"]) {
		expect(parse("0000", flags)?.packJump).toBe(true);
		expect(parse("0000", flags)?.protectionReduced).toBe(true);
	}
	const legacy = payload.replace(" gaps2=0000", "");
	expect(
		parseSupervisor(`${legacy} crc=${supervisorCrc16(legacy)}`, 0, 0)?.gaps2,
	).toBeNull();
});
