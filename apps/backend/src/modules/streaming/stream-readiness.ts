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
  Nothing here probes the network, spawns a process, takes a lease or writes
  state: the getter is read-only and cheap enough for a 2 s tick.

  Four checks, in this order (the first blocking one is the reason):

    lock      what Start refuses on before launching, in Start's own order:
              recovery replay pending, the modem journal's global stream hold,
              a session Start would call busy (`streamStartView`), the
              lifecycle interlock (forwarding, per-device modem leases, a
              modem transition or another start; `previewStreamingAdmission`
              shares its code with the acquiring path), then the update
              admission. A session Start would first reconcile, and an update
              phase whose admission needs a fresh probe, are `unknown`.
    source    the configured source resolves exactly as Start resolves it
              (`resolveSourceRouting`), its pipeline is in the offered set, a
              network-ingest pipeline has its gateway, and the audio codec fits
              the transport.
    receiver  the configured destination resolves through the same catalog
              and adapter as Start (`resolveStreamEndpoint`); an unknown relay
              id blocks. Reachability is claimed only from a relay test of
              that resolved endpoint: reached is `ok`, refused by the peer on
              every address blocks, anything inconclusive is `unknown`. While
              live the saved destination may already be the next one, so only
              a carrying link counts (`ok`), else `unknown`; nothing is stored.
    uplinks   idle: Start's own bond-entry collectors pick the interfaces
              (the same-subnet list for a receiver `isLocalIp` calls local,
              any of which will do; else the bond list, qualified by
              a fresh health record (`up`, or `degraded` only by passive
              congestion); a candidate without fresh health makes it
              `unknown`. Live: the sender's own link rows and their carrying
              verdicts; blocked only when every row positively carries nothing.

  While live, `lock` and `source` are `ok` by definition (the stream runs), and
  `ready` reads "the stream has a link that carries it"; it can be true with
  the carrying check still `unknown`.

  Not covered yet (see docs/STREAM-READINESS.md): HDMI signal presence for an
  onboard HDMI source, the sender-ownership census, and the receiver's own view
  of each link.
*/

import {
	AUDIO_CODEC_UNSUPPORTED_TRANSPORT,
	audioCodecAllowedForTransport,
	GATEWAY_INACTIVE_ERROR,
	RIST_TRANSPORT,
	STREAM_READINESS_EVENT,
	type StreamReadiness,
	type StreamReadinessCheck,
	type StreamReadinessCheckId,
	type UplinkHealthRecord,
} from "@ceraui/rpc/schemas";
import { isLocalIp } from "../../helpers/ip-addresses.ts";
import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { isMockGatewayActive } from "../../mocks/providers/streaming.ts";
import { getConfig } from "../config.ts";
import { getUplinksMessage } from "../network/uplink-health/state.ts";
import { getRelays } from "../remote/remote-relays.ts";
import { isDisruptiveActionPending } from "../system/disruptive-action-reservation.ts";
import { isUpdating } from "../system/software-updates.ts";
import { admitStreamStart } from "../system/update-orchestrator/admission.ts";
import {
	getOrchestratorDisruptionBusyReasons,
	getOrchestratorState,
} from "../system/update-orchestrator/runtime.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import { getSupportedTransports } from "./capabilities.ts";
import { validatePersistedPipeline } from "./config-migration.ts";
import { isGatewayActive } from "./gateway-availability.ts";
import {
	globalStreamHold,
	previewStreamingAdmission,
} from "./lifecycle-admission.ts";
import { buildLinkTelemetry } from "./link-telemetry.ts";
import { getPipelineList, searchPipelines } from "./pipelines.ts";
import { isRecoveryPending } from "./recovery-barrier.ts";
import {
	configuredSelectionAnchor,
	getSourcesMessage,
	resolveSourceRouting,
} from "./sources.ts";
import {
	genSrtlaBondEntries,
	genSrtlaBondEntriesForLocalIpAddress,
} from "./srtla.ts";
import { streamStartView } from "./stream-session-orchestrator.ts";
import { getIsStreaming } from "./streaming.ts";
import { resolveStreamEndpoint } from "./transport/resolve-endpoint.ts";

// ─── Codes ───────────────────────────────────────────────────────────────────
// Lock and source codes reuse the Start path's own tokens where one exists, so
// support reads one vocabulary in the log, the start error and this flag.

export const READINESS_UPDATE_IN_PROGRESS = "update_in_progress";
export const READINESS_UPDATE_UNCONFIRMED = "update_state_unconfirmed";
export const READINESS_RECOVERY_PENDING = "recovery_pending";
export const READINESS_START_IN_PROGRESS = "START_IN_PROGRESS";
export const READINESS_SESSION_RECONCILING = "session_reconciling";
export const READINESS_NO_SOURCE = "no_source";
export const READINESS_RECEIVER_NOT_SET = "receiver_not_set";
export const READINESS_RECEIVER_INVALID = "receiver_invalid";
export const READINESS_RECEIVER_UNTESTED = "receiver_untested";
export const READINESS_RECEIVER_REFUSED = "receiver_refused";
export const READINESS_RECEIVER_UNRESOLVED = "receiver_unresolved";
export const READINESS_NO_UPLINK = "no_uplink";
export const READINESS_NO_UPLINK_PASSES = "no_uplink_passes";
export const READINESS_UPLINK_UNCHECKED = "uplink_unchecked";
export const READINESS_NO_LINK_CARRYING = "no_link_carrying";
export const READINESS_CARRYING_UNKNOWN = "carrying_unknown";

/** A reachability result is evidence for this long, then it is forgotten. */
export const RECEIVER_EVIDENCE_TTL_MS = 30 * 60 * 1_000;
/** At most this many tested endpoints are remembered. */
export const RECEIVER_EVIDENCE_MAX = 16;
/** How often the flag is re-evaluated for the broadcast. */
export const READINESS_TICK_MS = 2_000;

// ─── Pure evaluation ─────────────────────────────────────────────────────────

export type ReceiverEvidence =
	| "reachable"
	| "refused"
	| "unresolved"
	| "inconclusive";

/** A check's own answer before the live/idle rules apply. */
export interface Verdict {
	readonly state: "ok" | "blocked" | "unknown";
	readonly code?: string;
}

export const OK: Verdict = { state: "ok" };

export interface UplinkCandidate {
	readonly iface: string;
	readonly health?: Pick<UplinkHealthRecord, "state" | "reason" | "staleAt">;
}

export interface SenderLink {
	readonly iface: string;
	/** The row's carrying verdict: true, false, or absent for no claim. */
	readonly carrying?: boolean;
}

export interface ReadinessInputs {
	readonly now: number;
	readonly live: boolean;
	readonly lock: Verdict;
	readonly source: Verdict;
	readonly receiver: {
		readonly configured: "yes" | "no" | "invalid";
		readonly evidence: ReceiverEvidence | undefined;
		/** The resolved receiver is a private or link-local IP literal. */
		readonly local: boolean;
	};
	/** Idle: the interfaces the bond would offer. */
	readonly candidates: readonly UplinkCandidate[];
	/** Live: the sender's link rows. */
	readonly senderLinks: readonly SenderLink[];
}

const CHECK_ORDER: readonly StreamReadinessCheckId[] = [
	"lock",
	"source",
	"receiver",
	"uplinks",
];

function as(
	id: StreamReadinessCheckId,
	verdict: Verdict,
): StreamReadinessCheck {
	return verdict.state === "ok"
		? { id, state: "ok" }
		: { id, state: verdict.state, code: verdict.code ?? "unspecified" };
}

function blocked(code: string): Verdict {
	return { state: "blocked", code };
}

function unknown(code: string): Verdict {
	return { state: "unknown", code };
}

/** An uplink health record that would carry a stream started now. */
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
	let usable: number;
	let total: number;
	let uplinks: Verdict;
	if (inputs.live) {
		total = inputs.senderLinks.length;
		usable = inputs.senderLinks.filter((l) => l.carrying === true).length;
		const silent = inputs.senderLinks.filter(
			(l) => l.carrying === false,
		).length;
		uplinks =
			usable > 0
				? OK
				: total > 0 && silent === total
					? blocked(READINESS_NO_LINK_CARRYING)
					: unknown(READINESS_CARRYING_UNKNOWN);
	} else {
		total = inputs.candidates.length;
		const fresh = inputs.candidates.filter(
			(c) => c.health !== undefined && c.health.staleAt > inputs.now,
		);
		usable = fresh.filter((c) => c.health && uplinkPasses(c.health)).length;
		// A LAN receiver needs a same-subnet interface, not the internet: the
		// candidates are then Start's local list and any of them will do.
		uplinks =
			total === 0
				? blocked(READINESS_NO_UPLINK)
				: inputs.receiver.local
					? OK
					: usable > 0
						? OK
						: fresh.length < total
							? unknown(READINESS_UPLINK_UNCHECKED)
							: blocked(READINESS_NO_UPLINK_PASSES);
		if (inputs.receiver.local) usable = total;
	}

	const lock = inputs.live ? OK : inputs.lock;
	const source = inputs.live ? OK : inputs.source;

	let receiver: Verdict;
	const r = inputs.receiver;
	// While live the saved destination may already be the next one; only the
	// running stream's own evidence counts.
	if (inputs.live)
		receiver = usable > 0 ? OK : unknown(READINESS_RECEIVER_UNTESTED);
	else if (r.configured === "no")
		receiver = blocked(READINESS_RECEIVER_NOT_SET);
	else if (r.configured === "invalid")
		receiver = blocked(READINESS_RECEIVER_INVALID);
	else if (r.evidence === "reachable") receiver = OK;
	else if (r.evidence === "refused")
		receiver = blocked(READINESS_RECEIVER_REFUSED);
	else if (r.evidence === "unresolved")
		receiver = unknown(READINESS_RECEIVER_UNRESOLVED);
	else receiver = unknown(READINESS_RECEIVER_UNTESTED);

	const checks = [
		as("lock", lock),
		as("source", source),
		as("receiver", receiver),
		as("uplinks", uplinks),
	];
	const firstBlocked = checks.find((c) => c.state === "blocked");
	const first = firstBlocked ?? checks.find((c) => c.state === "unknown");
	return {
		ready: firstBlocked === undefined,
		live: inputs.live,
		...(first?.code === undefined
			? {}
			: { reason: { check: first.id, code: first.code } }),
		checks: CHECK_ORDER.map(
			(id) => checks.find((c) => c.id === id) ?? { id, state: "ok" },
		),
		uplinks: { usable, total },
		at: inputs.now,
	};
}

