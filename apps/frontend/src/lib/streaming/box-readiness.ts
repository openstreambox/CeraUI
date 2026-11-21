/**
 * The device's own "ready to go live" answer (the backend `stream_readiness`
 * message), turned into the one line the Live bar shows before going live.
 *
 * The backend reads the same predicates its Start path refuses on (update,
 * recovery, modem change), resolves the source as Start does, and judges the
 * uplinks by their health checks rather than by "has an IP". The client-side
 * `deriveGoLiveReadiness` still decides whether Start is enabled; this line only
 * adds what the device knows and the client cannot see. Codes are the backend's
 * machine tokens; anything unknown falls back to a generic line.
 */
import type { StreamReadiness } from "@ceraui/rpc/schemas";

const CODE_KEYS: Readonly<Record<string, string>> = {
	update_in_progress: "live.goLive.box.busyUpdate",
	recovery_pending: "live.goLive.box.busyRecovery",
	mutation_in_progress: "live.goLive.box.busyModem",
	mutation_blocked: "live.goLive.box.busyModem",
	MODEM_TRANSITION_ACTIVE: "live.goLive.box.busyModem",
	START_IN_PROGRESS: "live.goLive.box.busyStart",
	no_source: "live.goLive.box.noSource",
	unknown_source: "live.goLive.box.noSource",
	source_lost: "live.goLive.box.noSource",
	source_unavailable: "live.goLive.box.noSource",
	source_taken_over: "live.goLive.box.noSource",
	pipeline_not_in_offered_set: "live.goLive.box.noSource",
	network_ingest_gateway_inactive: "live.goLive.box.noSource",
	audio_codec_unsupported_transport: "live.goLive.box.audioCodec",
	receiver_not_set: "live.goLive.box.noDestination",
	receiver_refused: "live.goLive.box.destinationFailed",
	receiver_unresolved: "live.goLive.box.destinationFailed",
	receiver_untested: "live.goLive.box.destinationUntested",
	no_uplink: "live.goLive.box.noUplink",
	no_uplink_passes: "live.goLive.box.noUplink",
	no_link_carrying: "live.goLive.box.noCarrying",
	carrying_unknown: "live.goLive.box.waiting",
};

export const BOX_NOT_READY_KEY = "live.goLive.box.notReady";

/** The i18n key for a readiness code; a code this build does not know gets the generic line. */
export function boxReadinessKey(code: string): string {
	return CODE_KEYS[code] ?? BOX_NOT_READY_KEY;
}

/**
 * The idle Live-bar line from the device, or `undefined` when the device has no
 * objection (ready, live, or no answer received yet). An `unknown` check never
 * produces a line here: it does not block, and the ready text stays honest.
 */
export function boxNotReadyKey(
	readiness: StreamReadiness | undefined,
): string | undefined {
	if (readiness === undefined || readiness.live || readiness.ready)
		return undefined;
	return boxReadinessKey(readiness.reason?.code ?? "");
}

/** Every key this module can return, for the catalog parity test. */
export const BOX_READINESS_KEYS: readonly string[] = [
	...new Set([...Object.values(CODE_KEYS), BOX_NOT_READY_KEY]),
];
