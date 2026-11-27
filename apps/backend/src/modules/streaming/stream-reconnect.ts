/*
  RECONNECTING A STREAM THAT LOST EVERY LINK.

  A connection restart (connection-restart.ts) stops the session and starts it
  again. When every link is gone, that Start fails at once
  (`no_available_network_connections`), and on its own nothing would try again
  when a link comes back. This window does: until the streamer presses Stop, it
  starts the stream again for up to the box's maximum retry time (default two
  minutes, `auto_reconnect_max_s`), and says "Stream reconnected" when it is
  back. The setting `auto_reconnect: false` turns the automatic window off.

  WHEN IT OPENS. Only after every link was lost: the restart was for a total
  loss, or no link source is left when its Start fails. A restart that failed
  for another reason while links are up (a capture device gone, say) does not
  retry on its own; it goes straight to the end state below, where the streamer
  can still choose "Keep trying".

  WHEN IT TRIES. On an edge, not on a clock: a link source the last attempt did
  not have (netif `sourcesChange`, which a Wi-Fi carrier mark clearing and a
  modem bearer getting its address both raise, or a committed USB-net scan)
  starts an attempt at once, at most one per EDGE_SPACING_MS. A Start that fails
  while links are up backs off (BACKOFF_MIN_MS doubling to BACKOFF_MAX_MS). With
  no link to try, a quiet attempt runs at most once per probe interval
  (NO_LINK_PROBE_MS, or a third of a shorter window), in case an edge was missed.
  One attempt runs at a time, one retry timer and one deadline timer are armed,
  and no attempt starts once the deadline has passed. An attempt already
  running at the deadline may finish: its success is the stream coming back,
  its failure ends the window.

  STOP WINS. An operator Stop ends the window at once, wherever it is, including
  during an attempt and after the window ran out. Every attempt hands its Start
  a check that the window is still current, which the Start makes after its
  last await and before the session supervisor takes it, so a Stop in between
  cannot be overtaken. The window never retries after a Stop.

  WHAT EVERY SURFACE SEES. While the window runs, `connection_restarting` stays
  up (the box is reconnecting, the receiver shows its BRB scene), and
  `stream_reconnect` says `reconnecting` with the time left and a token for this
  run of the window. When the window runs out, nothing retries: `stream_reconnect`
  says `expired` with what was missing (published before the restarting flag
  drops, so no surface sees the session end in between), the persistent
  restart-failed notice offers "Keep trying", and stream restoration is
  disarmed, so a later reboot does not bring the stream back on its own either.
  "Keep trying" (the notice or the Live banner) restarts the full window in
  either state (A1004 A), with a new token; it is the streamer's own request, so
  it runs even with the automatic window switched off, and it rearms
  restoration.
*/

/** What the reconnect window publishes; `null` when there is none. */
export type StreamReconnectStatus =
	| {
			readonly state: "reconnecting";
			/** Time left at the moment of publication. */
			readonly remaining_ms: number;
			readonly token: string;
	  }
	| {
			readonly state: "expired";
			/** `no_link`: no link came back; `start_failed`: links were up. */
			readonly reason: StreamReconnectExpiry;
			readonly token: string;
	  };

export type StreamReconnectExpiry = "no_link" | "start_failed";

export type StreamReconnectSettings = {
	readonly enabled: boolean;
	readonly maxMs: number;
};

/** The default maximum retry time, and the bounds a setting may take. */
export const RECONNECT_DEFAULT_MAX_S = 120;
export const RECONNECT_MIN_MAX_S = 30;
export const RECONNECT_MAX_MAX_S = 3600;

export const EDGE_SPACING_MS = 2_000;
export const BACKOFF_MIN_MS = 2_000;
export const BACKOFF_MAX_MS = 30_000;
export const NO_LINK_PROBE_MS = 30_000;

