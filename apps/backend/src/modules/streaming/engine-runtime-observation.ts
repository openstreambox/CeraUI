import { AsyncLocalStorage } from "node:async_hooks";
import type { EngineRuntimeState } from "./streaming-backend.ts";

const observations = new AsyncLocalStorage<{
	readonly current: () => boolean;
	readonly uncertainStatus: (() => void) | undefined;
	readonly silent: (() => void) | undefined;
}>();

export function withRuntimeObservationOwner(
	current: () => boolean,
	query: () => Promise<EngineRuntimeState>,
	uncertainStatus?: () => void,
	silent?: () => void,
): Promise<EngineRuntimeState> {
	return observations.run({ current, uncertainStatus, silent }, query);
}

export function currentRuntimeObservationOwner(): () => boolean {
	return observations.getStore()?.current ?? (() => true);
}

export function currentRuntimeObservationUncertainty(): () => void {
	const observation = observations.getStore();
	return () => {
		if (observation?.current()) observation.uncertainStatus?.();
	};
}

export function classifyRuntimeState(
	state: unknown,
	streaming: unknown,
): EngineRuntimeState {
	if (state === "streaming" && streaming) return "streaming";
	if (state === "idle" && !streaming) return "idle";
	return "unknown";
}

/**
 * The engine was reachable, accepted the status subscription and said nothing
 * at all before the query gave up. The answer stays `unknown`: silence alone
 * is not idle. It only counts together with other evidence (the carrying line
 * an earlier backend left), because a running session reports its status.
 */
export function currentRuntimeObservationSilence(): () => void {
	const observation = observations.getStore();
	return () => {
		if (observation?.current()) observation.silent?.();
	};
}
