import { afterEach, expect, test } from "bun:test";
import { runtimeConfigSchema } from "../helpers/config-schemas.ts";
import {
	handleTerminationSignal,
	resetShutdownForTest,
} from "../helpers/shutdown.ts";

afterEach(() => resetShutdownForTest());

test("shutdown awaits roaming's drain before the streaming shutdown and exit", async () => {
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

test("the roaming config lists each radio once", () => {
	const roaming = runtimeConfigSchema.shape.wifi_roaming;
	expect(
		roaming.safeParse({
			enabled: true,
			radios: [{ id: "02:00:00:00:00:01" }, { id: "02:00:00:00:00:02" }],
		}).success,
	).toBe(true);
	expect(
		roaming.safeParse({
			enabled: true,
			radios: [
				{ id: "02:00:00:00:00:01" },
				{ id: "02:00:00:00:00:01", reserved: "hotspot" },
			],
		}).success,
	).toBe(false);
});