// ─── Receiver evidence ───────────────────────────────────────────────────────
// One entry per tested endpoint (resolved host and port), so testing B never
// evicts A's result. Kept in memory only; keys are never broadcast or logged.
// A newer inconclusive test supersedes an older verdict for the same endpoint.

const receiverEvidence = new Map<
	string,
	{ readonly evidence: ReceiverEvidence; readonly at: number }
>();

export function endpointKey(addr: string, port: number): string | undefined {
	const host = addr.trim().toLowerCase();
	return host === "" ? undefined : `${host}:${port}`;
}

/** Record the outcome of a reachability test of one resolved endpoint. */
export function noteReceiverEvidence(
	key: string,
	evidence: ReceiverEvidence,
	now: number = Date.now(),
): void {
	receiverEvidence.delete(key);
	receiverEvidence.set(key, { evidence, at: now });
	while (receiverEvidence.size > RECEIVER_EVIDENCE_MAX) {
		const oldest = receiverEvidence.keys().next().value;
		if (oldest === undefined) break;
		receiverEvidence.delete(oldest);
	}
}

export function receiverEvidenceFor(
	key: string | undefined,
	now: number,
): ReceiverEvidence | undefined {
	if (key === undefined) return undefined;
	const entry = receiverEvidence.get(key);
	if (entry === undefined || now - entry.at > RECEIVER_EVIDENCE_TTL_MS)
		return undefined;
	return entry.evidence;
}

