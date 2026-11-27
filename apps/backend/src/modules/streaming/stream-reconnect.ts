/*
  RECONNECTING A STREAM THAT LOST EVERY LINK.

  A connection restart (connection-restart.ts) stops the session and starts it
  again. When every link is gone, that Start fails at once
  (`no_available_network_connections`), and on its own nothing would try again
  when a link comes back. This window does: until the streamer presses Stop, it
  starts the stream again for up to the box's maximum retry time (default two
  minutes, `auto_reconnect_max_s`), and says "Stream reconnected" when it is
  back. The setting `auto_reconnect: false` turns the window off.

  WHEN IT TRIES. On an edge, not on a clock: a link source the last attempt did
  not have (netif `sourcesChange`, which a Wi-Fi carrier mark clearing and a
  modem bearer getting its address both raise, or a committed USB-net scan)
  starts an attempt at once, at most one per EDGE_SPACING_MS. A Start that fails
  while links are up backs off (BACKOFF_MIN_MS doubling to BACKOFF_MAX_MS). With
  no link to try, a quiet attempt runs at most once per NO_LINK_PROBE_MS, in case
  an edge was missed. One attempt runs at a time and one timer is armed.

  STOP WINS. An operator Stop ends the window at once, wherever it is, including
  during an attempt (the session orchestrator cancels that Start) and after the
  window ran out. The window never retries after a Stop.

  WHAT EVERY SURFACE SEES. While the window runs, `connection_restarting` stays
  up (the box is reconnecting, the receiver shows its BRB scene), and
  `stream_reconnect` says `reconnecting` with the time left. When the window
  runs out, nothing retries: `stream_reconnect` says `expired` with what was
  missing, the persistent restart-failed notice offers "Keep trying", and stream
  restoration is disarmed, so a later reboot does not bring the stream back on
  its own either. "Keep trying" (the notice or the Live banner) restarts the full
  window, in either state (A1004 A).
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

export type StreamReconnectDeps<Conn> = {
	readonly now: () => number;
	/** Runs `run` after `ms`; the returned function cancels it. */
	readonly schedule: (run: () => void, ms: number) => () => void;
	readonly token: () => string;
	readonly settings: () => StreamReconnectSettings;
	/** The link sources a Start would bond now. */
	readonly linkSources: () => readonly string[];
	/** Calls back when the bond's link sources may have changed. */
	readonly onLinkChange: (listener: () => void) => () => void;
	readonly onOperatorStop: (listener: () => void) => () => void;
	readonly isStreaming: () => boolean;
	/** Raises `connection_restarting`; the returned function lowers it, once. */
	readonly beginRestart: () => () => void;
	/** A full, supervised Start of the session that stopped. Never rejects. */
	readonly start: (conn: Conn) => Promise<{ readonly result: string }>;
	readonly publish: (status: StreamReconnectStatus | null) => void;
	readonly announceReconnected: () => void;
	readonly announceExpired: (
		reason: StreamReconnectExpiry,
		token: string,
	) => void;
	readonly clearExpired: () => void;
	readonly disarmRestoration: () => void;
	readonly log: (event: string, meta: Record<string, unknown>) => void;
};

export type KeepTryingResult = "reconnecting" | "refused";

type Episode<Conn> = {
	readonly token: string;
	conn: Conn;
	phase: "reconnecting" | "expired";
	/** Set when the window ran out: what was missing then. */
	reason: StreamReconnectExpiry;
	deadline: number;
	attempts: number;
	failures: number;
	inFlight: boolean;
	edgePending: boolean;
	lastSources: ReadonlySet<string>;
	lastAttemptStartedAt: number;
	lastAttemptEndedAt: number;
	nextAt: number;
	cancelTimer: (() => void) | undefined;
	endRestart: (() => void) | undefined;
	removeLinkListener: (() => void) | undefined;
	readonly removeStopListener: () => void;
};

