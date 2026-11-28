import { dlopen, ptr } from "bun:ffi";

/** Longest gap between pulses on a healthy loop. */
export const WATCHDOG_PULSE_MAX_MS = 1000;

function loadNotify() {
	return dlopen("libsystemd.so.0", {
		sd_notify: { args: ["i32", "cstring"], returns: "i32" },
	});
}
let library: ReturnType<typeof loadNotify> | undefined;
const pulse = Buffer.from("WATCHDOG=1\0");

function notifyWatchdog(): void {
	library ??= loadNotify();
	library.symbols.sd_notify(0, ptr(pulse));
}

/** Pulse interval for a WATCHDOG_USEC value. A short interval leaves almost the
 * whole WatchdogSec for a stall that starts just before a pulse was due; at half
 * the interval that budget would be only half of WatchdogSec. */
export function watchdogPulseMs(usec: number): number {
	return Math.max(
		1,
		Math.min(Math.floor(usec / 2000), WATCHDOG_PULSE_MAX_MS, 2147483647),
	);
}

/** A main-loop timer stops pulsing if the owner hangs. No independent helper. */
export function startServiceWatchdog(
	options: {
		env?: Record<string, string | undefined>;
		notify?: () => void;
		schedule?: (tick: () => void, ms: number) => () => void;
	} = {},
): () => void {
	const env = options.env ?? process.env;
	const usec = Number(env.WATCHDOG_USEC);
	if (
		env.NODE_ENV !== "production" ||
		!env.NOTIFY_SOCKET ||
		!Number.isSafeInteger(usec) ||
		usec < 2000 ||
		(env.WATCHDOG_PID !== undefined && env.WATCHDOG_PID !== String(process.pid))
	)
		return () => {
			/* No watchdog configured for this process. */
		};
	const notify = options.notify ?? notifyWatchdog;
	const schedule =
		options.schedule ??
		((tick, ms) => {
			const timer = setInterval(tick, ms);
			timer.unref();
			return () => clearInterval(timer);
		});
	notify();
	return schedule(notify, watchdogPulseMs(usec));
}