// ─── Live inputs ─────────────────────────────────────────────────────────────

export interface ReceiverTarget {
	readonly configured: "yes" | "no" | "invalid";
	readonly key?: string;
	/** Start would take the local-subnet path for this address. */
	readonly local: boolean;
	/** The resolved receiver address, for the local-subnet candidate list. */
	readonly address?: string;
}

export interface ReadinessDeps {
	now: () => number;
	/** Milliseconds that never step; stamps each evaluation for its age. */
	monotonic: () => number;
	live: () => boolean;
	lock: () => Verdict;
	source: () => Verdict;
	receiver: () => ReceiverTarget;
	candidates: (receiver: ReceiverTarget) => readonly UplinkCandidate[];
	senderLinks: () => readonly SenderLink[];
}

/** Start's refusals before launch, in Start's own order. */
export function currentStartLock(): Verdict {
	if (isRecoveryPending()) return blocked(READINESS_RECOVERY_PENDING);
	const hold = globalStreamHold();
	if (hold !== undefined) return blocked(hold.refusal);
	const session = streamStartView();
	if (session === "busy") return blocked(READINESS_START_IN_PROGRESS);
	if (session === "reconciling") return unknown(READINESS_SESSION_RECONCILING);
	const interlock = previewStreamingAdmission();
	if (interlock !== undefined) return blocked(interlock.refusal);
	const state = getOrchestratorState();
	if (
		isUpdating() ||
		isDisruptiveActionPending() ||
		!admitStreamStart(state).allowed ||
		getOrchestratorDisruptionBusyReasons().includes("pending-success")
	)
		return blocked(READINESS_UPDATE_IN_PROGRESS);
	// Start re-reads the package state and may probe the commit stage here.
	if (state.phase === "downloading")
		return unknown(READINESS_UPDATE_UNCONFIRMED);
	return OK;
}

