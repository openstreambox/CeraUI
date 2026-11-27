/*
    CeraUI - web UI for the CERALIVE project
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

// User-driven stream session control: the WebSocket-triggered `start` (validate
// config, refresh the srtla link list, launch) and the public `stop`
// orchestration that brings the engine down first, then the rest.

import type WebSocket from "ws";
import { logger } from "../../../helpers/logger.ts";
import { onNetworkInterfaceSourcesChange } from "../../network/network-interfaces.ts";
import { onUsbNetScanCommitted } from "../../network/router-cellular-scan.ts";
import { isUpdating } from "../../system/software-updates.ts";
import { sendStatus } from "../../ui/status.ts";
import { getSocketSenderId } from "../../ui/websocket-server.ts";
import { clearAsrcProbeReject, isAsrcProbeRejectResolved } from "../audio.ts";
import { setPendingAudioFollowAsrc } from "../auto-audio.ts";
import { clearBindMapReport } from "../bind-map-disposition.ts";
import { announceBindMapReport } from "../bind-map-notification.ts";
import { autoRestart, connectionRestartDeps } from "../connection-restart.ts";
import {
	CARRY_WINDOW_MS,
	type CarryVerdict,
	createCarryTracker,
} from "../link-carrying.ts";
import { resolveLinkLabel } from "../link-label.ts";
import { buildLinkTelemetry, stopLinkTelemetry } from "../link-telemetry.ts";
import type { Pipeline } from "../pipelines.ts";
import { recentRelaySession } from "../recent-relay-session.ts";
import {
	createObservationFailureLog,
	createReloadQueue,
	SENDER_RELOAD_POLL_MS,
	SENDER_RELOAD_WINDOW_MS,
	SENDER_STOP_HOLD_MS,
	verifySenderReload,
	waitForReload,
} from "../sender-reload.ts";
import { senderSocketSources } from "../sender-sockets.ts";
import {
	getLastPublishedBond,
	observeSenderReload,
	restartSrtla,
} from "../srtla.ts";
import { staleLinkNotice, staleSourceResponse } from "../stale-link-notice.ts";
import { acceptStartAudio } from "../start-audio.ts";
import {
	classifyStartFailure,
	StreamStartFailure,
} from "../start-failure-taxonomy.ts";
import {
	assertStreamLaunchOwnership,
	currentStreamLaunchOwner,
} from "../stream-launch-ownership.ts";
import {
	type ConfigParameters,
	getIsStreaming,
	startError,
	updateConfig,
	updateStatus,
} from "../streaming.ts";
import { getStreamingBackend } from "../streaming-engine.ts";
import { srtlaSendExec } from "./exec-paths.ts";
import { getStreamingProcesses, stopProcessAndWait } from "./process-runner.ts";
import { reportSessionInvariant } from "./resource-invariant.ts";
import { prepareSrtlaIpAddresses } from "./srtla-ip-preparation.ts";
import { type StartStreamResult, startStream } from "./start-stream.ts";
import { confirmUnownedEngineStop } from "./stop-evidence.ts";

export {
	prepareSrtlaIpAddresses,
	type SrtlaIpPreparationDeps,
} from "./srtla-ip-preparation.ts";

type SessionResources = {
	readonly generation: number;
	/** Closes the address-adoption check and withdraws its offer. Idempotent. */
	readonly closeReloadCheck: () => void;
	readonly removeNetworkInterfacesChangeListener: () => void;
};

let sessionResources: SessionResources | undefined;

/** The generation whose session resources are live, for the restart offer. */
export function currentSessionGeneration(): number | undefined {
	return sessionResources?.generation;
}

export { SENDER_STOP_HOLD_MS };

const DEFAULT_RELOAD_TIMING = {
	windowMs: SENDER_RELOAD_WINDOW_MS,
	pollMs: SENDER_RELOAD_POLL_MS,
	carryWindowMs: CARRY_WINDOW_MS,
};
let reloadTiming = DEFAULT_RELOAD_TIMING;
export function setSenderReloadTimingForTest(
	timing: typeof DEFAULT_RELOAD_TIMING | null,
): void {
	reloadTiming = timing ?? DEFAULT_RELOAD_TIMING;
}

