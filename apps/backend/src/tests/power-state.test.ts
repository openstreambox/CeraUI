import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as clock from "../helpers/monotonic-clock.ts";
import {
	createPowerReconciler,
	readPowerState,
} from "../modules/system/power-state.ts";

const fixture = (name: string) =>
	new URL(
		`./fixtures/power/${name}.${name === "corrupt" ? "txt" : "json"}`,
		import.meta.url,
	).pathname;
const read = (name: string, now = 10000) => readPowerState(fixture(name), now);
describe("read-only power state", () => {
	test("fresh monotonic sample", async () => {
		const state = await read("fresh");
		expect(state.available).toBe(true);
		expect(state.notices).toEqual([]);
	});
	for (const name of ["stale", "absent", "corrupt", "missing", "reboot"]) {
		test(`${name} quietly becomes unavailable`, async () => {
			const state = await read(name);
			expect(state.available).toBe(false);
			expect(state.summary).toBe(
				name === "missing" ? "" : "Power data not available",
			);
			expect(state.notices).toEqual([]);
			expect(state.sensors).toEqual({});
		});
	}
	test("strict five second boundary, no wall clock", async () => {
		expect(
			(await changed({ published_mono_ms: 14999 }, {}, 14999)).available,
		).toBe(true);
		expect((await read("fresh", 15000)).available).toBe(false);
	});
	for (const level of ["warm", "hot", "critical", "shutdown"]) {
		test(`${level} has a calm notice`, async () => {
			const state = await read(level);
			expect(state.notices.some((n) => n.id === "heat")).toBe(true);
			expect(state.summary).not.toMatch(/not live|offline|stream stopped/i);
		});
	}
	test("reconcile only changes, escalation, recovery and stale clearing", async () => {
		const raised: string[] = [],
			removed: string[] = [];
		const reconcile = createPowerReconciler(
			(n) => raised.push(n.message),
			(id) => removed.push(id),
		);
		reconcile(await read("warm"));
		reconcile(await read("warm"));
		expect(raised).toHaveLength(1);
		reconcile(await read("critical"));
		expect(raised).toHaveLength(2);
		reconcile(await read("stale"));
		expect(removed).toEqual(["heat"]);
		reconcile(await read("fresh"));
		expect(raised).toHaveLength(2);
	});
});

test("authenticated remote moderator receives the same power status as the phone", async () => {
	const { deliverPowerSensors } = await import(
		"../modules/system/power-delivery.ts"
	);
	const { StatusSchema } = await import(
		"../modules/remote-control/protocol.ts"
	);
	const local = await read("critical");
	const sensors = {
		"SoC temperature": "45.0 °C",
		"SRT ingest": "receiving",
		"RTMP ingest - synthetic-secret": "receiving",
		"Power sample": "123",
		published_mono_ms: "10000",
		rx_mono_ms: "10000",
		open_error: "13",
		persist_error: "true",
		rejected: "1",
		boot: "synthetic",
		Power: local.summary,
		...local.sensors,
	};
	const legacy: string[] = [],
		control: unknown[] = [];
	deliverPowerSensors(sensors, {
		legacy: () => ({
			authenticated: true,
			send: (text) => {
				legacy.push(text);
			},
		}),
		controlConnected: () => true,
		sendControl: (frame) => {
			control.push(frame);
		},
	});
	expect(JSON.parse(legacy[0] ?? "{}").sensors).toEqual({
		Power: local.summary,
		...local.sensors,
	});
	expect(StatusSchema.parse(control[0]).payload).toEqual({
		Power: local.summary,
		...local.sensors,
	});
	const blockedLegacy: string[] = [],
		blockedControl: unknown[] = [];
	deliverPowerSensors(sensors, {
		legacy: () => ({
			authenticated: false,
			send: (text) => {
				blockedLegacy.push(text);
			},
		}),
		controlConnected: () => false,
		sendControl: (frame) => {
			blockedControl.push(frame);
		},
	});
	expect(blockedLegacy).toEqual([]);
	expect(blockedControl).toEqual([]);
});

