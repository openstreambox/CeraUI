/**
 * Whether the Live view shows the unconfirmed-state band and its Stop. The
 * band and the Start bar read the same answer, so the bar never says "Ready
 * to go live" while the band asks the operator to stop: in `reconciling` and
 * `stop_failed`, and through the `stopping` that follows the band's own Stop
 * until the device settles it.
 */

import type { LifecycleState } from "@ceraui/rpc/schemas";
import { getOperationPhase } from "$lib/rpc/async-operation.svelte";
import {
	getStreamingAttemptGeneration,
	type StreamingOptimismState,
} from "$lib/rpc/streaming-optimism.svelte";
import {
	showUnconfirmedStreamStop,
	UNCONFIRMED_STOP_OPERATION,
} from "./unconfirmed-stream";
import {
	operatorStopUnresolved,
	startRecoveryUnknown,
} from "./unresolved-stream-actions.svelte";

export function unconfirmedStreamBandShown(facts: {
	readonly lifecycle: LifecycleState | undefined;
	readonly isStreaming: boolean;
	readonly optimismState: StreamingOptimismState;
}): boolean {
	return showUnconfirmedStreamStop({
		...facts,
		stopPending: getOperationPhase(UNCONFIRMED_STOP_OPERATION) === "pending",
		stopUnresolved: operatorStopUnresolved(),
		startRecoveryUnknown: startRecoveryUnknown(getStreamingAttemptGeneration()),
	});
}
