import type { StreamSessionOrchestratorDeps } from "./stream-session-orchestrator.ts";

type Timer = ReturnType<typeof globalThis.setTimeout> | number;
type CleanupFlight = {
	readonly result: Promise<void>;
	/** True for an engine stop; false for a narrower decided effect. */
	readonly stops: boolean;
	/** Resolves once the submitted work has settled (after retirement): true
	 * when it ended in a Stop the engine acknowledged. */
	settled: Promise<boolean>;
	readonly release: () => void;
	readonly reject: (error: unknown) => void;
};

/** A deadline ends the caller's wait, not the ownership of submitted cleanup. */
export function createSessionCleanup(
	deps: StreamSessionOrchestratorDeps,
	clock: {
		readonly schedule: (callback: () => void, delayMs: number) => Timer;
		readonly cancel: (timer: Timer) => void;
		readonly deadlineMs: number;
	},
) {
	let flight: CleanupFlight | undefined;
	/**
	 * `effect` replaces the engine stop for a decided, narrower one (settling an
	 * earlier process's session), which may end without stopping anything. A
	 * stop requested meanwhile never joins it: it waits for that effect's own
	 * work, then sends its own stop, unless the effect ended in a Stop the engine
	 * acknowledged. If this caller's deadline passes first, it reports
	 * `stop_timeout` and sends nothing, then or later.
	 */
	const run = (
		generation: number,
		confirmUnknown = false,
		effect?: () => Promise<boolean | undefined>,
	): Promise<void> => {
		if (flight !== undefined) {
			if (flight.stops || effect !== undefined) return flight.result;
			const settled = flight.settled;
			return new Promise<void>((resolve, reject) => {
				let expired = false;
				const timer = clock.schedule(() => {
					expired = true;
					reject(new Error("stop_timeout"));
				}, clock.deadlineMs);
				void settled.then((acknowledged) => {
					if (expired) return;
					clock.cancel(timer);
					if (acknowledged) resolve();
					else run(generation, confirmUnknown).then(resolve, reject);
				});
			});
		}
		const answer = Promise.withResolvers<void>();
		const abort = new AbortController();
		const current: CleanupFlight = {
			stops: effect === undefined,
			settled: Promise.resolve(false),
			result: answer.promise,
			release: () => answer.resolve(),
			reject: answer.reject,
		};
		flight = current;
		const timer = clock.schedule(() => {
			abort.abort();
			current.reject(new Error("stop_timeout"));
		}, clock.deadlineMs);
		let raw: Promise<boolean | undefined>;
		try {
			raw =
				effect === undefined
					? deps
							.stopRuntime(generation, confirmUnknown, abort.signal)
							.then(() => true)
					: effect();
		} catch (error) {
			raw = Promise.reject(error);
		}
		const retire = () => {
			clock.cancel(timer);
			if (flight === current) flight = undefined;
		};
		void raw.then(
			() => {
				retire();
				current.release();
			},
			(error: unknown) => {
				retire();
				current.reject(error);
			},
		);
		// Registered after the reaction above, so the flight is retired first.
		current.settled = raw.then(
			(acknowledged) => acknowledged === true,
			() => false,
		);
		return current.result;
	};
	return {
		get pending() {
			return flight !== undefined;
		},
		run,
	};
}
