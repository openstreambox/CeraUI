import { dlopen, ptr } from "bun:ffi";

function notifyWatchdog(): void {
	const library = dlopen("libsystemd.so.0", {
		sd_notify: { args: ["i32", "cstring"], returns: "i32" },
	});
	try {
		library.symbols.sd_notify(0, ptr(Buffer.from("WATCHDOG=1\0")));
	} finally {
		library.close();
	}
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
	return schedule(notify, Math.min(Math.floor(usec / 2000), 2147483647));
}