for (const [name, id, words] of [
	["low", "supply", "remains powered"],
	["reserve", "supply", "reserve pack keeps the box on"],
	["one-bank", "redundancy", "no confirmed backup bank"],
	["resting", "bank-a", "Bank B powers the box"],
	["bench", "bench", "only reports"],
	["gaps", "gap-sink", "charger chip"],
	["gaps2", "protection", "reduced protection"],
	["uncalibrated", "calibration", "no heat protection"],
	["shutdown-request", "shutdown", "Power remains on"],
] as const) {
	test(`${name} explains power without changing the stream`, async () => {
		const state = await read(name);
		expect(state.notices.find((n) => n.id === id)?.message).toContain(words);
	});
}
for (const name of [
	"unsupported",
	"stale-flag",
	"ambiguous",
	"no-timestamp",
	"bootloader",
	"silent",
]) {
	test(`${name} cannot reuse retained measurements or warnings`, async () => {
		expect(await read(name)).toEqual({
			available: false,
			summary: "Power data not available",
			sensors: {},
			notices: [],
		});
	});
}
test("supervisor reboot accepts the new complete status without carrying old alarms", async () => {
	const removed: string[] = [];
	const reconcile = createPowerReconciler(
		() => {},
		(id) => {
			removed.push(id);
		},
	);
	reconcile(await read("hot"));
	const restarted = await read("supervisor-reboot");
	reconcile(restarted);
	expect(restarted.available).toBe(true);
	expect(restarted.boot).toBe("abcdef01");
	expect(removed).toEqual(["heat"]);
});
test("reader leaves fixture bytes unchanged and has no control dependencies", async () => {
	const before = await Bun.file(fixture("hot")).text();
	await read("hot");
	expect(await Bun.file(fixture("hot")).text()).toBe(before);
	const source = await Bun.file(
		new URL("../modules/system/power-state.ts", import.meta.url),
	).text();
	expect(source).not.toMatch(
		/Bun\.(write|spawn)|node:fs|serial|\/dev\/tty|streaming\.ts/,
	);
});