export type StreamReconnectDeps = {
	readonly now: () => number;
	/** Runs `run` after `ms`; the returned function cancels it. */
	readonly schedule: (run: () => void, ms: number) => () => void;
	readonly token: () => string;
	readonly settings: () => StreamReconnectSettings;
	/** The link sources a Start would bond now, for the configured receiver. */
	readonly linkSources: () => readonly string[];
	/** Calls back when the bond's link sources may have changed. */
	readonly onLinkChange: (listener: () => void) => () => void;
	readonly onOperatorStop: (listener: () => void) => () => void;
	readonly isStreaming: () => boolean;
	/** Raises `connection_restarting`; the returned function lowers it, once. */
	readonly beginRestart: () => () => void;
	/**
	 * A full, supervised Start of the session that stopped. It checks
	 * `stillWanted` after its last await, before the supervisor takes it, and
	 * does not start when it says no. Never rejects.
	 */
	readonly start: (
		stillWanted: () => boolean,
	) => Promise<{ readonly result: string }>;
	readonly publish: (status: StreamReconnectStatus | null) => void;
	readonly announceReconnected: () => void;
	readonly announceExpired: (
		reason: StreamReconnectExpiry,
		token: string,
	) => void;
	readonly clearExpired: () => void;
	readonly disarmRestoration: () => void;
	/** "Keep trying" asks for the stream again: restoration may bring it back. */
	readonly rearmRestoration: () => void;
	readonly log: (event: string, meta: Record<string, unknown>) => void;
};

export type KeepTryingResult = "reconnecting" | "refused";

export type RestartFailure = {
	/** The restart was for every link lost. */
	readonly totalLoss: boolean;
};

type Episode = {
	/** This run of the window; Keep trying starts a new one. */
	token: string;
	phase: "reconnecting" | "expired";
	/** Keep trying: the streamer's own window, which the off switch leaves alone. */
	manual: boolean;
	/** Set when the window ran out: what was missing then. */
	reason: StreamReconnectExpiry;
	deadline: number;
	/** The deadline passed during an attempt: no new attempt starts. */
	closing: boolean;
	probeMs: number;
	attempts: number;
	failures: number;
	inFlight: boolean;
	edgePending: boolean;
	lastSources: ReadonlySet<string>;
	lastAttemptStartedAt: number;
	lastAttemptEndedAt: number;
	nextAt: number;
	cancelTimer: (() => void) | undefined;
	cancelDeadline: (() => void) | undefined;
	endRestart: (() => void) | undefined;
	removeLinkListener: (() => void) | undefined;
	readonly removeStopListener: () => void;
};