// Process-wide, so an unreadable /proc logs once a minute, not once a poll.
const observationFailures = createObservationFailureLog();

async function respondToStaleSource(
	conn: WebSocket,
	generation: number,
	stale: readonly string[],
	ifaceFor: (ip: string) => string | undefined,
	verdict: CarryVerdict,
	current: () => boolean,
): Promise<void> {
	const ifaces = stale.map(ifaceFor);
	const known = ifaces.every((iface) => iface !== undefined);
	const links = known ? new Set(ifaces).size : stale.length;
	// Name the link only when there is exactly one and its interface is known.
	const [only] = ifaces;
	const name =
		known && links === 1 && only !== undefined
			? await resolveLinkLabel(only)
			: undefined;
	// Stop, or a newer publication, can land during any await here.
	if (!current()) return;
	const offer = (options?: { readonly pastCooldown?: boolean }) =>
		staleLinkNotice.offer(
			generation,
			{
				count: Math.max(links, 1),
				...(name === undefined ? {} : { name }),
				othersCarrying: verdict === "others_carrying",
			},
			options,
		);
	const response = staleSourceResponse(verdict);
	switch (response) {
		case "offer":
			offer();
			return;
		case "restart": {
			const deps = await connectionRestartDeps(conn, "link-recovery");
			if (!current()) return;
			// The stream is already down: a restart costs nothing extra. Held by the
			// cooldown (or one already running), the operator gets the offer
			// instead, even inside the notice's own cooldown: nothing else is
			// carrying, so silence would leave the operator with no word at all.
			const request = autoRestart.request(generation, deps);
			if (request.result === "held") offer({ pastCooldown: true });
			void request.done;
			return;
		}
		default: {
			const exhaustive: never = response;
			return exhaustive;
		}
	}
}

