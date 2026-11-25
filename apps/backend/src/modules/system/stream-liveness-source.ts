import type { LifecycleState } from "@ceraui/rpc/schemas";
import { getStreamLifecycleState } from "../streaming/stream-lifecycle-status.ts";
import { streamLiveness } from "../streaming/stream-liveness.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import { carryingTracker, getCarryingLiveness } from "./carrying.ts";
import type { StreamLiveness } from "./disruptive-action-gate.ts";
import { isStreamReconciliationCompleted } from "./stream-reconciliation-latch.ts";

export type StreamLivenessEvidence = {
	readonly carrying?: StreamLiveness;
	readonly reconciled: boolean;
	readonly live: boolean;
	readonly lifecycle: LifecycleState;
	readonly sentinel: "present" | "absent" | "unknown";
};

// The owner's published lifecycle can withhold leaf idle, never grant it.
export function deriveStreamLiveness(
	evidence: StreamLivenessEvidence,
): StreamLiveness {
	if (evidence.carrying === "streaming") return "streaming";
	if (evidence.live) return "streaming";
	if (evidence.carrying === "unknown") return "unknown";
	const confirmedIdle = evidence.reconciled && evidence.lifecycle === "idle";
	return confirmedIdle && evidence.sentinel === "absent" ? "idle" : "unknown";
}

let testSource: (() => StreamLiveness) | undefined;

function sessionEvidence(): Omit<StreamLivenessEvidence, "carrying"> {
	const leaf = streamLiveness();
	return {
		reconciled: isStreamReconciliationCompleted(),
		live: getIsStreaming() || leaf === "streaming",
		lifecycle: getStreamLifecycleState(),
		sentinel: leaf === "idle" ? "absent" : "unknown",
	};
}

export function getStreamLiveness(
	options: { readonly waiveCarryingStartupHold?: boolean } = {},
): StreamLiveness {
	if (testSource) return testSource();
	return deriveStreamLiveness({
		carrying: options.waiveCarryingStartupHold
			? carryingTracker.read(performance.now(), true)
			: getCarryingLiveness(),
		...sessionEvidence(),
	});
}

/** The box's own stream session alone, without client carrying evidence: says
 * which part of an unknown answer a Stop could settle. */
export function getOwnStreamLiveness(): StreamLiveness {
	if (testSource) return testSource();
	return deriveStreamLiveness(sessionEvidence());
}

export function isStreamConfirmedIdle(): boolean {
	return getStreamLiveness() === "idle";
}

export function setStreamLivenessSourceForTest(
	source: (() => StreamLiveness) | null,
): void {
	testSource = source ?? undefined;
}
