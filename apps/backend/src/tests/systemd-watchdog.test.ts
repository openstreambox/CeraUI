import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { startServiceWatchdog } from "../helpers/systemd-watchdog.ts";

test("watchdog pulses on the main event loop, only for the configured service PID", () => {
	let tick: (() => void) | undefined;
	let interval = 0,
		pulses = 0,
		cancelled = 0;
	const stop = startServiceWatchdog({
		env: {
			NODE_ENV: "production",
			NOTIFY_SOCKET: "/run/notify",
			WATCHDOG_USEC: "30000000",
			WATCHDOG_PID: String(process.pid),
		},
		notify: () => {
			pulses++;
		},
		schedule: (callback, ms) => {
			tick = callback;
			interval = ms;
			return () => {
				cancelled++;
			};
		},
	});
	expect(interval).toBe(15000);
	expect(pulses).toBe(1);
	tick?.();
	expect(pulses).toBe(2);
	stop();
	expect(cancelled).toBe(1);
	for (const env of [
		{ NODE_ENV: "development" },
		{
			NODE_ENV: "production",
			NOTIFY_SOCKET: "/run/notify",
			WATCHDOG_USEC: "30000000",
			WATCHDOG_PID: "99999999",
		},
	]) {
		startServiceWatchdog({
			env,
			notify: () => {
				throw Error("must stay inert");
			},
		});
	}
	const service = readFileSync(
		new URL("../../../../deployment/ceralive.service", import.meta.url),
		"utf8",
	);
	expect(service).toContain("WatchdogSec=30s");
	expect(service).toContain("WatchdogSignal=SIGKILL");
	const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
	expect(main).toContain("startServiceWatchdog()");
});
