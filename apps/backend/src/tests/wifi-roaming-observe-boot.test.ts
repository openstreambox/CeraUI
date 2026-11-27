import { afterEach, describe, expect, test } from "bun:test";
import { runtimeConfigSchema } from "../helpers/config-schemas.ts";
import {
	handleTerminationSignal,
	resetShutdownForTest,
} from "../helpers/shutdown.ts";
import {
	initWifiRoaming,
	stopWifiRoaming,
} from "../modules/network/wifi-roaming/runtime.ts";

afterEach(() => resetShutdownForTest());

describe("the roaming config", () => {
	const roaming = runtimeConfigSchema.shape.wifi_roaming;

	test("observe and off are the only levels; nudge is not offered", () => {
		expect(roaming.safeParse({ level: "observe" }).success).toBe(true);
		expect(roaming.safeParse({ level: "off" }).success).toBe(true);
		expect(roaming.safeParse({ level: "nudge" }).success).toBe(false);
		expect(roaming.safeParse({}).success).toBe(false);
		expect(roaming.safeParse(undefined).success).toBe(true);
	});

	test("exclude lists permanent MACs", () => {
		expect(
			roaming.safeParse({ level: "observe", exclude: ["02:00:00:00:00:0A"] })
				.success,
		).toBe(true);
		expect(
			roaming.safeParse({ level: "observe", exclude: ["wlan1"] }).success,
		).toBe(false);
	});

	test("a config without the key parses and keeps no roaming key", () => {
		const parsed = runtimeConfigSchema.parse({});
		expect("wifi_roaming" in parsed).toBe(false);
	});
});

describe("boot and shutdown", () => {
	test("off, and observe next to the two-radio coordinator, start nothing", async () => {
		await initWifiRoaming(undefined, false);
		await initWifiRoaming({ level: "off" }, false);
		await initWifiRoaming({ level: "observe" }, true);
		// Nothing started, so stopping has nothing to wait for.
		await stopWifiRoaming();
	});

	test("shutdown awaits the observer's stop before the streaming shutdown and exit", async () => {
		const order: string[] = [];
		const drained = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<void>();
		handleTerminationSignal("SIGTERM", {
			stopWifiRoaming: async () => {
				order.push("roaming-stop");
				await drained.promise;
				order.push("roaming-drained");
			},
			stopSrtIngest: async () => {},
			stopDmesgWatchers: () => {},
			gracefulShutdown: async () => {
				order.push("streaming");
			},
			exit: () => {
				order.push("exit");
				finished.resolve();
			},
		});
		await Bun.sleep(10);
		expect(order).toEqual(["roaming-stop"]);
		drained.resolve();
		await finished.promise;
		expect(order).toEqual([
			"roaming-stop",
			"roaming-drained",
			"streaming",
			"exit",
		]);
	});
});
