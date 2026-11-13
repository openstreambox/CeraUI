import { expect, test } from "bun:test";
import { createProcessSignaller } from "@ceraui/srtla-send/process-signals";

test("development name signals never execute host commands, including before mock initialization", async () => {
	let calls = 0;
	const signal = createProcessSignaller(() => "development");
	await signal("killall", ["srtla_send"], async () => {
		calls++;
	});
	await signal("pkill", ["-x", "wvkbd-mobintl"], async () => {
		calls++;
	});
	expect(calls).toBe(0);
});

test("production retains the exact command and arguments through the injectable seam", async () => {
	const calls: string[][] = [];
	const signal = createProcessSignaller(
		() => "production",
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
	const signal = createProcessSignaller(() => "production");
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
