/*
  RESTARTING THE CONNECTION: THE OPERATOR'S TAP, OR ON ITS OWN WHEN NOTHING IS
  CARRYING THE STREAM.

  Both are a full, supervised session restart through the same Stop then Start
  the profile reconnect uses: Stop keeps the sender up for the engine's own SRT
  shutdown (the 250 ms hold in session.ts), and Start runs under the start
  supervisor, whose bounded busy-session retry covers the relay still holding
  the old session (reason 1000).

  The tap must carry the token of the offer on screen for the session running
  now, and the token is spent on first use; its Start is the operator's, origin
  "ui". The automatic restart runs only when no other link carried the stream,
  at most once per cooldown, starts with its own origin "link-recovery", and is
  announced only after the new session has started. While either runs, the
  status says the connection is restarting (connection-restarting.ts), so no
  surface reads the gap between Stop and Start as "Not streaming".

  A restart whose Start does not start the new session hands it to the
  reconnect window (stream-reconnect.ts) before the restarting status drops, so
  no surface sees a gap: the window keeps the stream reconnecting until a link
  is back, the streamer presses Stop, or the box's maximum retry time ran out,
  and then leaves the notice with "Keep trying". A restart whose Stop did not
  complete says so to every client, once the restarting status has dropped. An
  operator Stop during the restart says nothing; the operator chose it.

  A restart after every link was lost (`totalLoss`) is not the stale-address
  case the cooldown guards: its Start cannot loop on an address that keeps
  going stale, and the reconnect window bounds it. With reconnecting on, it
  neither waits for nor starts the cooldown.
*/

import type { RestartConnectionOutput } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";
import { beginConnectionRestart } from "./connection-restarting.ts";
import type { StaleLinkOffer } from "./stale-link-notice.ts";
import type { StreamLaunchOrigin } from "./stream-session-contract.ts";

type StopOutcome = { readonly result: string };
type StartOutcome = { readonly result: string };

export type ConnectionRestartDeps = {
	/** The running session's generation, or undefined when nothing runs. */
	readonly generation: () => number | undefined;
	readonly take: (
		token: string,
		generation: number | undefined,
	) => StaleLinkOffer | undefined;
	readonly isStreaming: () => boolean;
	readonly captureStopIntent: () => () => boolean;
	/** Marks the restart as running for the status; the result ends it. */
	readonly beginRestart: () => () => void;
	readonly stop: () => Promise<StopOutcome>;
	/**
	 * Checks `stillWanted` after its last await, right before the session
	 * supervisor takes the Start, and does not start when it says no.
	 */
	readonly start: (stillWanted: () => boolean) => Promise<StartOutcome>;
	/** After an automatic restart has started the new session. */
	readonly announce: (kind: RestartAnnouncement) => void;
	/**
	 * The old session stopped and the new one did not start, and no operator
	 * Stop came in between (`stillWanted`): the reconnect window takes over,
	 * retrying on its own only after every link was lost (`totalLoss`, or no
	 * link left). Runs before the restarting status drops.
	 */
	readonly reconnect: (
		stillWanted: () => boolean,
		failure: { readonly totalLoss: boolean },
	) => void | Promise<void>;
	/** The old session did not stop. Never for an operator Stop. */
	readonly announceFailure: (failed: RestartFailure) => void;
	readonly log: (message: string, meta: Record<string, unknown>) => void;
};

export type ConnectionRestartRequest = {
	readonly output: RestartConnectionOutput;
	/** Settles when the restart has finished; never rejects. */
	readonly done: Promise<string>;
};

export type RestartFailure = "stop";

/** `new_address`: a link kept an old address; `reconnected`: every link was lost. */
export type RestartAnnouncement = "new_address" | "reconnected";

/** The persistent notice a restart that did not finish leaves on screen. */
export const CONNECTION_RESTART_FAILED = "connection_restart_failed";

