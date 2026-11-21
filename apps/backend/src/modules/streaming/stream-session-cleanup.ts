import type { StreamSessionOrchestratorDeps } from "./stream-session-orchestrator.ts";

type Timer = ReturnType<typeof globalThis.setTimeout> | number;
type CleanupFlight = {
	readonly result: Promise<void>;
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
		/**
		 * The submitted cleanup settled; `late` when the caller's deadline had
		 * already answered for it, so nobody saw the real outcome.
		 */
		readonly onSettled?: (late: boolean) => void;
	},
) {
	let flight: CleanupFlight | undefined;
	return {
		get pending() {
			return flight !== undefined;
		},
		run: (generation: number, confirmUnknown = false): Promise<void> => {
			if (flight !== undefined) return flight.result;
			const answer = Promise.withResolvers<void>();
			const current: CleanupFlight = {
				result: answer.promise,
				release: () => answer.resolve(),
				reject: answer.reject,
			};
			flight = current;
			let late = false;
			const timer = clock.schedule(() => {
				late = true;
				current.reject(new Error("stop_timeout"));
			}, clock.deadlineMs);
			let raw: Promise<void>;
			try {
				raw = deps.stopRuntime(generation, confirmUnknown);
			} catch (error) {
				raw = Promise.reject(error);
			}
			const retire = () => {
				clock.cancel(timer);
				if (flight === current) flight = undefined;
				clock.onSettled?.(late);
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
			return current.result;
		},
	};
}
