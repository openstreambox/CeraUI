import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_SPAWN_TIMEOUT_MS } from "../helpers/spawn-policy.ts";
import {
	startServiceWatchdog,
	WATCHDOG_PULSE_MAX_MS,
	watchdogPulseMs,
} from "../helpers/systemd-watchdog.ts";

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
	expect(interval).toBe(1000);
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
	expect(service).toContain("WatchdogSignal=SIGKILL");
	const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
	expect(main).toContain("startServiceWatchdog()");
});

test("pulses at most once a second, and at half a short interval", () => {
	expect(watchdogPulseMs(90_000_000)).toBe(WATCHDOG_PULSE_MAX_MS);
	expect(watchdogPulseMs(30_000_000)).toBe(WATCHDOG_PULSE_MAX_MS);
	expect(watchdogPulseMs(1_000_000)).toBe(500);
	expect(watchdogPulseMs(40_000)).toBe(20);
	expect(watchdogPulseMs(2_000)).toBe(1);
});

test("a stall that starts just before a pulse may last WatchdogSec minus one pulse, at least twice the bounded spawn timeout", () => {
	const service = readFileSync(
		new URL("../../../../deployment/ceralive.service", import.meta.url),
		"utf8",
	);
	// One assignment only, so a later line cannot silently override it.
	const assignments = [...service.matchAll(/^WatchdogSec=(.*)$/gm)];
	expect(assignments).toHaveLength(1);
	const seconds = Number(/^(\d+)s$/.exec(assignments[0]?.[1] ?? "")?.[1]);
	expect(Number.isSafeInteger(seconds)).toBe(true);
	const usec = seconds * 1_000_000;
	// systemd kills when no pulse arrived for WatchdogSec. The loop can be blocked
	// right before a pulse was due, so the tolerated stall is WatchdogSec minus one
	// pulse interval. A bounded Bun.spawnSync probe may legitimately hold the loop
	// for DEFAULT_SPAWN_TIMEOUT_MS; that must never cost a live stream its sender.
	const tolerated = usec / 1000 - watchdogPulseMs(usec);
	expect(tolerated).toBeGreaterThanOrEqual(2 * DEFAULT_SPAWN_TIMEOUT_MS);
});
