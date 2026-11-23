import { AsyncLocalStorage } from "node:async_hooks";
import type { EngineRuntimeState } from "./streaming-backend.ts";

/**
 * What a silent engine answered when asked for its session: an `empty_snapshot`
 * is a valid session list with nothing in it; `no_report` is an engine that
 * could not report one (an RPC error or unreadable reply) on a schema whose
 * statuses the binding reads in full.
 */
export type SilenceEvidence = "empty_snapshot" | "no_report";

const observations = new AsyncLocalStorage<{
	readonly current: () => boolean;
	readonly uncertainStatus: (() => void) | undefined;
	readonly silent: ((evidence?: SilenceEvidence) => void) | undefined;
}>();

export function withRuntimeObservationOwner(
	current: () => boolean,
	query: () => Promise<EngineRuntimeState>,
	uncertainStatus?: () => void,
	silent?: (evidence?: SilenceEvidence) => void,
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
export function currentRuntimeObservationSilence(): (
	evidence?: SilenceEvidence,
) => void {
	const observation = observations.getStore();
	return (evidence) => {
		if (observation?.current()) observation.silent?.(evidence);
	};
}