/** The first reason the configured source would not start, as Start words it. */
export function currentSourceBlock(): Verdict {
	const config = getConfig();
	let pipeline = config.pipeline;
	if (config.source !== undefined) {
		const routed = resolveSourceRouting(
			config.source,
			getSourcesMessage().sources,
			config.last_seen_devices,
			configuredSelectionAnchor(config.source),
		);
		if (!routed.ok) return blocked(routed.error);
		pipeline = routed.pipeline;
	}
	if (pipeline === undefined) return blocked(READINESS_NO_SOURCE);
	const offered = validatePersistedPipeline(
		pipeline,
		Object.keys(getPipelineList()),
	);
	if (!offered.valid) return blocked(offered.error);
	const gateway = searchPipelines(pipeline)?.requires_gateway;
	if (gateway !== undefined) {
		const up = shouldUseMocks()
			? isMockGatewayActive(gateway)
			: isGatewayActive(gateway);
		if (!up) return blocked(GATEWAY_INACTIVE_ERROR);
	}
	if (
		config.acodec !== undefined &&
		!audioCodecAllowedForTransport(
			config.acodec,
			config.relay_protocol ?? "srtla",
		)
	)
		return blocked(AUDIO_CODEC_UNSUPPORTED_TRANSPORT);
	return OK;
}

/** The configured destination, resolved through Start's catalog and adapter. */
export function currentReceiver(): ReceiverTarget {
	const config = getConfig();
	if (!config.relay_server && !config.srtla_addr?.trim())
		return { configured: "no", local: false };
	try {
		const endpoint = resolveStreamEndpoint(
			{
				...(config.relay_server !== undefined
					? { relay_server: config.relay_server }
					: {}),
				...(config.relay_account !== undefined
					? { relay_account: config.relay_account }
					: {}),
				...(config.srtla_addr !== undefined
					? { srtla_addr: config.srtla_addr }
					: {}),
				...(config.srtla_port !== undefined
					? { srtla_port: config.srtla_port }
					: {}),
				...(config.srt_streamid !== undefined
					? { srt_streamid: config.srt_streamid }
					: {}),
				...(config.relay_streamid_override !== undefined
					? { relay_streamid_override: config.relay_streamid_override }
					: {}),
				...(config.relay_protocol !== undefined
					? { relay_protocol: config.relay_protocol }
					: {}),
			},
			getRelays(),
			config.relay_protocol,
			{ ristAvailable: getSupportedTransports().includes(RIST_TRANSPORT) },
		);
		const key = endpointKey(endpoint.srtlaAddr, endpoint.srtlaPort);
		if (key === undefined) return { configured: "invalid", local: false };
		return {
			configured: "yes",
			key,
			local: isLocalIp(endpoint.srtlaAddr),
			address: endpoint.srtlaAddr,
		};
	} catch {
		return { configured: "invalid", local: false };
	}
}

