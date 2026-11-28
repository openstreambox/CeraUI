import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { emitEvent } from "../events/emit.ts";
import { ensureEncoderShutdownProtection } from "../system/shutdown-protection.ts";
import { admitAndPrepareStreamStart } from "../system/update-orchestrator/runtime.ts";
import { notificationBroadcast } from "../ui/notifications.ts";
import { notifyWifiAdapterModeEdge } from "../wifi/wifi-adapter-mode-events.ts";
import { noteStreamStopped } from "./armed-stream-marker.ts";
import { asrcProbeRemainingMs } from "./audio.ts";
import {
	broadcastConfigChangePhase,
	changeEngineRuntimeConfig,
} from "./config-change-bridge.ts";
import { requestEngineReachabilityCheck } from "./engine-control-loss.ts";
import { currentRuntimeObservationUncertainty } from "./engine-runtime-observation.ts";
import { queryEngineRuntimeStreaming } from "./engine-runtime-state.ts";
import { engineUnitStopped } from "./engine-unit-state.ts";
import {
	beginLinkTeardownWait,
	globalStreamHold,
	linkTeardownSettled,
	START_LINK_TEARDOWN_WAIT_MS,
	tryAcquireLifecycle,
} from "./lifecycle-admission.ts";
import {
	adoptOtaStreamingMarker,
	claimOtaMarkerForLaunch,
	clearOtaStreamingMarker,
	encoderOtaStreamLiveness,
	otaMarkerAwaitsIdleWitness,
	setOtaStreamingMarker,
} from "./ota-streaming-marker.ts";
import { awaitRecoveryBarrier, isRecoveryPending } from "./recovery-barrier.ts";
import {
	ownedSessionProcessesRemain,
	ownsSessionSender,
	unownedSenderCensus,
} from "./sender-ownership.ts";
import { newAttemptId } from "./start-failure-taxonomy.ts";
import {
	getStreamLifecycleState,
	seedStreamLifecycleState,
	updateStreamLifecycleState,
} from "./stream-lifecycle-status.ts";
import { publishStreamSessionUnconfirmed } from "./stream-liveness.ts";
import type { StreamSessionOrchestratorDeps } from "./stream-session-orchestrator.ts";
import {
	getStartSuppressionContext,
	reportStartRetry,
	reportStartTerminalFailure,
} from "./stream-start-retry-reporting.ts";
import { getIsStreaming, updateStatus } from "./streaming.ts";
import { getStreamingBackend } from "./streaming-engine.ts";
import {
	retireGenerationResources,
	stopGeneration,
} from "./streamloop/session.ts";

function recordEvent(publish: () => void): void {
	try {
		publish();
	} catch {
		// Event history must not alter stream control or later hooks.
	}
}

let streamStartedAt: number | undefined;

