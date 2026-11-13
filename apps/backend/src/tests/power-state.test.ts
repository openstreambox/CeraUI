import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
		expect((await read("fresh", 14999)).available).toBe(true);
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
	fields: Record<string, string> = {},
) {
	const dir = await mkdtemp(`${tmpdir()}/power-reader-`);
	try {
		const data = await Bun.file(fixture("fresh")).json();
		Object.assign(data.fields, fields);
		Object.assign(data, patch);
		await Bun.write(`${dir}/state.json`, JSON.stringify(data));
		return await readPowerState(`${dir}/state.json`, 10000);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
test.skipIf(process.platform !== "linux")(
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
s['rx_mono_ms']=time.clock_gettime_ns(time.CLOCK_MONOTONIC)//1000000
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