export function createStreamReconnect<Conn>(deps: StreamReconnectDeps<Conn>) {
	let episode: Episode<Conn> | undefined;

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

	const stopRetrying = (ep: Episode<Conn>) => {
		ep.cancelTimer?.();
		ep.cancelTimer = undefined;
		ep.removeLinkListener?.();
		ep.removeLinkListener = undefined;
		ep.endRestart?.();
		ep.endRestart = undefined;
	};

	/** Ends the episode, in either phase; no later edge or timer acts on it. */
	const end = (ep: Episode<Conn>, why: string) => {
		if (episode !== ep) return;
		episode = undefined;
		stopRetrying(ep);
		ep.removeStopListener();
		deps.log("ended", { why, attempts: ep.attempts });
		publish();
	};

	const nextDue = (ep: Episode<Conn>): number =>
		deps.linkSources().length > 0
			? ep.nextAt
			: Math.max(ep.nextAt, ep.lastAttemptStartedAt + NO_LINK_PROBE_MS);

	const arm = (ep: Episode<Conn>) => {
		ep.cancelTimer?.();
		const at = Math.min(nextDue(ep), ep.deadline);
		ep.cancelTimer = deps.schedule(
			() => onTimer(ep),
			Math.max(0, at - deps.now()),
		);
	};

	const expire = (ep: Episode<Conn>) => {
		if (episode !== ep || ep.phase !== "reconnecting") return;
		ep.phase = "expired";
		ep.reason = deps.linkSources().length > 0 ? "start_failed" : "no_link";
		stopRetrying(ep);
		deps.log("window ran out", { attempts: ep.attempts, reason: ep.reason });
		// Nothing retries now, a reboot included.
		deps.disarmRestoration();
		deps.announceExpired(ep.reason, ep.token);
		publish();
	};

	const succeed = (ep: Episode<Conn>) => {
		if (episode !== ep) return;
		const wasReconnecting = ep.phase === "reconnecting";
		end(ep, "reconnected");
		if (wasReconnecting) deps.announceReconnected();
	};

	const attempt = (ep: Episode<Conn>) => {
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
			.start(ep.conn)
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
				if (deps.now() >= ep.deadline || !deps.settings().enabled) {
					expire(ep);
					return;
				}
				if (ep.edgePending && onEdge(ep)) return;
				arm(ep);
			});
	};

	/** True when the edge started an attempt. */
	const onEdge = (ep: Episode<Conn>): boolean => {
		if (episode !== ep || ep.phase !== "reconnecting") return false;
		if (deps.isStreaming()) return false;
		if (ep.inFlight) {
			ep.edgePending = true;
			return false;
		}
		const fresh = deps
			.linkSources()
			.some((source) => !ep.lastSources.has(source));
		if (!fresh) return false;
		const now = deps.now();
		const spaced = ep.lastAttemptEndedAt + EDGE_SPACING_MS;
		if (now < spaced) {
			// A new link may skip the backoff, not the spacing.
			ep.nextAt = Math.min(ep.nextAt, spaced);
			arm(ep);
			return false;
		}
		attempt(ep);
		return true;
	};

	const onTimer = (ep: Episode<Conn>) => {
		if (episode !== ep || ep.phase !== "reconnecting") return;
		ep.cancelTimer = undefined;
		if (ep.inFlight) return;
		if (deps.now() >= ep.deadline || !deps.settings().enabled) {
			expire(ep);
			return;
		}
		if (deps.isStreaming()) {
			arm(ep);
			return;
		}
		if (deps.now() >= nextDue(ep)) attempt(ep);
		else arm(ep);
	};

	/** Starts retrying in `ep`, for a full window from now. */
	const run = (ep: Episode<Conn>, immediately: boolean) => {
		ep.phase = "reconnecting";
		ep.deadline = deps.now() + deps.settings().maxMs;
		ep.endRestart ??= deps.beginRestart();
		ep.removeLinkListener ??= deps.onLinkChange(() => {
			onEdge(ep);
		});
		publish();
		if (immediately && !ep.inFlight && deps.linkSources().length > 0)
			attempt(ep);
		else if (!ep.inFlight) arm(ep);
	};

	const open = (conn: Conn): Episode<Conn> => {
		const ep: Episode<Conn> = {
			token: deps.token(),
			conn,
			phase: "reconnecting",
			reason: "no_link",
			deadline: deps.now(),
			attempts: 0,
			failures: 0,
			inFlight: false,
			edgePending: false,
			lastSources: new Set(deps.linkSources()),
			lastAttemptStartedAt: deps.now(),
			lastAttemptEndedAt: deps.now(),
			nextAt: deps.now() + BACKOFF_MIN_MS,
			cancelTimer: undefined,
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
		 * again. With the window on, it opens; with it off, the expired state
		 * (the notice with "Keep trying") stands at once and nothing retries.
		 */
		afterRestartStartFailed(conn: Conn): void {
			if (episode !== undefined || deps.isStreaming()) return;
			const ep = open(conn);
			if (!deps.settings().enabled) {
				deps.log("reconnect is off", {});
				expire(ep);
				return;
			}
			deps.log("window opened", { maxMs: deps.settings().maxMs });
			run(ep, false);
		},

		/**
		 * "Keep trying": another full window, both while reconnecting and after
		 * the window ran out. Refused without a current window or with a token
		 * from an earlier one.
		 */
		keepTrying(token: string, conn: Conn): KeepTryingResult {
			const ep = episode;
			if (ep === undefined || ep.token !== token || deps.isStreaming()) {
				deps.log("keep trying refused", {});
				return "refused";
			}
			ep.conn = conn;
			const expired = ep.phase === "expired";
			if (expired) {
				deps.clearExpired();
				ep.failures = 0;
				ep.lastSources = new Set();
				ep.nextAt = deps.now();
			}
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
				stopRetrying(episode);
				episode.removeStopListener();
			}
			episode = undefined;
		},
	};
}

export type StreamReconnect<Conn> = ReturnType<
	typeof createStreamReconnect<Conn>
>;

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
