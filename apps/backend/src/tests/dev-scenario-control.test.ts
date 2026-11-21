import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { devScenarioApplyInputSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import { isMockClockPinned, unpinMockClock } from "../mocks/mock-clock.ts";
import {
	getMockState,
	initMockService,
	resetMockState,
	stopMockService,
} from "../mocks/mock-service.ts";
import { buildMockLinkTelemetry } from "../mocks/providers/streaming.ts";
import {
	devScenarioApplyProcedure,
	devScenarioResetProcedure,
	devScenarioStatusProcedure,
} from "../rpc/procedures/dev.procedure.ts";
import { permitsScenarioDriver } from "../rpc/scenario-driver-admission.ts";
import type { RPCContext } from "../rpc/types.ts";
import { wifiProtocolContext } from "./helpers/wifi-protocol-context.ts";

const saved = {
	MOCK_MODE: process.env.MOCK_MODE,
	NODE_ENV: process.env.NODE_ENV,
};

function driverContext(driver = true): RPCContext {
	const context = wifiProtocolContext();
	context.ws.data.scenarioDriver = driver;
	return context;
}

async function step(t_ms: number, events: unknown[] = [], seed = 4711) {
	const input = devScenarioApplyInputSchema.parse({ seed, t_ms, events });
	return call(devScenarioApplyProcedure, input, { context: driverContext() });
}

function row(iface: string) {
	return buildMockLinkTelemetry()?.links.find((link) => link.iface === iface);
}

beforeEach(() => {
	jest.useFakeTimers();
	jest.setSystemTime(0);
	process.env.MOCK_MODE = "true";
	initMockService("streaming-active");
});

afterEach(() => {
	unpinMockClock();
	resetMockState();
	stopMockService();
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	jest.useRealTimers();
});

test("a step pins the mock clock and reports its status", async () => {
	const result = await step(20_000);
	expect(result).toEqual({
		success: true,
		status: {
			pinned: true,
			seed: 4711,
			t_ms: 20_000,
			links: {},
			bitrate_target_kbps: null,
		},
	});
	expect(isMockClockPinned()).toBe(true);
});

test("box.link sets round trip, NAKs and staleness on one link only", async () => {
	await step(0);
	const before = row("usb0");
	await step(1_000, [
		{ type: "box.link", iface: "usb1", rtt_ms: 180, nak_count: 6, stale: true },
	]);
	expect(row("usb1")).toMatchObject({ rtt_ms: 180, nak_count: 6, stale: true });
	// usb0 keeps the default drift band (20-60 ms) and is not stale.
	expect(row("usb0")?.stale).toBe(false);
	expect(row("usb0")?.rtt_ms).toBeGreaterThanOrEqual(20);
	expect(row("usb0")?.rtt_ms).toBeLessThanOrEqual(60);
	expect(before?.iface).toBe("usb0");
});

test("box.link weight_scale shrinks a link's share; gone removes its row and the rest share 100 %", async () => {
	await step(0);
	const share = row("usb1")?.weight_percent ?? 0;
	await step(1_000, [{ type: "box.link", iface: "usb1", weight_scale: 0.2 }]);
	expect(row("usb1")?.weight_percent ?? 0).toBeLessThan(share);

	await step(2_000, [{ type: "box.link", iface: "usb1", gone: true }]);
	const telemetry = buildMockLinkTelemetry();
	expect(telemetry?.links.map((link) => link.iface)).not.toContain("usb1");
	const total =
		telemetry?.links.reduce((sum, link) => sum + link.weight_percent, 0) ?? 0;
	expect(Math.abs(total - 100)).toBeLessThanOrEqual(2);
});

test("box.link merges with earlier overrides; reset drops them first", async () => {
	await step(0, [{ type: "box.link", iface: "usb1", rtt_ms: 180 }]);
	await step(1_000, [{ type: "box.link", iface: "usb1", nak_count: 4 }]);
	expect(getMockState().linkOverrides.usb1).toEqual({
		rtt_ms: 180,
		nak_count: 4,
	});
	await step(2_000, [
		{ type: "box.link", iface: "usb1", reset: true, rtt_ms: 90 },
	]);
	expect(getMockState().linkOverrides.usb1).toEqual({ rtt_ms: 90 });
	await step(3_000, [{ type: "box.link", iface: "usb1", reset: true }]);
	expect(getMockState().linkOverrides.usb1).toBeUndefined();
});

test("box.bitrate sets the bond's measured total near the target, and reset returns to the drift", async () => {
	await step(0, [{ type: "box.bitrate", target_kbps: 6_500 }]);
	const measured = buildMockLinkTelemetry()?.measured_bps ?? 0;
	expect(measured).toBeGreaterThan(6_500_000 * 0.97);
	expect(measured).toBeLessThan(6_500_000 * 1.03);
	await step(1_000);
	expect(getMockState().streaming.bitrate).toBeGreaterThan(6_500 * 0.97);
	expect(getMockState().streaming.bitrate).toBeLessThan(6_500 * 1.03);

	await step(2_000, [{ type: "box.bitrate", reset: true }]);
	const drift = buildMockLinkTelemetry()?.measured_bps ?? 0;
	expect(drift).toBeGreaterThanOrEqual(3_600_000);
	expect(drift).toBeLessThanOrEqual(4_400_000);
});

test("box.modem moves the modem's connection state", async () => {
	await step(0, [{ type: "box.modem", id: 1, state: "searching" }]);
	expect(getMockState().modemStates.get(1)).toBe("searching");
	await step(1_000, [{ type: "box.modem", id: 1, state: "connected" }]);
	expect(getMockState().modemStates.get(1)).toBe("connected");
});

test("the same seed and steps give the same mock state; another seed does not", async () => {
	const run = async (seed: number) => {
		// A scenario starts from a reset, as the driver does before its first step.
		await call(devScenarioResetProcedure, undefined, {
			context: driverContext(),
		});
		const out: unknown[] = [];
		for (const t of [0, 1_000, 2_000, 3_000]) {
			await step(
				t,
				t === 2_000 ? [{ type: "box.link", iface: "usb1", rtt_ms: 150 }] : [],
				seed,
			);
			const state = getMockState();
			out.push({
				signals: [...state.modemSignals],
				sensors: { ...state.sensors },
				bitrate: state.streaming.bitrate,
				links: buildMockLinkTelemetry()?.links,
			});
		}
		return out;
	};
	const first = await run(4711);
	// Unseeded host draws between runs must not leak in.
	Math.random();
	const second = await run(4711);
	expect(second).toEqual(first);
	expect(await run(4712)).not.toEqual(first);
});

test("reset unpins the clock and drops every override", async () => {
	await step(0, [
		{ type: "box.link", iface: "usb1", gone: true },
		{ type: "box.bitrate", target_kbps: 5_000 },
	]);
	const result = await call(devScenarioResetProcedure, undefined, {
		context: driverContext(),
	});
	expect(result.status).toEqual({
		pinned: false,
		seed: null,
		t_ms: null,
		links: {},
		bitrate_target_kbps: null,
	});
	expect(isMockClockPinned()).toBe(false);
	expect(row("usb1")).toBeDefined();
});

test("a socket that is not the driver is refused and changes nothing", async () => {
	const input = devScenarioApplyInputSchema.parse({
		seed: 1,
		t_ms: 0,
		events: [{ type: "box.link", iface: "usb1", gone: true }],
	});
	const context = driverContext(false);
	expect(await call(devScenarioApplyProcedure, input, { context })).toEqual({
		success: false,
		refused: "not_driver",
	});
	expect(
		await call(devScenarioStatusProcedure, undefined, { context }),
	).toEqual({
		success: false,
		refused: "not_driver",
	});
	expect(isMockClockPinned()).toBe(false);
	expect(getMockState().linkOverrides).toEqual({});
});

test("without mocks, and in production, the driver is refused too", async () => {
	const input = devScenarioApplyInputSchema.parse({ seed: 1, t_ms: 0 });
	process.env.MOCK_MODE = "false";
	process.env.NODE_ENV = "test";
	expect(
		await call(devScenarioApplyProcedure, input, { context: driverContext() }),
	).toEqual({ success: false, refused: "not_mock" });
	process.env.MOCK_MODE = "true";
	process.env.NODE_ENV = "production";
	expect(
		await call(devScenarioApplyProcedure, input, { context: driverContext() }),
	).toEqual({ success: false, refused: "production" });
	expect(isMockClockPinned()).toBe(false);
});

test("driver admission needs a configured 64-hex secret and the exact header", () => {
	const secret = "a".repeat(64);
	const request = (value?: string) =>
		new Request("http://127.0.0.1/ws", {
			headers: value === undefined ? {} : { "x-ceraui-scenario-secret": value },
		});
	expect(permitsScenarioDriver(request(secret), secret)).toBe(true);
	expect(permitsScenarioDriver(request(), secret)).toBe(false);
	expect(permitsScenarioDriver(request("b".repeat(64)), secret)).toBe(false);
	expect(permitsScenarioDriver(request(secret), undefined)).toBe(false);
	expect(permitsScenarioDriver(request("short"), "short")).toBe(false);
});

test("the event schema refuses unknown events, fields and out-of-range values", () => {
	const parse = (events: unknown[]) =>
		devScenarioApplyInputSchema.safeParse({ seed: 1, t_ms: 0, events }).success;
	expect(parse([{ type: "box.temp", c: 80 }])).toBe(false);
	expect(parse([{ type: "box.link", iface: "usb1", colour: "red" }])).toBe(
		false,
	);
	expect(parse([{ type: "box.link", iface: "../x", rtt_ms: 1 }])).toBe(false);
	expect(parse([{ type: "box.bitrate", target_kbps: 50 }])).toBe(false);
	expect(parse([{ type: "box.modem", id: 1, state: "flying" }])).toBe(false);
	expect(parse([{ type: "box.link", iface: "usb1", rtt_ms: 180 }])).toBe(true);
});
