import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { ensureEncoderShutdownProtection } from "../system/shutdown-protection.ts";
import { admitAndPrepareStreamStart } from "../system/update-orchestrator/runtime.ts";
import { notificationBroadcast } from "../ui/notifications.ts";
import { noteStreamStopped } from "./armed-stream-marker.ts";
import { asrcProbeRemainingMs } from "./audio.ts";
import {
	broadcastConfigChangePhase,
	changeEngineRuntimeConfig,
} from "./config-change-bridge.ts";
import { currentRuntimeObservationUncertainty } from "./engine-runtime-observation.ts";
import { queryEngineRuntimeStreaming } from "./engine-runtime-state.ts";
import {
	globalStreamHold,
	tryAcquireLifecycle,
} from "./lifecycle-admission.ts";
import {
	claimOtaMarkerForLaunch,
	clearOtaStreamingMarker,
	encoderOtaStreamLiveness,
	setOtaStreamingMarker,
} from "./ota-streaming-marker.ts";
import { awaitRecoveryBarrier, isRecoveryPending } from "./recovery-barrier.ts";
import { ownsSessionSender, senderCensus } from "./sender-ownership.ts";
import { newAttemptId } from "./start-failure-taxonomy.ts";
import {
	seedStreamLifecycleState,
	updateStreamLifecycleState,
} from "./stream-lifecycle-status.ts";
import type { StreamSessionOrchestratorDeps } from "./stream-session-orchestrator.ts";
import {
	getStartSuppressionContext,
	reportStartRetry,
	reportStartTerminalFailure,
} from "./stream-start-retry-reporting.ts";
import { getIsStreaming, updateStatus } from "./streaming.ts";
import { getStreamingBackend } from "./streaming-engine.ts";
import { stopGeneration } from "./streamloop/session.ts";

export const streamSessionProductionDeps: StreamSessionOrchestratorDeps = {
	initialLiveness: encoderOtaStreamLiveness,
	createAttemptId: newAttemptId,
	setStreamingStatus: updateStatus,
	getStreamingStatus: getIsStreaming,
	stopRuntime: async (generation, confirmUnknown) => {
		await stopGeneration(generation, confirmUnknown);
		if (!shouldUseMocks() && senderCensus() !== "absent")
			throw new Error("sender_ownership_unproven");
	},
	queryRuntime: async () => {
		const runtime = await queryEngineRuntimeStreaming();
		if (
			!shouldUseMocks() &&
			runtime === "idle" &&
			senderCensus() !== "absent"
		) {
			currentRuntimeObservationUncertainty()();
			return "unknown";
		}
		return runtime;
	},
	canReconcileIdle: () => shouldUseMocks() || senderCensus() === "absent",
	protectUnownedEngineSession: () => {
		// A running engine is enough to retire the carrying-only explanation,
		// but is not enough to establish successful data-path adoption.
		claimOtaMarkerForLaunch();
	},
	canReconcileStreaming: (generation) =>
		shouldUseMocks() ||
		(generation !== undefined &&
			ownsSessionSender() &&
			getStreamingBackend().ownsLaunchedSession?.() === true),
	seedLifecycleState: seedStreamLifecycleState,
	setLifecycleState: updateStreamLifecycleState,
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
		// A session runs again, so a "restart didn't finish" notice is out of date.
		void import("./connection-restart.ts")
			.then(({ clearRestartFailureNotice }) => clearRestartFailureNotice())
			.catch((error) =>
				logger.warn("restart failure notice cleanup failed", { error }),
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
	awaitRecovery: awaitRecoveryBarrier,
	recoveryPending: isRecoveryPending,
	blockingMutation: globalStreamHold,
	senderAdmissionSafe: () =>
		shouldUseMocks() || ownsSessionSender() || senderCensus() === "absent",
	admitUpdate: admitAndPrepareStreamStart,
	markStreamingForOta: setOtaStreamingMarker,
	unmarkStreamingForOta: clearOtaStreamingMarker,
	onStreamStopped: noteStreamStopped,
};