/** Stop, then Start, unless an operator Stop intervenes. Never rejects. */
function runRestart(
	deps: ConnectionRestartDeps,
	generation: number,
	origin: "tap" | "automatic",
	totalLoss = false,
): Promise<string> {
	const end = deps.beginRestart();
	let stoppedOld = false;
	// `reconfigure`, not `operator`: this Stop is the first half of a restart,
	// so restoration stays armed. An operator Stop during it still wins.
	const intent = deps.captureStopIntent();
	return (async () => {
		const stopped = await deps.stop();
		if (stopped.result !== "stopped") {
			deps.log("stop did not complete", { origin, stopped });
			return "stop_failed";
		}
		stoppedOld = true;
		if (!intent()) {
			deps.log("Stop during restart; not starting", { origin });
			return "cancelled";
		}
		const started = await deps.start(intent);
		deps.log("finished", { origin, generation, started: started.result });
		return started.result;
	})()
		.catch((error: unknown) => {
			deps.log("failed", { origin, error: String(error) });
			return "failed";
		})
		.then(async (result) => {
			// Before `end`: the window raises its own restarting status first, so
			// the stream never reads as stopped between the two.
			if (stoppedOld && result !== "started" && result !== "cancelled")
				await (async () => deps.reconnect(intent, { totalLoss }))().catch(
					(error: unknown) =>
						deps.log("reconnect failed to open", { error: String(error) }),
				);
			return result;
		})
		.finally(end)
		.then((result) => {
			// After `end`, so no surface still says "Restarting connection" beside
			// a notice that the restart did not finish.
			if (!stoppedOld && result !== "started" && result !== "cancelled")
				deps.announceFailure("stop");
			return result;
		});
}

export function requestConnectionRestart(
	token: string,
	deps: ConnectionRestartDeps,
): ConnectionRestartRequest {
	const offer = deps.isStreaming()
		? deps.take(token, deps.generation())
		: undefined;
	if (offer === undefined) {
		deps.log("refused: the offer is no longer current", {});
		return {
			output: { success: false, result: "refused", error: "offer_not_current" },
			done: Promise.resolve("refused"),
		};
	}
	return {
		output: { success: true, result: "restarting" },
		done: runRestart(deps, offer.generation, "tap"),
	};
}

/** An automatic restart cannot repeat within this long. */
export const AUTO_RESTART_COOLDOWN_MS = 5 * 60_000;

export type AutoRestartRequest = {
	/** `held`: cooldown or a restart already running; `not_current`: the session moved on. */
	readonly result: "restarting" | "held" | "not_current";
	readonly done: Promise<string>;
};

export type AutoRestartOptions = {
	/**
	 * Every link was lost and reconnecting is on: the cooldown neither holds
	 * this restart nor starts from it.
	 */
	readonly totalLoss?: boolean;
};

export function createAutoRestart(
	now: () => number = Date.now,
	cooldownMs = AUTO_RESTART_COOLDOWN_MS,
) {
	let lastAt = Number.NEGATIVE_INFINITY;
	let inFlight = false;
	return {
		request(
			generation: number,
			deps: ConnectionRestartDeps,
			options: AutoRestartOptions = {},
		): AutoRestartRequest {
			const totalLoss = options.totalLoss === true;
			if (inFlight || (!totalLoss && now() - lastAt < cooldownMs)) {
				deps.log("automatic restart held", { generation, inFlight });
				return { result: "held", done: Promise.resolve("held") };
			}
			if (!deps.isStreaming() || deps.generation() !== generation)
				return { result: "not_current", done: Promise.resolve("not_current") };
			if (!totalLoss) lastAt = now();
			inFlight = true;
			const done = runRestart(deps, generation, "automatic", totalLoss).then(
				(result) => {
					inFlight = false;
					if (result === "started")
						deps.announce(totalLoss ? "reconnected" : "new_address");
					return result;
				},
			);
			return { result: "restarting", done };
		},
		/** Tests only. */
		resetForTest(): void {
			lastAt = Number.NEGATIVE_INFINITY;
			inFlight = false;
		},
	};
}

export const autoRestart = createAutoRestart();

/** The Start origin of each restart: the operator's tap, or the device's own. */
export type ConnectionRestartOrigin = Extract<
	StreamLaunchOrigin,
	"ui" | "link-recovery"
>;

