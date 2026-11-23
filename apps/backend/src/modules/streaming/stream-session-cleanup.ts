import type { StreamSessionOrchestratorDeps } from "./stream-session-orchestrator.ts";

type Timer = ReturnType<typeof globalThis.setTimeout> | number;
type CleanupFlight = {
	readonly result: Promise<void>;
	/** True for an engine stop; false for a narrower decided effect. */
	readonly stops: boolean;
	/** Resolves once the submitted work itself has settled, after retirement. */
	settled: Promise<void>;
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
	 * stop requested meanwhile therefore never joins it: it waits for that
	 * effect to settle and then sends its own stop.
	 */
	const run = (
		generation: number,
		confirmUnknown = false,
		effect?: () => Promise<void>,
	): Promise<void> => {
		if (flight !== undefined) {
			if (flight.stops || effect !== undefined) return flight.result;
			// Wait for the effect's own work, not its caller's deadline, and give
			// up after one stop deadline so this stop's caller is never stranded.
			const settled = flight.settled;
			return new Promise<void>((resolve, reject) => {
				const timer = clock.schedule(
					() => reject(new Error("stop_timeout")),
					clock.deadlineMs,
				);
				void settled.then(() => {
					clock.cancel(timer);
					run(generation, confirmUnknown).then(resolve, reject);
				});
			});
		}
		const answer = Promise.withResolvers<void>();
		const current: CleanupFlight = {
			stops: effect === undefined,
			settled: Promise.resolve(),
			result: answer.promise,
			release: () => answer.resolve(),
			reject: answer.reject,
		};
		flight = current;
		const timer = clock.schedule(
			() => current.reject(new Error("stop_timeout")),
			clock.deadlineMs,
		);
		let raw: Promise<void>;
		try {
			raw =
				effect === undefined
					? deps.stopRuntime(generation, confirmUnknown)
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
			() => undefined,
			() => undefined,
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
