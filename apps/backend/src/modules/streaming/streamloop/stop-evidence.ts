import { queryEngineRuntimeStreaming } from "../engine-runtime-state.ts";
import type { StreamingBackend } from "../streaming-backend.ts";
import { getStreamingBackend } from "../streaming-engine.ts";

export type StopEvidenceOutcome =
	| { readonly ok: true }
	| { readonly ok: false; readonly error: unknown };

export function confirmUnownedEngineStop(
	finish: (outcome: StopEvidenceOutcome) => Promise<void>,
	deps: {
		readonly query: typeof queryEngineRuntimeStreaming;
		readonly stop: StreamingBackend["stop"];
		readonly confirmStop?: StreamingBackend["confirmStop"];
	} = {
		query: queryEngineRuntimeStreaming,
		stop: (...args) => getStreamingBackend().stop(...args),
		confirmStop: () => {
			const backend = getStreamingBackend();
			return backend.confirmStop === undefined
				? Promise.reject(new Error("engine_stop_unknown"))
				: backend.confirmStop();
		},
	},
	confirmUnknown = false,
	signal?: AbortSignal,
): void {
	const fail = (error: unknown) => {
		void finish({ ok: false, error });
	};
	// An operator's confirmation always ends in its own acknowledged Stop: an
	// idle answer is not that acknowledgement. Nothing is sent once the caller's
	// deadline has passed.
	const confirm = () => {
		if (deps.confirmStop === undefined) fail(new Error("engine_stop_unknown"));
		else void deps.confirmStop().then(() => finish({ ok: true }), fail);
	};
	void deps.query().then((runtime) => {
		if (signal?.aborted) {
			fail(new Error("stop_timeout"));
			return;
		}
		switch (runtime) {
			case "idle":
				if (confirmUnknown) confirm();
				else void finish({ ok: true });
				break;
			case "streaming":
				if (
					!deps.stop(() => {
						void finish({ ok: true });
					}, fail)
				)
					fail(new Error("engine_stop_unknown"));
				break;
			case "unknown":
				if (!confirmUnknown) fail(new Error("engine_stop_unknown"));
				else confirm();
				break;
		}
	}, fail);
}