export async function start(
	conn: WebSocket,
	params: ConfigParameters,
	generation = 0,
	attemptId = "legacy-start",
	startAudio = acceptStartAudio(params),
): Promise<StartStreamResult> {
	assertStreamLaunchOwnership();
	const ownsLaunch = currentStreamLaunchOwner();
	if (getIsStreaming()) {
		sendStatus(conn);
		return {
			success: false,
			error: "stream_start_unavailable",
			reason: "stream_start_unavailable",
			phase: "params",
		};
	}
	if (isUpdating()) {
		sendStatus(conn);
		throw new StreamStartFailure({
			attemptId,
			phase: "connect",
			class: "engine_restarting",
			code: "stream_start_suppressed_update",
			retriable: true,
		});
	}

	const senderId = getSocketSenderId(conn);

	let c: {
		pipeline: Pipeline;
		srtlaAddr: string;
		srtlaPort: number;
		streamid: string;
	};
	try {
		c = await updateConfig(params, startAudio);
		assertStreamLaunchOwnership();
	} catch (err) {
		if (typeof err === "string") {
			startError(conn, err, senderId);
		} else {
			startError(conn, "Failed to save the config, unknown error", senderId);
			logger.error("Failed to save config", { err });
		}
		return {
			success: false,
			error: typeof err === "string" ? err : "start_invalid",
			reason: typeof err === "string" ? err : "start_invalid",
			phase: "params",
		};
	}

	if (sessionResources !== undefined) {
		reportSessionInvariant(
			generation,
			`start found resources owned by generation ${sessionResources.generation}`,
		);
		sessionResources.removeNetworkInterfacesChangeListener();
	}

	try {
		await prepareSrtlaIpAddresses(c.srtlaAddr);
		assertStreamLaunchOwnership();
	} catch (error) {
		throw new StreamStartFailure(
			classifyStartFailure("params", error, attemptId, {
				warn: (message, meta) => logger.warn(message, meta),
			}),
		);
	}
	let sessionOpen = true;
	const reloads = createReloadQueue();
	const ownsSession = () =>
		sessionOpen && sessionResources?.generation === generation && ownsLaunch();
	// Which interface each source belonged to in this session, so a stale (no
	// longer published) source can still be named by its link.
	const ifaceBySource = new Map<string, string>();
	const rememberBond = () => {
		for (const entry of getLastPublishedBond()?.entries ?? [])
			ifaceBySource.set(entry.ip, entry.iface);
	};
	rememberBond();
	const removeReloadObserver = observeSenderReload((delivery) => {
		const deliveredPromise = delivery;
		const bond = getLastPublishedBond();
		const publication = bond?.publication;
		if (!bond || !publication) return;
		rememberBond();
		const sources = bond.entries.map((entry) => entry.ip);
		reloads.enqueue(JSON.stringify([publication, sources]), async (signal) => {
			const delivered = await deliveredPromise;
			let first = true;
			const sender = () =>
				getStreamingProcesses().find((p) => p.spawnfile === srtlaSendExec);
			const log = (_event: string, meta: Record<string, unknown>) =>
				logger.info("sender reload", meta);
			// Watches the other links over the same ~20 s, so a stuck link's cost
			// is judged on what was actually carried.
			const carrying = createCarryTracker(Date.now, reloadTiming.carryWindowMs);
			const result = await verifySenderReload(
				publication.ok ? publication.generation : undefined,
				sources,
				{
					signal,
					now: Date.now,
					wait: (ms) => waitForReload(ms, signal),
					windowMs: reloadTiming.windowMs,
					pollMs: reloadTiming.pollMs,
					hup: async () => {
						if (first) {
							first = false;
							return delivered;
						}
						const owned = sender();
						if (!owned || !ownsSession()) return false;
						owned.proc.kill("SIGHUP");
						logger.info("sender reload signal delivered", {
							pid: owned.proc.pid,
						});
						return true;
					},
					read: async () => {
						carrying.sample(buildLinkTelemetry());
						const owned = sender();
						if (!owned || !ownsSession()) return undefined;
						return { sources: await senderSocketSources(owned.proc.pid) };
					},
					log,
					observationFailed: (error) => observationFailures.report(error, log),
				},
			);
			if (signal.aborted || !ownsSession()) return;
			if (result.outcome === "adopted") staleLinkNotice.retract(generation);
			if (result.outcome === "stale")
				await respondToStaleSource(
					conn,
					generation,
					result.stale,
					(ip) => ifaceBySource.get(ip),
					carrying.judge(
						result.stale.map((ip) => ifaceBySource.get(ip)),
						bond.entries.map((entry) => entry.iface),
					),
					() => !signal.aborted && ownsSession(),
				);
		});
	});

	const closeReloadCheck = () => {
		sessionOpen = false;
		reloads.close();
		removeReloadObserver();
		staleLinkNotice.retract(generation);
	};

	let refreshing = Promise.resolve();
	const refreshSrtlaIpAddresses = () => {
		refreshing = refreshing.then(refreshBond);
		return refreshing;
	};
	const refreshBond = async () => {
		if (sessionResources?.generation !== generation || !ownsLaunch()) return;
		try {
			// `changed` is true for a MAPPING-ONLY republication too — moving a link
			// from one interface to another leaves the IP bytes byte-identical, so a
			// SIGHUP keyed on the list alone would skip the very reload that carries
			// the new mapping.
			const publication = await prepareSrtlaIpAddresses(
				c.srtlaAddr,
				undefined,
				"refresh",
			);
			if (sessionResources?.generation !== generation || !ownsLaunch()) return;
			if (publication.changed && getIsStreaming()) void restartSrtla();
		} catch (error) {
			logger.warn("Failed to refresh SRTLA IP addresses", { error });
		}
	};
	const removeNetifListener = onNetworkInterfaceSourcesChange(
		refreshSrtlaIpAddresses,
	);
	const removeScanListener = onUsbNetScanCommitted(refreshSrtlaIpAddresses);
	sessionResources = {
		generation,
		closeReloadCheck,
		removeNetworkInterfacesChangeListener: () => {
			closeReloadCheck();
			removeNetifListener();
			removeScanListener();
		},
	};

	let result: StartStreamResult;
	try {
		result = await startStream(
			c.pipeline,
			c.srtlaAddr,
			c.srtlaPort,
			c.streamid,
			{},
			attemptId,
			undefined,
			startAudio,
		);
	} catch (err) {
		if (sessionResources?.generation === generation) {
			sessionResources.removeNetworkInterfacesChangeListener();
			sessionResources = undefined;
		}
		if (err instanceof StreamStartFailure) throw err;
		if (typeof err === "string") {
			startError(conn, err, senderId);
		} else {
			startError(conn, "Failed to start, unknown error", senderId);
			logger.error("Failed to start stream", { err });
		}
		return {
			success: false,
			error: typeof err === "string" ? err : "engine_internal",
			reason: typeof err === "string" ? err : "engine_internal",
			phase: "spawn-sender",
		};
	}

	if (!result.success && sessionResources?.generation === generation) {
		sessionResources.removeNetworkInterfacesChangeListener();
		sessionResources = undefined;
	}
	return result;
}

