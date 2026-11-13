import { afterEach, expect, test } from "bun:test";
import {
	createProcessSignaller,
	DEV_HARNESS_MARKER,
	ownsNoHostProcesses,
} from "@ceraui/srtla-send/process-signals";

const savedEnv = {
	NODE_ENV: process.env.NODE_ENV,
	MOCK_MODE: process.env.MOCK_MODE,
};
afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	delete (globalThis as Record<symbol, unknown>)[DEV_HARNESS_MARKER];
});

test("development name signals never execute host commands, including before mock initialization", async () => {
	let calls = 0;
	const signal = createProcessSignaller(() => true);
	await signal("killall", ["srtla_send"], async () => {
		calls++;
	});
	await signal("pkill", ["-x", "wvkbd-mobintl"], async () => {
		calls++;
	});
	expect(calls).toBe(0);
});

test("the hostless gate matches the mock gate and the development harness marker", () => {
	process.env.NODE_ENV = "test";
	delete process.env.MOCK_MODE;
	expect(ownsNoHostProcesses()).toBe(false);
	process.env.MOCK_MODE = "true";
	expect(ownsNoHostProcesses()).toBe(true);
	delete process.env.MOCK_MODE;
	process.env.NODE_ENV = "development";
	expect(ownsNoHostProcesses()).toBe(true);
	process.env.NODE_ENV = "test";
	(globalThis as Record<symbol, unknown>)[DEV_HARNESS_MARKER] = true;
	expect(ownsNoHostProcesses()).toBe(true);
});

test("production retains the exact command and arguments through the injectable seam", async () => {
	const calls: string[][] = [];
	const signal = createProcessSignaller(
		() => false,
		async (bin, args) => {
			calls.push([bin, ...args]);
		},
	);
	await signal("killall", ["-HUP", "srtla_send"], async () => {
		throw new Error("injected runner required");
	});
	expect(calls).toEqual([["killall", "-HUP", "srtla_send"]]);
});

test("production executes its supplied effect synchronously and preserves errors", () => {
	const signal = createProcessSignaller(() => false);
	let called = false;
	void signal("killall", ["srtla_send"], () => {
		called = true;
	});
	expect(called).toBe(true);
	expect(() =>
		signal("pkill", ["-x", "example"], () => {
			throw new Error("spawn failed");
		}),
	).toThrow("spawn failed");
});
