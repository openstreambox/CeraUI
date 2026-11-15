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

  A restart that does not end with the new session running says so to every
  client, once the restarting status has dropped: a Start refused before launch
  or a launch failure otherwise reaches only a log line, or a socket that may
  have closed long ago. An operator Stop during the restart says nothing; the
  operator chose it.
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
	readonly start: () => Promise<StartOutcome>;
	/** After an automatic restart has started the new session. */
	readonly announce: () => void;
	/**
	 * After a restart that did not end with the new session running: `start`
	 * when the old session stopped and the new one did not start, `stop` when
	 * the old session did not stop. Never for an operator Stop.
	 */
	readonly announceFailure: (failed: RestartFailure) => void;
	readonly log: (message: string, meta: Record<string, unknown>) => void;
};

export type ConnectionRestartRequest = {
	readonly output: RestartConnectionOutput;
	/** Settles when the restart has finished; never rejects. */
	readonly done: Promise<string>;
};

export type RestartFailure = "start" | "stop";

/** The persistent notice a restart that did not finish leaves on screen. */
export const CONNECTION_RESTART_FAILED = "connection_restart_failed";

/** Stop, then Start, unless an operator Stop intervenes. Never rejects. */
function runRestart(
	deps: ConnectionRestartDeps,
	generation: number,
	origin: "tap" | "automatic",
): Promise<string> {
	const end = deps.beginRestart();
	let stoppedOld = false;
	return (async () => {
		// `reconfigure`, not `operator`: this Stop is the first half of a restart,
		// so restoration stays armed. An operator Stop during it still wins.
		const intent = deps.captureStopIntent();
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
		const started = await deps.start();
		deps.log("finished", { origin, generation, started: started.result });
		return started.result;
	})()
		.catch((error: unknown) => {
			deps.log("failed", { origin, error: String(error) });
			return "failed";
		})
		.finally(end)
		.then((result) => {
			// After `end`, so no surface still says "Restarting connection" beside
			// a notice that the restart did not finish.
			if (result !== "started" && result !== "cancelled")
				deps.announceFailure(stoppedOld ? "start" : "stop");
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
		): AutoRestartRequest {
			if (inFlight || now() - lastAt < cooldownMs) {
				deps.log("automatic restart held", { generation, inFlight });
				return { result: "held", done: Promise.resolve("held") };
			}
			if (!deps.isStreaming() || deps.generation() !== generation)
				return { result: "not_current", done: Promise.resolve("not_current") };
			lastAt = now();
			inFlight = true;
			const done = runRestart(deps, generation, "automatic").then((result) => {
				inFlight = false;
				if (result === "started") deps.announce();
				return result;
			});
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
	conn: import("ws").default,
	origin: ConnectionRestartOrigin,
): Promise<ConnectionRestartDeps> {
	const [
		{ captureOperatorStopIntent },
		{ startStreamSession, stopStreamSession },
		{ getIsStreaming },
		{ start: startStream, currentSessionGeneration },
		{ staleLinkNotice },
		{ classifyStartFailure, StreamStartFailure, typedStartFailure },
	] = await Promise.all([
		import("./operator-stop-intent.ts"),
		import("./stream-session-orchestrator.ts"),
		import("./streaming.ts"),
		import("./streamloop/session.ts"),
		import("./stale-link-notice.ts"),
		import("./start-failure-taxonomy.ts"),
	]);
	return {
		generation: currentSessionGeneration,
		take: staleLinkNotice.take,
		isStreaming: getIsStreaming,
		captureStopIntent: captureOperatorStopIntent,
		beginRestart: () => beginConnectionRestart(),
		stop: () => stopStreamSession("reconfigure"),
		start: () =>
			startStreamSession({
				origin,
				launch: async ({ attemptId, generation }) => {
					// Empty params: the start reads the persisted config of the session
					// that just stopped.
					const result = await startStream(conn, {}, generation, attemptId);
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
			}),
		announce: () =>
			notificationBroadcast(
				"connection_restarted",
				"info",
				"Restarted the connection to use the new address.",
				10,
				false,
				true,
				true,
				"notifications.connectionRestartedNewAddress",
			),
		announceFailure: announceRestartFailure,
		log: (event, meta) => logger.info("connection restart", { event, ...meta }),
	};
}

function announceRestartFailure(failed: RestartFailure): void {
	if (failed === "start") {
		notificationBroadcast(
			CONNECTION_RESTART_FAILED,
			"error",
			"Couldn't restart the connection: the stream stopped but didn't start again. Your settings and links are unchanged, and viewers see your BRB screen. Start the stream to continue.",
			0,
			true,
			true,
			true,
			"notifications.connectionRestartStartFailed",
		);
		return;
	}
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