export async function retireGenerationResources(
	generation: number,
): Promise<void> {
	// Only the adoption check closes before the engine stops. The interface and
	// USB listeners stay until the stop has finished, so a Stop that does not
	// complete keeps publishing address changes to a stream that is still up.
	if (sessionResources?.generation === generation) {
		sessionResources.closeReloadCheck();
	}
	// A deferred auto-audio follow (T7) only applies at the NEXT start; a stop
	// cancels it so the picker never keeps a stale "follows on restart" hint.
	setPendingAudioFollowAsrc(null);
	if (sessionResources?.generation === generation) {
		sessionResources.removeNetworkInterfacesChangeListener();
		sessionResources = undefined;
	}
	await Promise.all(getStreamingProcesses().map(stopProcessAndWait));
	stopLinkTelemetry();
	clearBindMapReport();
	announceBindMapReport();
}

export function stopGeneration(
	generation: number,
	confirmUnknown = false,
): Promise<void> {
	setPendingAudioFollowAsrc(null);
	return new Promise((resolve, reject) => {
		let finishPromise: Promise<void> | undefined;
		const finish = (
			outcome: { ok: true } | { ok: false; error: unknown } = { ok: true },
		) => {
			if (finishPromise !== undefined) return finishPromise;
			finishPromise = (async () => {
				await retireGenerationResources(generation);
				if (!outcome.ok) throw outcome.error;
				updateStatus(false);
			})();
			void finishPromise.then(resolve, reject);
			return finishPromise;
		};

		if (isAsrcProbeRejectResolved()) {
			clearAsrcProbeReject();

			if (getStreamingProcesses().length === 0) {
				void finish();
				return;
			}

			reportSessionInvariant(
				generation,
				"audio probe cancellation overlapped running processes",
			);
		}

		// Bring the engine down first (it owns the engine-first shutdown ordering),
		// then sweep the rest once it has exited.
		const foundEngine = getStreamingBackend().stop(
			() => {
				recentRelaySession.stopped();
				// Keep forwarding alive briefly after the engine has emitted its real SRT
				// shutdown. Never synthesize a packet or infer shutdown from link loss.
				if (
					getStreamingProcesses().some(
						(process) => process.spawnfile === srtlaSendExec,
					)
				) {
					setTimeout(() => {
						void finish();
					}, SENDER_STOP_HOLD_MS);
				} else {
					void finish();
				}
			},
			(error) => {
				void finish({ ok: false, error });
			},
		);

		if (!foundEngine) {
			if (
				sessionResources?.generation === generation ||
				getStreamingProcesses().length > 0
			) {
				reportSessionInvariant(
					generation,
					"engine session missing while generation-owned resources remained",
				);
			}
			confirmUnownedEngineStop(finish, undefined, confirmUnknown);
		}
	});
}

export function stop(): void {
	setPendingAudioFollowAsrc(null);
	if (isAsrcProbeRejectResolved()) clearAsrcProbeReject();
	void import("../stream-session-orchestrator.ts").then(
		({ stopStreamSession }) => stopStreamSession("operator"),
	);
}