export const streamSessionProductionDeps: StreamSessionOrchestratorDeps = {
	initialLiveness: encoderOtaStreamLiveness,
	createAttemptId: newAttemptId,
	setStreamingStatus: updateStatus,
	getStreamingStatus: getIsStreaming,
	stopRuntime: async (generation, confirmUnknown) => {
		await stopGeneration(generation, confirmUnknown);
		if (!shouldUseMocks() && unownedSenderCensus() !== "absent")
			throw new Error("sender_ownership_unproven");
	},
	queryRuntime: async () => {
		const runtime = await queryEngineRuntimeStreaming();
		if (
			!shouldUseMocks() &&
			runtime === "idle" &&
			unownedSenderCensus() !== "absent"
		) {
			currentRuntimeObservationUncertainty()();
			return "unknown";
		}
		return runtime;
	},
	onEngineUnavailable: () => requestEngineReachabilityCheck("start"),
	canReconcileIdle: () =>
		shouldUseMocks() || unownedSenderCensus() === "absent",
	ownedSessionRemains: () => !shouldUseMocks() && ownedSessionProcessesRemain(),
	setLivenessUnconfirmed: (unconfirmed) => {
		// Clearing reopens the Wi-Fi mode restore that `is_streaming` alone gates.
		if (
			publishStreamSessionUnconfirmed(unconfirmed) &&
			!unconfirmed &&
			!getIsStreaming()
		)
			void notifyWifiAdapterModeEdge();
	},
	protectUnownedEngineSession: () => {
		// A running engine is enough to retire the carrying-only explanation,
		// but is not enough to establish successful data-path adoption.
		claimOtaMarkerForLaunch();
	},
	// Evidence from this process only: an attempt it launched is retained, a
	// live sender child with the configured executable runs, and the engine client
	// that acknowledged this process's Start is unchanged. The three are not bound
	// to one generation number; together they rule out a predecessor's session.
	canReconcileStreaming: (generation) =>
		shouldUseMocks() ||
		(generation !== undefined &&
			ownsSessionSender() &&
			getStreamingBackend().ownsLaunchedSession?.() === true),
	// A lost control connection retires this process's local resources only;
	// no Stop is sent, so the engine's session is settled by fresh evidence.
	retireRuntime: retireGenerationResources,
	seedLifecycleState: (state) => {
		streamStartedAt = undefined;
		seedStreamLifecycleState(state);
	},
	setLifecycleState: (state) => {
		const previous = getStreamLifecycleState();
		updateStreamLifecycleState(state);
		if (previous === "starting" && state === "streaming") {
			streamStartedAt = Date.now();
			recordEvent(() => emitEvent("stream_started", {}));
		}
		if (previous !== "stop_failed" && state === "stop_failed")
			recordEvent(() => emitEvent("stream_stop_failed", {}));
		if (
			previous === "reconfiguring" &&
			(state === "streaming" || state === "idle" || state === "reconciling")
		)
			recordEvent(() => emitEvent("stream_reconfigured", { outcome: state }));
	},
	invariantViolation: (from, to) => {
		logger.error("stream-session illegal lifecycle transition", { from, to });
		notificationBroadcast(
			"stream_session_recovered",
			"warning",
			"The stream session entered an invalid lifecycle state and was recovered.",
			10,
			false,
			true,
		);
	},
	pendingGateRemainingMs: () => asrcProbeRemainingMs(),
	suppressionContext: getStartSuppressionContext,
	reportRetry: reportStartRetry,
	reportTerminalFailure: reportStartTerminalFailure,
	changeRuntimeConfig: changeEngineRuntimeConfig,
	publishConfigChangePhase: broadcastConfigChangePhase,
	// Lazy graph edges retain initialization order; ownership is checked after import.
	onStreamCommitted: (current) => {
		void import("./sources.ts")
			.then(({ noteStreamedSourceCommitted }) => {
				if (current()) noteStreamedSourceCommitted();
			})
			.catch((error) =>
				logger.warn("stream commit bookkeeping failed", { error }),
			);
		// A session runs again, so a "restart didn't finish" notice is out of date,
		// and a reconnect window has done its job.
		void import("./connection-restart.ts")
			.then(({ clearRestartFailureNotice }) => clearRestartFailureNotice())
			.catch((error) =>
				logger.warn("restart failure notice cleanup failed", { error }),
			);
		void import("./stream-reconnect-wiring.ts")
			.then(({ noteStreamCommittedForReconnect }) => {
				if (current()) noteStreamCommittedForReconnect();
			})
			.catch((error) =>
				logger.warn("reconnect window cleanup failed", { error }),
			);
		// A bond published between the spawn and this commit skipped its reload,
		// because nothing was marked streaming yet; deliver it now.
		void import("./srtla.ts")
			.then((srtla) => srtla.reloadOwedAtLaunchCommit(current))
			.catch((error) =>
				logger.warn("owed sender reload after commit failed", { error }),
			);
	},
	onStreamArmed: (current) => {
		void import("./stream-restoration.ts")
			.then(({ armStreamRestoration }) => {
				if (current()) armStreamRestoration();
			})
			.catch((error) =>
				logger.warn("stream restoration arming failed", { error }),
			);
	},
	ensureShutdownProtection: ensureEncoderShutdownProtection,
	claimLaunchMarker: claimOtaMarkerForLaunch,
	admitLifecycle: () => tryAcquireLifecycle("streaming"),
	linkTeardown: {
		settled: linkTeardownSettled,
		beginWait: beginLinkTeardownWait,
		budgetMs: START_LINK_TEARDOWN_WAIT_MS,
	},
	awaitRecovery: awaitRecoveryBarrier,
	recoveryPending: isRecoveryPending,
	blockingMutation: globalStreamHold,
	senderAdmissionSafe: () =>
		shouldUseMocks() || unownedSenderCensus() === "absent",
	admitUpdate: admitAndPrepareStreamStart,
	markStreamingForOta: setOtaStreamingMarker,
	unmarkStreamingForOta: clearOtaStreamingMarker,
	confirmStreamingForOta: adoptOtaStreamingMarker,
	awaitsIdleWitness: otaMarkerAwaitsIdleWitness,
	engineStopped: () => engineUnitStopped(),
	onStreamStopped: (cause) => {
		noteStreamStopped(cause);
		recordEvent(() =>
			emitEvent("stream_stopped", {
				cause,
				durationSec:
					streamStartedAt === undefined
						? 0
						: Math.max(0, (Date.now() - streamStartedAt) / 1000),
			}),
		);
		streamStartedAt = undefined;
	},
};