export function createStreamReconnect(deps: StreamReconnectDeps) {
	let episode: Episode | undefined;

	const status = (): StreamReconnectStatus | null => {
		const ep = episode;
		if (ep === undefined) return null;
		if (ep.phase === "reconnecting")
			return {
				state: "reconnecting",
				remaining_ms: Math.max(0, ep.deadline - deps.now()),
				token: ep.token,
			};
		return { state: "expired", reason: ep.reason, token: ep.token };
	};
	const publish = () => deps.publish(status());

	/** Cancels both timers and the link listener; the restarting flag stays. */
	const stopTrying = (ep: Episode) => {
		ep.cancelTimer?.();
		ep.cancelTimer = undefined;
		ep.cancelDeadline?.();
		ep.cancelDeadline = undefined;
		ep.removeLinkListener?.();
		ep.removeLinkListener = undefined;
	};
	const endRestart = (ep: Episode) => {
		ep.endRestart?.();
		ep.endRestart = undefined;
	};

	/** Ends the episode, in either phase; no later edge or timer acts on it. */
	const end = (ep: Episode, why: string) => {
		if (episode !== ep) return;
		episode = undefined;
		stopTrying(ep);
		endRestart(ep);
		ep.removeStopListener();
		deps.log("ended", { why, attempts: ep.attempts });
		publish();
	};

	const automaticOff = (ep: Episode) => !ep.manual && !deps.settings().enabled;
	const overdue = (ep: Episode) => deps.now() >= ep.deadline;

	const nextDue = (ep: Episode): number =>
		deps.linkSources().length > 0
			? ep.nextAt
			: Math.max(ep.nextAt, ep.lastAttemptStartedAt + ep.probeMs);

	const arm = (ep: Episode) => {
		ep.cancelTimer?.();
		ep.cancelTimer = deps.schedule(
			() => onTimer(ep),
			Math.max(0, nextDue(ep) - deps.now()),
		);
	};

	const expire = (ep: Episode) => {
		if (episode !== ep || ep.phase !== "reconnecting") return;
		ep.phase = "expired";
		ep.closing = false;
		ep.reason = deps.linkSources().length > 0 ? "start_failed" : "no_link";
		stopTrying(ep);
		deps.log("window ran out", { attempts: ep.attempts, reason: ep.reason });
		// Nothing retries now, a reboot included.
		deps.disarmRestoration();
		deps.announceExpired(ep.reason, ep.token);
		// The end state first, then the restarting flag: the session stays held.
		publish();
		endRestart(ep);
	};

	const succeed = (ep: Episode) => {
		if (episode !== ep) return;
		const wasReconnecting = ep.phase === "reconnecting";
		end(ep, "reconnected");
		if (wasReconnecting) deps.announceReconnected();
	};

	const attempt = (ep: Episode) => {
		const sources = deps.linkSources();
		ep.cancelTimer?.();
		ep.cancelTimer = undefined;
		ep.inFlight = true;
		ep.edgePending = false;
		ep.lastSources = new Set(sources);
		ep.lastAttemptStartedAt = deps.now();
		ep.attempts++;
		deps.log("attempt", { attempt: ep.attempts, links: sources.length });
		void deps
			.start(() => episode === ep && ep.phase === "reconnecting")
			.then(
				(outcome) => outcome.result,
				() => "failed",
			)
			.then((result) => {
				if (episode !== ep) return;
				ep.inFlight = false;
				ep.lastAttemptEndedAt = deps.now();
				if (result === "started") {
					succeed(ep);
					return;
				}
				ep.failures++;
				const backoff = Math.min(
					BACKOFF_MIN_MS * 2 ** (ep.failures - 1),
					BACKOFF_MAX_MS,
				);
				ep.nextAt = deps.now() + backoff;
				deps.log("attempt failed", { attempt: ep.attempts, result, backoff });
				if (ep.phase !== "reconnecting") return;
				if (ep.closing || overdue(ep) || automaticOff(ep)) {
					expire(ep);
					return;
				}
				if (ep.edgePending && onEdge(ep)) return;
				arm(ep);
			});
	};

	/** May an attempt start now? Ends the window when it may never again. */
	const mayAttempt = (ep: Episode): boolean => {
		if (episode !== ep || ep.phase !== "reconnecting" || ep.closing)
			return false;
		if (overdue(ep) || automaticOff(ep)) {
			if (!ep.inFlight) expire(ep);
			return false;
		}
		return !deps.isStreaming();
	};

	/** True when the edge started an attempt. */
	const onEdge = (ep: Episode): boolean => {
		if (ep.inFlight) {
			if (episode === ep) ep.edgePending = true;
			return false;
		}
		if (!mayAttempt(ep)) return false;
		const fresh = deps
			.linkSources()
			.some((source) => !ep.lastSources.has(source));
		if (!fresh) return false;
		const spaced = ep.lastAttemptEndedAt + EDGE_SPACING_MS;
		if (deps.now() < spaced) {
			// A new link may skip the backoff, not the spacing.
			ep.nextAt = Math.min(ep.nextAt, spaced);
			arm(ep);
			return false;
		}
		attempt(ep);
		return true;
	};

	const onTimer = (ep: Episode) => {
		if (episode !== ep) return;
		ep.cancelTimer = undefined;
		if (ep.inFlight || !mayAttempt(ep)) return;
		if (deps.now() >= nextDue(ep)) attempt(ep);
		else arm(ep);
	};

	const onDeadline = (ep: Episode) => {
		if (episode !== ep || ep.phase !== "reconnecting") return;
		ep.cancelDeadline = undefined;
		if (ep.inFlight) {
			// The attempt that is running decides: back, or the end state.
			ep.closing = true;
			ep.cancelTimer?.();
			ep.cancelTimer = undefined;
			deps.log("deadline during an attempt", { attempt: ep.attempts });
			return;
		}
		expire(ep);
	};

	/** Starts retrying in `ep`, for a full window from now. */
	const run = (ep: Episode, immediately: boolean) => {
		const { maxMs } = deps.settings();
		ep.phase = "reconnecting";
		ep.closing = false;
		ep.deadline = deps.now() + maxMs;
		ep.probeMs = Math.min(NO_LINK_PROBE_MS, Math.floor(maxMs / 3));
		ep.endRestart ??= deps.beginRestart();
		ep.removeLinkListener ??= deps.onLinkChange(() => {
			onEdge(ep);
		});
		ep.cancelDeadline?.();
		ep.cancelDeadline = deps.schedule(() => onDeadline(ep), maxMs);
		publish();
		if (ep.inFlight) return;
		if (immediately && deps.linkSources().length > 0 && !deps.isStreaming())
			attempt(ep);
		else arm(ep);
	};

	const open = (): Episode => {
		const ep: Episode = {
			token: deps.token(),
			phase: "reconnecting",
			manual: false,
			reason: "no_link",
			deadline: deps.now(),
			closing: false,
			probeMs: NO_LINK_PROBE_MS,
			attempts: 0,
			failures: 0,
			inFlight: false,
			edgePending: false,
			lastSources: new Set(deps.linkSources()),
			lastAttemptStartedAt: deps.now(),
			lastAttemptEndedAt: deps.now(),
			nextAt: deps.now() + BACKOFF_MIN_MS,
			cancelTimer: undefined,
			cancelDeadline: undefined,
			endRestart: undefined,
			removeLinkListener: undefined,
			removeStopListener: deps.onOperatorStop(() => {
				// The notice goes with the window: the streamer chose to stop.
				if (episode === ep) deps.clearExpired();
				end(ep, "operator stop");
			}),
		};
		episode = ep;
		return ep;
	};

	return {
		/**
		 * A connection restart stopped the stream and its Start did not start it
		 * again. After every link was lost, with the window on, it opens; for any
		 * other failure, or with it off, the end state (the notice with "Keep
		 * trying") stands at once and nothing retries.
		 */
		afterRestartStartFailed(failure: RestartFailure): void {
			if (episode !== undefined || deps.isStreaming()) return;
			const ep = open();
			const noLink = deps.linkSources().length === 0;
			if (!deps.settings().enabled || !(failure.totalLoss || noLink)) {
				deps.log("not reconnecting on its own", {
					enabled: deps.settings().enabled,
					totalLoss: failure.totalLoss,
					noLink,
				});
				expire(ep);
				return;
			}
			deps.log("window opened", { maxMs: deps.settings().maxMs });
			run(ep, false);
		},

		/**
		 * "Keep trying": another full window, both while reconnecting and after
		 * the window ran out. Refused without a current window or with a token
		 * from an earlier run of it.
		 */
		keepTrying(token: string): KeepTryingResult {
			const ep = episode;
			if (ep === undefined || ep.token !== token || deps.isStreaming()) {
				deps.log("keep trying refused", {});
				return "refused";
			}
			const expired = ep.phase === "expired";
			if (expired) {
				deps.clearExpired();
				deps.rearmRestoration();
				ep.failures = 0;
				ep.lastSources = new Set();
				ep.nextAt = deps.now();
			}
			ep.manual = true;
			ep.token = deps.token();
			deps.log("keep trying", { expired });
			run(ep, expired);
			return "reconnecting";
		},

		/** A session committed, by this window or any other start. */
		noteStreamStarted(): void {
			if (episode !== undefined) succeed(episode);
		},

		status,

		/** Tests only. */
		resetForTest(): void {
			if (episode !== undefined) {
				stopTrying(episode);
				endRestart(episode);
				episode.removeStopListener();
			}
			episode = undefined;
		},
	};
}

export type StreamReconnect = ReturnType<typeof createStreamReconnect>;

/** Reads the box's two settings, with the defaults for a config without them. */
export function reconnectSettings(config: {
	readonly auto_reconnect?: boolean | undefined;
	readonly auto_reconnect_max_s?: number | undefined;
}): StreamReconnectSettings {
	const seconds = config.auto_reconnect_max_s ?? RECONNECT_DEFAULT_MAX_S;
	const bounded = Math.min(
		RECONNECT_MAX_MAX_S,
		Math.max(RECONNECT_MIN_MAX_S, Math.round(seconds)),
	);
	return {
		enabled: config.auto_reconnect !== false,
		maxMs:
			(Number.isFinite(bounded) ? bounded : RECONNECT_DEFAULT_MAX_S) * 1000,
	};
}
