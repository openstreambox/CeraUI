/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
  IS THE BOX READY TO GO LIVE?

  One yes/no plus a reason, built only from answers the backend already has.
  Nothing here probes the network, touches a device or takes a lease; it reads
  the same predicates the Start path consults, in the same order, so the flag
  cannot say "ready" for a reason Start would refuse on.

  Four checks, in this order (the first blocking one is the reason):

    lock      what Start refuses on before it launches anything: an update
              that would refuse a stream, recovery replay still pending, a
              modem change in flight (the journal's global stream hold), a
              modem re-enumeration or another start holding the lifecycle
              interlock.
    source    the configured source resolves exactly as Start resolves it
              (`resolveSourceRouting`), its pipeline is in the offered set, a
              network-ingest pipeline has its gateway, and the audio codec fits
              the transport.
    receiver  a destination is configured. Reachability is only claimed from
              evidence: the last relay test of this destination, or stream data
              leaving on a link while live (the sender sends stream data only
              after the receiver's handshake). Without evidence it is
              `unknown`, which is reported but does not block.
    uplinks   idle: at least one uplink passes its health check (`up`, or
              `degraded` only by passive congestion). Live: the per-link
              `linkCarryingState`; blocked only when every link positively
              carries nothing, `unknown` when there is no claim either way.

  While live, `lock` and `source` are `ok` by definition (the stream runs), and
  `ready` reads "the stream has a link that carries it".

  Not covered yet (see the design note): HDMI signal presence for an onboard
  HDMI source (an async sysfs read Start does at launch), the sender-ownership
  census (a /proc scan), and the receiver's own view of each link.
*/

import {
	AUDIO_CODEC_UNSUPPORTED_TRANSPORT,
	audioCodecAllowedForTransport,
	GATEWAY_INACTIVE_ERROR,
	STREAM_READINESS_EVENT,
	type StreamReadiness,
	type StreamReadinessCheck,
	type StreamReadinessCheckId,
	type UplinkHealthRecord,
} from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { isMockGatewayActive } from "../../mocks/providers/streaming.ts";
import { getConfig } from "../config.ts";
import { getUplinksMessage } from "../network/uplink-health/state.ts";
import { isDisruptiveActionPending } from "../system/disruptive-action-reservation.ts";
import { isUpdating } from "../system/software-updates.ts";
import { admitStreamStart } from "../system/update-orchestrator/admission.ts";
import { getOrchestratorState } from "../system/update-orchestrator/runtime.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import { validatePersistedPipeline } from "./config-migration.ts";
import { isGatewayActive } from "./gateway-availability.ts";
import {
	currentLifecycleHolder,
	globalStreamHold,
} from "./lifecycle-admission.ts";
import type { LinkCarryingState } from "./link-progress.ts";
import { linkCarryingState } from "./link-telemetry.ts";
import { getPipelineList, searchPipelines } from "./pipelines.ts";
import { isRecoveryPending } from "./recovery-barrier.ts";
import {
	configuredSelectionAnchor,
	getSourcesMessage,
	resolveSourceRouting,
} from "./sources.ts";
import { getIsStreaming } from "./streaming.ts";

// ─── Codes ───────────────────────────────────────────────────────────────────
// Lock and source codes reuse the Start path's own tokens where one exists, so
// support reads one vocabulary in the log, the start error and this flag.

export const READINESS_UPDATE_IN_PROGRESS = "update_in_progress";
export const READINESS_RECOVERY_PENDING = "recovery_pending";
export const READINESS_MODEM_TRANSITION = "MODEM_TRANSITION_ACTIVE";
export const READINESS_START_IN_PROGRESS = "START_IN_PROGRESS";
export const READINESS_NO_SOURCE = "no_source";
export const READINESS_RECEIVER_NOT_SET = "receiver_not_set";
export const READINESS_RECEIVER_UNTESTED = "receiver_untested";
export const READINESS_RECEIVER_REFUSED = "receiver_refused";
export const READINESS_RECEIVER_UNRESOLVED = "receiver_unresolved";
export const READINESS_NO_UPLINK = "no_uplink";
export const READINESS_NO_UPLINK_PASSES = "no_uplink_passes";
export const READINESS_NO_LINK_CARRYING = "no_link_carrying";
export const READINESS_CARRYING_UNKNOWN = "carrying_unknown";

/** A reachability result is evidence for this long, then it is forgotten. */
export const RECEIVER_EVIDENCE_TTL_MS = 30 * 60 * 1_000;
/** How often the flag is re-evaluated for the broadcast. */
export const READINESS_TICK_MS = 2_000;

// ─── Pure evaluation ─────────────────────────────────────────────────────────

export type ReceiverEvidence = "reachable" | "refused" | "unresolved";

export interface ReadinessInputs {
	readonly now: number;
	readonly live: boolean;
	/** The first Start refusal that applies right now, if any. */
	readonly lock: string | undefined;
	/** Why the configured source would not start, if it would not. */
	readonly source: string | undefined;
	readonly receiver: {
		readonly configured: boolean;
		readonly evidence: ReceiverEvidence | undefined;
	};
	readonly uplinks: readonly Pick<
		UplinkHealthRecord,
		"iface" | "state" | "reason"
	>[];
	readonly carrying: (iface: string) => LinkCarryingState;
}

const CHECK_ORDER: readonly StreamReadinessCheckId[] = [
	"lock",
	"source",
	"receiver",
	"uplinks",
];

function ok(id: StreamReadinessCheckId): StreamReadinessCheck {
	return { id, state: "ok" };
}

function check(
	id: StreamReadinessCheckId,
	state: "blocked" | "unknown",
	code: string,
): StreamReadinessCheck {
	return { id, state, code };
}

/** An uplink that would carry a stream started now. */
export function uplinkPasses(
	record: Pick<UplinkHealthRecord, "state" | "reason">,
): boolean {
	return (
		record.state === "up" ||
		(record.state === "degraded" && record.reason === "passive_congestion")
	);
}

export function evaluateStreamReadiness(
	inputs: ReadinessInputs,
): StreamReadiness {
	const total = inputs.uplinks.length;
	let usable: number;
	let uplinks: StreamReadinessCheck;
	if (inputs.live) {
		const states = inputs.uplinks.map((u) => inputs.carrying(u.iface));
		usable = states.filter((s) => s === "carrying").length;
		const silent = states.filter((s) => s === "not_carrying").length;
		uplinks =
			usable > 0
				? ok("uplinks")
				: total > 0 && silent === total
					? check("uplinks", "blocked", READINESS_NO_LINK_CARRYING)
					: check("uplinks", "unknown", READINESS_CARRYING_UNKNOWN);
	} else {
		usable = inputs.uplinks.filter(uplinkPasses).length;
		uplinks =
			usable > 0
				? ok("uplinks")
				: check(
						"uplinks",
						"blocked",
						total === 0 ? READINESS_NO_UPLINK : READINESS_NO_UPLINK_PASSES,
					);
	}

	const lock =
		inputs.live || inputs.lock === undefined
			? ok("lock")
			: check("lock", "blocked", inputs.lock);
	const source =
		inputs.live || inputs.source === undefined
			? ok("source")
			: check("source", "blocked", inputs.source);

	let receiver: StreamReadinessCheck;
	if (!inputs.receiver.configured)
		receiver = check("receiver", "blocked", READINESS_RECEIVER_NOT_SET);
	else if (inputs.live && usable > 0) receiver = ok("receiver");
	else if (inputs.receiver.evidence === "reachable") receiver = ok("receiver");
	else if (inputs.receiver.evidence === "refused")
		receiver = check("receiver", "blocked", READINESS_RECEIVER_REFUSED);
	else if (inputs.receiver.evidence === "unresolved")
		receiver = check("receiver", "blocked", READINESS_RECEIVER_UNRESOLVED);
	else receiver = check("receiver", "unknown", READINESS_RECEIVER_UNTESTED);

	const checks = [lock, source, receiver, uplinks];
	const blocked = checks.find((c) => c.state === "blocked");
	const first = blocked ?? checks.find((c) => c.state === "unknown");
	return {
		ready: blocked === undefined,
		live: inputs.live,
		...(first?.code === undefined
			? {}
			: { reason: { check: first.id, code: first.code } }),
		checks: CHECK_ORDER.map((id) => checks.find((c) => c.id === id) ?? ok(id)),
		uplinks: { usable, total },
		at: inputs.now,
	};
}

// ─── Receiver evidence ───────────────────────────────────────────────────────
// Remembered per destination so a test of one receiver never vouches for
// another. Kept in memory only; the key is never broadcast or logged.

interface ReceiverRecord {
	readonly key: string;
	readonly evidence: ReceiverEvidence;
	readonly at: number;
}

let receiverRecord: ReceiverRecord | undefined;

export function receiverKey(config: {
	relay_server?: string | undefined;
	srtla_addr?: string | undefined;
	srtla_port?: number | undefined;
}): string | undefined {
	if (config.relay_server) return `relay:${config.relay_server}`;
	const addr = config.srtla_addr?.trim();
	if (addr && config.srtla_port !== undefined)
		return `addr:${addr.toLowerCase()}:${config.srtla_port}`;
	return undefined;
}

/** Record the outcome of a reachability test of `key`. */
export function noteReceiverEvidence(
	key: string,
	evidence: ReceiverEvidence,
	now: number = Date.now(),
): void {
	receiverRecord = { key, evidence, at: now };
}

export function receiverEvidenceFor(
	key: string | undefined,
	now: number,
): ReceiverEvidence | undefined {
	if (key === undefined || receiverRecord === undefined) return undefined;
	if (receiverRecord.key !== key) return undefined;
	if (now - receiverRecord.at > RECEIVER_EVIDENCE_TTL_MS) return undefined;
	return receiverRecord.evidence;
}

// ─── Live inputs ─────────────────────────────────────────────────────────────

export interface ReadinessDeps {
	now: () => number;
	live: () => boolean;
	lock: () => string | undefined;
	source: () => string | undefined;
	receiverKey: () => string | undefined;
	uplinks: () => readonly UplinkHealthRecord[];
	carrying: (iface: string) => LinkCarryingState;
}

/** Start's refusals before launch, in Start's own order. */
export function currentStartLock(): string | undefined {
	if (
		isUpdating() ||
		isDisruptiveActionPending() ||
		!admitStreamStart(getOrchestratorState()).allowed
	)
		return READINESS_UPDATE_IN_PROGRESS;
	if (isRecoveryPending()) return READINESS_RECOVERY_PENDING;
	const hold = globalStreamHold();
	if (hold !== undefined) return hold.refusal;
	const holder = currentLifecycleHolder();
	if (holder === "modem-transition") return READINESS_MODEM_TRANSITION;
	if (holder === "streaming") return READINESS_START_IN_PROGRESS;
	return undefined;
}

/** The first reason the configured source would not start, as Start words it. */
export function currentSourceBlock(): string | undefined {
	const config = getConfig();
	let pipeline = config.pipeline;
	if (config.source !== undefined) {
		const routed = resolveSourceRouting(
			config.source,
			getSourcesMessage().sources,
			config.last_seen_devices,
			configuredSelectionAnchor(config.source),
		);
		if (!routed.ok) return routed.error;
		pipeline = routed.pipeline;
	}
	if (pipeline === undefined) return READINESS_NO_SOURCE;
	const offered = validatePersistedPipeline(
		pipeline,
		Object.keys(getPipelineList()),
	);
	if (!offered.valid) return offered.error;
	const gateway = searchPipelines(pipeline)?.requires_gateway;
	if (gateway !== undefined) {
		const up = shouldUseMocks()
			? isMockGatewayActive(gateway)
			: isGatewayActive(gateway);
		if (!up) return GATEWAY_INACTIVE_ERROR;
	}
	if (
		config.acodec !== undefined &&
		!audioCodecAllowedForTransport(
			config.acodec,
			config.relay_protocol ?? "srtla",
		)
	)
		return AUDIO_CODEC_UNSUPPORTED_TRANSPORT;
	return undefined;
}

const defaultDeps: ReadinessDeps = {
	now: Date.now,
	live: getIsStreaming,
	lock: currentStartLock,
	source: currentSourceBlock,
	receiverKey: () => receiverKey(getConfig()),
	uplinks: getUplinksMessage,
	carrying: linkCarryingState,
};

let deps: ReadinessDeps = defaultDeps;

export function setReadinessDepsForTest(next: Partial<ReadinessDeps> | null) {
	deps = next === null ? defaultDeps : { ...defaultDeps, ...next };
}

export function getStreamReadiness(): StreamReadiness {
	const now = deps.now();
	const live = deps.live();
	const key = deps.receiverKey();
	const result = evaluateStreamReadiness({
		now,
		live,
		lock: deps.lock(),
		source: deps.source(),
		receiver: {
			configured: key !== undefined,
			evidence: receiverEvidenceFor(key, now),
		},
		uplinks: deps.uplinks(),
		carrying: deps.carrying,
	});
	// Stream data on a link means the receiver completed the handshake, which is
	// the best reachability evidence there is; keep it for after the stream.
	if (live && key !== undefined && result.uplinks.usable > 0)
		noteReceiverEvidence(key, "reachable", now);
	return result;
}

// ─── Broadcast ───────────────────────────────────────────────────────────────

let lastSignature: string | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

function signature(readiness: StreamReadiness): string {
	const { at: _at, ...rest } = readiness;
	return JSON.stringify(rest);
}

/** Evaluate and push to clients only when the answer changed. */
export function broadcastStreamReadinessIfChanged(): StreamReadiness | null {
	const readiness = getStreamReadiness();
	const next = signature(readiness);
	if (next === lastSignature) return null;
	lastSignature = next;
	broadcastMsg(STREAM_READINESS_EVENT, readiness);
	return readiness;
}

export function initStreamReadiness(): void {
	if (timer !== undefined) return;
	timer = setInterval(() => {
		try {
			broadcastStreamReadinessIfChanged();
		} catch (error) {
			logger.warn("stream readiness evaluation failed", { error });
		}
	}, READINESS_TICK_MS);
	timer.unref?.();
}

export function resetStreamReadinessForTest(): void {
	if (timer !== undefined) clearInterval(timer);
	timer = undefined;
	lastSignature = undefined;
	receiverRecord = undefined;
	deps = defaultDeps;
}
