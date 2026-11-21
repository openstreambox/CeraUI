/**
 * The device's own "ready to go live" answer (backend `stream_readiness`),
 * replaced wholesale on each push. Kept apart from `subscriptions.svelte` so
 * consumers read it without depending on the whole subscription module.
 */
import type { StreamReadiness } from "@ceraui/rpc/schemas";

let streamReadinessState = $state.raw<StreamReadiness | undefined>(undefined);

export function getStreamReadiness(): StreamReadiness | undefined {
	return streamReadinessState;
}

export function setStreamReadiness(value: StreamReadiness | undefined): void {
	streamReadinessState = value;
}