/** Production wiring, resolved lazily for the streaming graph's load order. */
export async function connectionRestartDeps(
	origin: ConnectionRestartOrigin,
): Promise<ConnectionRestartDeps> {
	const [
		{ captureOperatorStopIntent },
		{ stopStreamSession },
		{ getIsStreaming },
		{ currentSessionGeneration },
		{ staleLinkNotice },
	] = await Promise.all([
		import("./operator-stop-intent.ts"),
		import("./stream-session-orchestrator.ts"),
		import("./streaming.ts"),
		import("./streamloop/session.ts"),
		import("./stale-link-notice.ts"),
	]);
	return {
		generation: currentSessionGeneration,
		take: staleLinkNotice.take,
		isStreaming: getIsStreaming,
		captureStopIntent: captureOperatorStopIntent,
		beginRestart: () => beginConnectionRestart(),
		stop: () => stopStreamSession("reconfigure"),
		start: (stillWanted) => restartStart(stillWanted, origin),
		announce: (kind) =>
			kind === "reconnected"
				? notificationBroadcast(
						"connection_restarted",
						"info",
						"Stream reconnected.",
						10,
						false,
						true,
						true,
						"notifications.streamReconnected",
					)
				: notificationBroadcast(
						"connection_restarted",
						"info",
						"Restarted the connection to use the new address.",
						10,
						false,
						true,
						true,
						"notifications.connectionRestartedNewAddress",
					),
		reconnect: async (stillWanted, failure) => {
			const { reconnectAfterRestartFailure } = await import(
				"./stream-reconnect-wiring.ts"
			);
			if (stillWanted())
				await reconnectAfterRestartFailure(failure, stillWanted);
		},
		announceFailure: announceRestartFailure,
		log: (event, meta) => logger.info("connection restart", { event, ...meta }),
	};
}

/**
 * The Start's own socket: a restart and the reconnect window have no operator
 * socket to answer, and say what happened through their own notices, so a
 * start error the session raises reaches nobody.
 */
const restartSocket = {
	send: () => {
		/* no socket: the restart and the window report for themselves */
	},
	data: { isAuthenticated: true, lastActive: Date.now() },
} as unknown as import("ws").default;

/**
 * A full, supervised Start of the session that just stopped, for a restart and
 * for the reconnect window. Its failures stay off the start-failure notice:
 * the restart and the window say what happened instead. `stillWanted` is
 * checked after the last await, so an operator Stop that landed while the
 * modules loaded is not overtaken: the supervisor takes the Start in the same
 * turn and captures the Stop intent as it is now. Never rejects.
 */
export async function restartStart(
	stillWanted: () => boolean,
	origin: ConnectionRestartOrigin,
): Promise<StartOutcome> {
	const [
		{ startStreamSession },
		{ start: startStream },
		{ classifyStartFailure, StreamStartFailure, typedStartFailure },
	] = await Promise.all([
		import("./stream-session-orchestrator.ts"),
		import("./streamloop/session.ts"),
		import("./start-failure-taxonomy.ts"),
	]);
	if (!stillWanted()) return { result: "cancelled" };
	try {
		return await startStreamSession({
			origin,
			quietTerminalFailure: true,
			launch: async ({ attemptId, generation }) => {
				// Empty params: the start reads the persisted config of the session
				// that just stopped.
				const result = await startStream(
					restartSocket,
					{},
					generation,
					attemptId,
				);
				if (!result.success) {
					throw new StreamStartFailure(
						result.failureClass !== undefined
							? typedStartFailure(
									attemptId,
									result.phase,
									result.failureClass,
									result.error,
								)
							: classifyStartFailure(result.phase, result.error, attemptId),
					);
				}
			},
		});
	} catch (error) {
		logger.warn("connection restart start threw", { error });
		return { result: "failed" };
	}
}

function announceRestartFailure(_failed: RestartFailure): void {
	notificationBroadcast(
		CONNECTION_RESTART_FAILED,
		"warning",
		"Couldn't restart the connection because the stream didn't stop cleanly. It may still be running, so check Live before trying again.",
		0,
		true,
		true,
		true,
		"notifications.connectionRestartStopFailed",
	);
}

/** A new session runs again, so a restart failure notice is out of date. */
export function clearRestartFailureNotice(): void {
	notificationRemove(CONNECTION_RESTART_FAILED);
}