test("mock and development monitoring never reads the device power files", async () => {
	const previous = process.env.MOCK_MODE;
	process.env.MOCK_MODE = "true";
	const monitor = await import("../modules/system/power-monitor.ts");
	const mocks = await import("../mocks/mock-service.ts");
	mocks.initMockService("multi-modem-wifi");
	expect(mocks.shouldUseMocks()).toBe(true);
	const files = spyOn(Bun, "file");
	try {
		let published = false;
		monitor.initPowerMonitoring(() => {
			published = true;
		});
		expect(files).not.toHaveBeenCalled();
		expect(published).toBe(false);
	} finally {
		files.mockRestore();
		mocks.stopMockService();
		if (previous === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = previous;
	}
});

test("a failed legacy peer does not suppress the control snapshot", async () => {
	const { deliverPowerSensors } = await import(
		"../modules/system/power-delivery.ts"
	);
	const frames: unknown[] = [];
	deliverPowerSensors(
		{ Power: "Power data not available" },
		{
			legacy: () => ({
				authenticated: true,
				send: () => {
					throw Error("closed");
				},
			}),
			controlConnected: () => true,
			sendControl: (frame) => {
				frames.push(frame);
			},
		},
	);
	expect(frames).toHaveLength(1);
});

test("heat notice names the supervisor-selected reserve pack and its consequence", async () => {
	expect((await read("warm")).summary).toContain("The reserve pack is warm");
	expect((await read("hot")).summary).toContain("The reserve pack is hot");
	expect((await read("critical")).summary).toContain(
		"The box switches off if it gets hotter",
	);
});

async function changed(
	patch: Record<string, unknown>,
	fields: Record<string, string | undefined> = {},
	now = 10000,
) {
	const dir = await mkdtemp(`${tmpdir()}/power-reader-`);
	try {
		const data = await Bun.file(fixture("fresh")).json();
		Object.assign(data.fields, fields);
		Object.assign(data, patch);
		await Bun.write(`${dir}/state.json`, JSON.stringify(data));
		return await readPowerState(`${dir}/state.json`, now);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
test.skipIf(process.platform !== "linux" || !Bun.which("python3"))(
	"a separate writer's real CLOCK_MONOTONIC timestamp is fresh with the default reader clock",
	async () => {
		const dir = await mkdtemp(`${tmpdir()}/power-clock-`);
		try {
			// A separate process stamps the file using the writer's clock, never an injected now.
			const child = Bun.spawn([
				"python3",
				"-c",
				`import json,time,sys
s=json.load(open(sys.argv[1]))
s['published_mono_ms']=s['rx_mono_ms']=time.clock_gettime_ns(time.CLOCK_MONOTONIC)//1000000
json.dump(s,open(sys.argv[2],'w'))`,
				fixture("fresh"),
				`${dir}/state.json`,
			]);
			expect(await child.exited).toBe(0);
			expect((await readPowerState(`${dir}/state.json`)).available).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);
test("normal estimated calibration and bench gaps do not raise protection warnings", async () => {
	expect(
		(await changed({}, { gaps: "0004", pack_cal: "datasheet" })).notices,
	).toEqual([]);
	expect(
		(await changed({}, { gaps: "0001", armed: "0" })).notices.map((n) => n.id),
	).toEqual(["bench"]);
});
test("canonical resting bank example has one coherent notice", async () => {
	const state = await changed(
		{},
		{
			a: "stood_down:thermal/5.00V/0.00A/52.0C/00",
			b: "healthy/20.00V/1.00A/30.0C/00",
			thermal: "hot",
			hot: "a",
			redundant: "0",
			pack_cal: "datasheet",
			gaps: "0004",
		},
	);
	expect(state.notices.map((n) => n.id)).toEqual(["bank-a"]);
	expect(state.notices[0]?.type).toBe("info");
	expect(state.summary).toBe(
		"Bank A is hot and resting. Bank B powers the box.",
	);
});
test("an absent bank's reported temperature is never shown", async () => {
	expect(
		(await changed({}, { a: "absent/0V/0A/25C/00" })).sensors["Bank A"],
	).toBe("Temperature unavailable");
});
test("absent and never expected has no power row", async () => {
	expect((await changed({ link: "absent", expected: false })).summary).toBe("");
	const { getPowerSensors } = await import(
		"../modules/system/power-monitor.ts"
	);
	expect(getPowerSensors()).toEqual({});
});
for (const [errno, words] of [
	[13, "permission"],
	[16, "busy"],
	[5, "error 5"],
] as const) {
	test(`open error ${errno} remains an explicit diagnostic`, async () => {
		const state = await changed({
			link: "error",
			open_error: errno,
			stale: true,
		});
		expect(state.available).toBe(false);
		expect(state.summary).toContain(words);
		expect(state.sensors).toEqual({});
	});
}
test("marker persistence failure is specific and does not hide fresh telemetry", async () => {
	const state = await changed({ persist_error: true, restarts: 2 });
	expect(state.available).toBe(true);
	expect(state.summary).toContain("remember");
});
test("a healthy peer makes replacement advice safe", async () => {
	const state = await changed(
		{},
		{
			a: "healthy/20V/1A/52C/00",
			b: "healthy/20V/1A/30C/00",
			thermal: "hot",
			hot: "a",
		},
	);
	expect(state.summary).not.toContain("only bank");
});

for (const [bit, words] of [
	[1, "no heat protection"],
	[3, "sensor is not working"],
	[4, "Bank A"],
	[5, "Bank B"],
	[6, "cannot read"],
	[7, "30 seconds"],
	[8, "shutdown signal"],
	[9, "save"],
	[10, "watchdog"],
	[11, "unresponsive"],
	[12, "restarting"],
	[13, "without any working"],
	[14, "loose contact"],
	[15, "charger chip"],
	[16, "feeding"],
	[17, "jumped"],
	[18, "Bank A stopped answering while it rested"],
	[19, "Bank B stopped answering while it rested"],
] as const) {
	test(`gap bit ${bit} explains its own limitation`, async () => {
		const mask = 2 ** bit;
		expect(
			(
				await changed(
					{},
					{
						gaps: (mask % 65536).toString(16).padStart(4, "0"),
						gaps2: Math.floor(mask / 65536)
							.toString(16)
							.padStart(4, "0"),
					},
				)
			).summary,
		).toContain(words);
	});
}
for (const gaps of ["zzzz", "12345"])
	test(`malformed gap ${gaps} cannot imply full protection`, async () => {
		expect((await changed({}, { gaps })).notices.map((n) => n.id)).toEqual([
			"protection",
		]);
	});

for (const link of [
	"ok",
	"absent",
	"error",
	"silent",
	"bootloader",
	"unknown_version",
]) {
	for (const heartbeat of [undefined, null, "10000", -1, 9999.5, 10001, 7000]) {
		test(`${link}: invalid or expired heartbeat ${heartbeat} never establishes state`, async () => {
			const now = heartbeat === -1 ? 1000 : 10000;
			const state = await changed(
				{
					link,
					expected: false,
					published_mono_ms: heartbeat,
					rx_mono_ms: now,
				},
				{},
				now,
			);
			expect(state).toEqual({
				available: false,
				summary: "Power data not available",
				sensors: {},
				notices: [],
			});
		});
	}
}
test("heartbeat boundary is independent of status boundary", async () => {
	expect((await changed({ published_mono_ms: 7001 })).available).toBe(true);
	expect((await changed({ published_mono_ms: 7000 })).available).toBe(false);
	expect(
		(await changed({ published_mono_ms: 14999 }, {}, 14999)).available,
	).toBe(true);
	expect(
		(await changed({ published_mono_ms: 15000 }, {}, 15000)).available,
	).toBe(false);
});
test("a frozen absent snapshot expires, while a live absent heartbeat keeps advancing", async () => {
	for (const now of [10000, 12000, 15000]) {
		expect(
			(
				await changed(
					{ link: "absent", expected: false, published_mono_ms: now },
					{},
					now,
				)
			).summary,
		).toBe("");
	}
	expect(
		(
			await changed(
				{ link: "absent", expected: false, published_mono_ms: 10000 },
				{},
				13000,
			)
		).summary,
	).toBe("Power data not available");
});
test("stopped cannot reuse retained measurements or claim no board", async () => {
	for (const expected of [true, false])
		expect(await changed({ link: "stopped", expected })).toEqual({
			available: false,
			summary: "Power data not available",
			sensors: {},
			notices: [],
		});
});
for (const link of ["silent", "bootloader", "unknown_version"])
	test(`${link} never expected keeps the quiet unavailable row`, async () => {
		expect(await changed({ link, expected: false })).toEqual({
			available: false,
			summary: "Power data not available",
			sensors: {},
			notices: [],
		});
		expect(
			(await changed({ link, expected: false, ambiguous: true })).summary,
		).toBe("Power data not available");
	});
test("shutdown requested without a cause still explains the shutdown", async () => {
	expect(
		(await changed({}, { sbc: "shutdown_requested" })).notices.some(
			(n) => n.id === "shutdown",
		),
	).toBe(true);
});
test("a missing gaps or gaps2 half leaves protection unknown, never full", async () => {
	for (const missing of ["gaps", "gaps2"]) {
		const state = await changed({}, { [missing]: undefined });
		expect(state.notices.map((n) => n.id)).toEqual(["protection"]);
		expect(state.supervisor?.protection).toBe("unknown");
		expect(state.supervisor?.gaps).toBeNull();
	}
});
test("summary says the box remains powered once across multiple notices", async () => {
	const state = await changed({}, { gaps: "0038", redundant: "0" });
	expect(state.notices.length).toBeGreaterThan(1);
	expect(state.summary.match(/The box remains powered\./g)).toHaveLength(1);
	expect(state.summary).toContain(
		"The box will not switch off if the pack overheats.",
	);
});

test("a throwing clock quietly makes the retained snapshot unavailable", async () => {
	const clockSpy = spyOn(clock, "monotonicMs").mockImplementation(() => {
		throw Error("unavailable");
	});
	try {
		expect(await readPowerState(fixture("fresh"))).toEqual({
			available: false,
			summary: "Power data not available",
			sensors: {},
			notices: [],
		});
	} finally {
		clockSpy.mockRestore();
	}
});

for (const [heartbeat, now, rx] of [
	[-1, 1000, 999],
	[9999.5, 10000, 10000],
])
	test(`otherwise fresh heartbeat ${heartbeat} is rejected by its numeric guard`, async () => {
		const overrides = { rx_mono_ms: rx, published_mono_ms: now };
		expect((await changed(overrides, {}, now)).available).toBe(true);
		expect(
			await changed({ ...overrides, published_mono_ms: heartbeat }, {}, now),
		).toEqual({
			available: false,
			summary: "Power data not available",
			sensors: {},
			notices: [],
		});
	});

const firmwareLines = async () =>
	(
		await Bun.file(
			new URL("./fixtures/power/firmware-lines.txt", import.meta.url),
		).text()
	)
		.trim()
		.split("\n")
		.map((row) => row.split("\t") as [string, string]);
const crc16 = (text: string) => {
	let crc = 0xffff;
	for (const byte of new TextEncoder().encode(text)) {
		crc ^= byte << 8;
		for (let bit = 0; bit < 8; bit++)
			crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
	}
	return crc.toString(16).toUpperCase().padStart(4, "0");
};
test("firmware snapshots match the status lines they were decoded from", async () => {
	const rows = await firmwareLines();
	expect(rows.length).toBeGreaterThanOrEqual(7);
	for (const [name, line] of rows) {
		// Frame rules of the power service's reader: version prefix, status not event,
		// bounded length, key=value tokens with unique keys, checksum last.
		expect(line.startsWith("OSB1 ")).toBe(true);
		expect(line.startsWith("OSB1 EVT ")).toBe(false);
		expect(line.length).toBeLessThan(512);
		expect(line).toMatch(
			/^OSB1( [a-z][a-z0-9_]{0,30}=[!-~]{1,159})+ crc=[0-9A-F]{4}$/,
		);
		const keys = line
			.split(" ")
			.slice(1)
			.map((t) => t.split("=")[0]);
		expect(new Set(keys).size).toBe(keys.length);
		const [body, crc] = line.split(" crc=");
		expect(crc).toBe(crc16(body ?? ""));
		const fields = Object.fromEntries(
			(body ?? "")
				.split(" ")
				.slice(1)
				.map((field) => [
					field.slice(0, field.indexOf("=")),
					field.slice(field.indexOf("=") + 1),
				]),
		);
		expect((await Bun.file(fixture(name)).json()).fields).toEqual(fields);
	}
});
describe("a bank that does not come back from its rest", () => {
	const wake = "press its button or replug it.";
	for (const [name, bank, peer, heat, recovery] of [
		["rest-lost-a-gone", "A", "B", "", wake],
		[
			// The checked-in firmware frame: rested for heat, still the hottest bank.
			"rest-lost-a-silent",
			"A",
			"B",
			"Bank A is hot. Improve airflow or swap it for a cool bank. ",
			`let it cool, then ${wake}`,
		],
		["rest-lost-b-gone", "B", "A", "", wake],
	] as const) {
		test(`${name} names the bank, what to do and who powers the box`, async () => {
			const state = await read(name);
			const notice = state.notices.find(
				(n) => n.id === `bank-${bank.toLowerCase()}`,
			);
			expect(notice?.type).toBe("warning");
			expect(notice?.message).toBe(
				`${heat}Bank ${bank} stopped answering while it rested. It may have switched itself off: ${recovery} Bank ${peer} powers the box.`,
			);
			const ids = state.notices.map((n) => n.id);
			// The specific words replace the generic ones, and a resting notice for the same bank.
			expect(ids).not.toContain("protection");
			expect(ids).not.toContain("redundancy");
			expect(ids).not.toContain(`gap-${bank.toLowerCase()}_rest_lost`);
			expect(ids).not.toContain("heat");
			expect(state.summary).not.toContain("is hot and resting");
			expect(state.supervisor?.gaps).toContain(
				`${bank.toLowerCase()}_rest_lost`,
			);
		});
	}
	test("a silent sink beside it is still said", async () => {
		expect((await read("rest-lost-a-silent")).notices.map((n) => n.id)).toEqual(
			["bank-a", "gap-sink"],
		);
	});
	for (const [level, words, recovery] of [
		[
			"warm",
			"Bank A is warm. Give it more airflow. Bank A stopped",
			"switched itself off: press its button",
		],
		[
			"hot",
			"Bank A is hot. Improve airflow or swap it for a cool bank. Connect the replacement before removing the only bank. Bank A stopped",
			"switched itself off: let it cool, then press its button",
		],
		[
			"critical",
			"Bank A is very hot. Improve airflow or swap it for a cool bank. Connect the replacement before removing the only bank. Bank A stopped",
			"switched itself off: let it cool, then press its button",
		],
	] as const)
		test(`a ${level} bank that stops answering keeps its heat advice first`, async () => {
			const state = await changed(
				{},
				{
					thermal: level,
					hot: "a",
					a: "stood_down:thermal/5.00V/0.00A/58.0C/41",
					b: "sagging/18.00V/1.00A/30.0C/00",
					gaps2: "0004",
				},
			);
			expect(state.notices.map((n) => n.id)).toEqual(["bank-a"]);
			expect(state.notices[0]?.message).toStartWith(words);
			// A hot bank is never sent straight back into use.
			expect(state.notices[0]?.message).toContain(recovery);
		});
	test("heat on the other bank stays its own notice", async () => {
		const state = await changed(
			{},
			{
				thermal: "hot",
				hot: "b",
				a: "absent/0.00V/0.00A/30.0C/00",
				b: "healthy/20.00V/1.00A/52.0C/00",
				gaps2: "0004",
			},
		);
		expect(state.notices.map((n) => n.id)).toEqual(["heat", "bank-a"]);
		expect(state.notices[0]?.message).toContain("Bank B is hot");
	});
	test("both banks lost while the reserve carries the box", async () => {
		const state = await changed(
			{},
			{
				power: "holdup",
				a: "absent/0.00V/0.00A/30.0C/00",
				b: "absent/0.00V/0.00A/30.0C/00",
				gaps2: "000c",
			},
		);
		expect(state.notices.map((n) => n.id)).toEqual([
			"supply",
			"bank-a",
			"bank-b",
		]);
		expect(state.summary).toContain("Bank B stopped answering");
		expect(state.summary).not.toContain("powers the box");
	});
	test("the notice clears once the bank reads healthy again", async () => {
		const removed: string[] = [];
		const reconcile = createPowerReconciler(
			() => {},
			(id) => {
				removed.push(id);
			},
		);
		reconcile(await read("rest-lost-a-silent"));
		const cleared = await read("rest-lost-cleared");
		reconcile(cleared);
		expect(removed.sort()).toEqual(["bank-a", "gap-sink"]);
		expect(cleared.supervisor?.gaps).toEqual([]);
	});
});
describe("supervisor fields across firmware versions", () => {
	test("current firmware reports calibration, start reason and gap names", async () => {
		expect((await read("rest-lost-a-silent")).supervisor).toEqual({
			packCalibration: "bench",
			start: "on",
			protection: "reduced",
			gaps: ["sink", "a_rest_lost"],
		});
		expect((await read("rest-lost-cleared")).supervisor?.protection).toBe(
			"no_reported_gaps",
		);
	});
	test("firmware before gaps2 still reads its resting bank; protection is unknown", async () => {
		const state = await read("firmware-before-gaps2");
		expect(state.notices.map((n) => n.id)).toEqual(["bank-a", "protection"]);
		expect(state.supervisor).toEqual({
			packCalibration: "bench",
			start: "on",
			protection: "unknown",
			gaps: null,
		});
	});
	for (const [fields, ids] of [
		[{ gaps: "8000", gaps2: undefined }, ["protection", "gap-sink"]],
		[{ gaps: "8000", gaps2: "zzzz" }, ["protection", "gap-sink"]],
		[{ gaps: undefined, gaps2: "0004" }, ["bank-a", "protection"]],
		[{ gaps: "0x80", gaps2: "0004" }, ["bank-a", "protection"]],
	] as const)
		test(`the readable half still warns: ${JSON.stringify(fields)}`, async () => {
			const state = await changed(
				{},
				{ ...fields, a: "absent/0.00V/0.00A/30.0C/00" },
			);
			expect(state.notices.map((n) => n.id)).toEqual([...ids]);
			expect(state.supervisor?.protection).toBe("unknown");
			expect(state.supervisor?.gaps).toBeNull();
		});
	test("an unknown board profile is not read as this board's protection", async () => {
		const state = await changed({}, { profile: "other-board-v1" });
		expect(state.notices.map((n) => n.id)).toEqual(["protection"]);
		expect(state.supervisor?.protection).toBe("unknown");
		expect(state.supervisor?.gaps).toBeNull();
		const unknownBits = await changed(
			{},
			{ profile: "other-board-v1", gaps: "8000", gaps2: "0004" },
		);
		expect(unknownBits.notices.map((n) => n.id)).toEqual(["protection"]);
		expect(
			(await changed({}, { profile: "dual-input-reserve-v1" })).notices,
		).toEqual([]);
	});
	test("firmware before the policy fields keeps them unknown", async () => {
		const state = await read("firmware-before-policy-fields");
		expect(state.available).toBe(true);
		expect(state.notices.map((n) => n.id)).toEqual(["bank-a", "protection"]);
		expect(state.supervisor).toEqual({
			packCalibration: null,
			start: null,
			protection: "unknown",
			gaps: null,
		});
	});
	test("newer firmware keys are ignored and unknown bits still mean reduced protection", async () => {
		const state = await read("firmware-newer-keys");
		expect(state.notices.map((n) => n.id)).toEqual(["bank-a", "protection"]);
		expect(state.supervisor?.gaps).toEqual(["a_rest_lost", "bit20"]);
	});
	test("a start reason or calibration from newer firmware is passed on as reported", async () => {
		const state = await changed({}, { start: "charging", pack_cal: "factory" });
		expect(state.supervisor?.start).toBe("charging");
		expect(state.supervisor?.packCalibration).toBe("factory");
		expect(state.notices).toEqual([]);
	});
	for (const [field, value] of [
		["start", "On!"],
		["start", ""],
		["pack_cal", "x".repeat(40)],
		["pack_cal", "bench/none"],
	] as const)
		test(`garbage ${field}=${JSON.stringify(value).slice(0, 12)} reads as unknown`, async () => {
			const state = await changed({}, { [field]: value });
			expect(
				state.supervisor?.[field === "start" ? "start" : "packCalibration"],
			).toBeNull();
		});
	for (const gaps2 of ["zzzz", "00004", "", "0x04"])
		test(`garbage gaps2 ${JSON.stringify(gaps2)} cannot hide reduced protection`, async () => {
			const state = await changed({}, { gaps2 });
			expect(state.notices.map((n) => n.id)).toEqual(["protection"]);
			expect(state.supervisor?.gaps).toBeNull();
		});
});
