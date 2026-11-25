import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	handleTerminationSignal,
	resetShutdownForTest,
} from "../helpers/shutdown.ts";

afterEach(resetShutdownForTest);

test("the idle exit is recorded before any teardown and only once", async () => {
	const order: string[] = [];
	const exited = Promise.withResolvers<void>();
	const deps = {
		recordIdleExit: () => order.push("record"),
		stopRecoveryRetries: () => {
			order.push("retries");
		},
		gracefulShutdown: async () => {
			order.push("streaming");
		},
		stopSrtIngest: async () => {
			order.push("ingest");
		},
		stopDmesgWatchers: () => {
			order.push("dmesg");
		},
		exit: () => exited.resolve(),
	};
	handleTerminationSignal("SIGTERM", deps);
	handleTerminationSignal("SIGTERM", deps);
	await exited.promise;
	expect(order[0]).toBe("record");
	expect(order.filter((step) => step === "record")).toHaveLength(1);
	expect(order).toContain("streaming");
});

test("a failing record never blocks the shutdown", async () => {
	const exited = Promise.withResolvers<number>();
	handleTerminationSignal("SIGTERM", {
		recordIdleExit: () => {
			throw new Error("boom");
		},
		gracefulShutdown: async () => undefined,
		stopSrtIngest: async () => undefined,
		stopDmesgWatchers: () => undefined,
		exit: (code) => exited.resolve(code),
	});
	expect(await exited.promise).toBe(0);
});

test("production records the idle exit from the box's whole stream liveness", () => {
	const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
	const handlers = main.slice(
		main.indexOf("const termination = terminationHandlers({"),
	);
	expect(handlers).toMatch(
		/^const termination = terminationHandlers\(\{\s*(\/\/[^\n]*\n\s*)*recordIdleExit: \(\) => \{\s*recordCarryingIdleExit\(getStreamLiveness\(\)\);/,
	);
});
