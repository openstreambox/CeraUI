import { describe, expect, spyOn, test } from "bun:test";
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
			expect(state.summary).toBe("Power data not available");
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
	expect(JSON.parse(legacy[0] ?? "{}").sensors).toEqual(sensors);
	expect(StatusSchema.parse(control[0]).payload).toEqual(sensors);
	deliverPowerSensors(sensors, {
		legacy: () => ({
			authenticated: false,
			send: () => {
				throw Error("unauthenticated delivery");
			},
		}),
		controlConnected: () => false,
		sendControl: () => {
			throw Error("disconnected delivery");
		},
	});
});

for (const [name, id, words] of [
	["low", "supply", "remains powered"],
	["reserve", "supply", "Running on reserve"],
	["one-bank", "redundancy", "no confirmed backup bank"],
	["resting", "bank-a", "Bank B supplies power"],
	["bench", "bench", "only reports"],
	["gaps", "protection", "reduced protection"],
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
		"The box will switch off above 65 °C",
	);
});