/**
 * The interfaces Start would put in the bond, with their health record if any.
 * Start's own collectors decide membership (the same-subnet list for a LAN
 * receiver, else the bond list), so identity settlement, duplicate-IP mapping
 * and the bond toggle apply exactly as at launch. Nothing is published.
 */
export function currentCandidates(
	receiver: ReceiverTarget,
): readonly UplinkCandidate[] {
	const health = new Map(getUplinksMessage().map((r) => [r.iface, r]));
	const entries =
		receiver.local && receiver.address !== undefined
			? genSrtlaBondEntriesForLocalIpAddress(receiver.address)
			: genSrtlaBondEntries();
	return [...new Set(entries.map((entry) => entry.iface))].map((iface) => {
		const record = health.get(iface);
		return record === undefined ? { iface } : { iface, health: record };
	});
}

/** The sender's own link rows; empty when it reports nothing. */
export function currentSenderLinks(): readonly SenderLink[] {
	return (buildLinkTelemetry()?.links ?? []).map((row) =>
		row.stale || row.carrying === undefined
			? { iface: row.iface }
			: { iface: row.iface, carrying: row.carrying },
	);
}

const defaultDeps: ReadinessDeps = {
	now: Date.now,
	monotonic: () => performance.now(),
	live: getIsStreaming,
	lock: currentStartLock,
	source: currentSourceBlock,
	receiver: currentReceiver,
	candidates: currentCandidates,
	senderLinks: currentSenderLinks,
};

let deps: ReadinessDeps = defaultDeps;

export function setReadinessDepsForTest(next: Partial<ReadinessDeps> | null) {
	deps = next === null ? defaultDeps : { ...defaultDeps, ...next };
}

/** Read-only: evaluates the current answer and changes nothing. */
export function getStreamReadiness(): StreamReadiness {
	const now = deps.now();
	const live = deps.live();
	// While live the saved destination is not judged, so it is not read either.
	const receiver: ReceiverTarget = live
		? { configured: "yes", local: false }
		: deps.receiver();
	return evaluateStreamReadiness({
		now,
		live,
		lock: live ? OK : deps.lock(),
		source: live ? OK : deps.source(),
		receiver: {
			configured: receiver.configured,
			evidence: receiverEvidenceFor(receiver.key, now),
			local: receiver.local,
		},
		candidates: live ? [] : deps.candidates(receiver),
		senderLinks: live ? deps.senderLinks() : [],
	});
}

// ─── Broadcast ───────────────────────────────────────────────────────────────

/** The last answer and the monotonic time its evaluation started. */
export interface StreamReadinessSample {
	readonly readiness: StreamReadiness;
	readonly evaluatedAt: number;
}

let lastSignature: string | undefined;
let latest: StreamReadinessSample | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

function signature(readiness: StreamReadiness): string {
	const { at: _at, ...rest } = readiness;
	return JSON.stringify(rest);
}

/** Evaluate and push to clients only when the answer changed. */
export function broadcastStreamReadinessIfChanged(): StreamReadiness | null {
	// Stamped before evaluating: an evaluation that throws leaves the last
	// answer with its old stamp, so it ages out whatever the wall clock does.
	const evaluatedAt = deps.monotonic();
	const readiness = getStreamReadiness();
	latest = { readiness, evaluatedAt };
	const next = signature(readiness);
	if (next === lastSignature) return null;
	lastSignature = next;
	broadcastMsg(STREAM_READINESS_EVENT, readiness);
	return readiness;
}

/** The answer from the last tick, without evaluating again; for the status screen snapshot. */
export function latestStreamReadiness(): StreamReadinessSample | undefined {
	return latest;
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
	latest = undefined;
	receiverEvidence.clear();
	deps = defaultDeps;
}
