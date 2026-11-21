/**
 * Who has to be asked about a network change, and when.
 *
 * A change can cut the connection the person is using on purpose: turning off
 * the hotspot, a modem or the Wi-Fi link they came in on. So the box never
 * assumes a lost connection is a mistake:
 *
 * - ask BEFORE when the change touches the interface this session arrived on,
 *   or when the arrival interface is unknown;
 * - otherwise apply with automatic undo, and ask AFTER (a notice) if the undo
 *   ran because nobody confirmed in time.
 *
 * The arrival interface must come from trusted kernel evidence
 * (network-ingress.ts), never from a destination address or a route lookup.
 *
 * A session without that evidence (relay, tailnet, plain TCP) can never
 * confirm, so asking it to "confirm within 90 s" promises an undo. For those
 * sessions the box also looks at its own route back to the session
 * (network-session-route.ts). That lookup may only make the prompt more
 * specific ("this cuts you via eth0"); it never counts as arrival evidence,
 * never skips the prompt and never confirms. Instead of a confirmation they
 * cannot give, such a session is offered "keep it if the box can still reach
 * the internet": the box itself probes its remote endpoints after the change
 * and keeps the change only if that works (see network-checkpoint.ts).
 */

export type ChangePath = "own" | "other" | "unknown";
/**
 * - undo-automatically: undone unless a new session over the changed path
 *   confirms in time;
 * - keep-if-reachable: undone unless the box itself still reaches its remote
 *   endpoints after the settle time (for sessions that cannot confirm);
 * - keep-change: kept without any undo (deliberate).
 */
export type AskBeforeAnswer =
	| "undo-automatically"
	| "keep-if-reachable"
	| "keep-change";
/**
 * Why the box undid a change, for the ask-after notice:
 * - disconnected: nobody confirmed in time;
 * - unreachable: a keep-if-reachable change lost the box's outside connection;
 * - restart: the network or the box restarted before anyone confirmed;
 * - interrupted: the box restarted while still making the change;
 * - unsaved: the change was confirmed (or kept), but the box restarted before
 *   it reached disk.
 */
export type NoticeReason =
	| "disconnected"
	| "unreachable"
	| "restart"
	| "interrupted"
	| "unsaved";
export type NoticeAnswer = "make-change" | "leave-undone";

/**
 * Default confirmation window, in seconds (NetworkManager owns the timer).
 * Without a confirmation in this time the change is undone.
 */
export const DEFAULT_WINDOW_SECONDS = 90;
/**
 * A change on another path is confirmed by the creator's own connection still
 * working this long after the apply finished. Shorter would let a quick reply
 * beat a cut that takes a few seconds to show (Wi-Fi re-association, routes).
 */
export const DEFAULT_SETTLE_MS = 15_000;
/**
 * A keep-if-reachable change needs this many reachability probes in a row,
 * each at least `REACHABILITY_PROBE_GAP_MS` after the previous one, all after
 * the settle time. One lucky probe on a link that is still going down is not
 * enough.
 */
export const REACHABILITY_PROBES_NEEDED = 2;
export const REACHABILITY_PROBE_GAP_MS = 5_000;

/**
 * What the box can tell about its own route back to a session without
 * arrival evidence. Route evidence is a prediction, not proof: it is used only
 * to say more precisely that a change will cut the session.
 */
export interface SessionRoute {
	/**
	 * Interfaces the session's path depends on: the interface the box's replies
	 * leave through, or, for a tunnel or a local proxy, every uplink that holds
	 * a default route (the tunnel can ride any of them).
	 */
	readonly carriers: readonly string[];
	/** The session rides a tunnel (tailnet, VPN) or a local proxy. */
	readonly tunnel: boolean;
	/**
	 * Positive evidence of a transport the box can test for this requester:
	 * the peer address is a tailnet address and the reply leaves through the
	 * tailnet interface. Only then is keep-if-reachable offered.
	 */
	readonly tailnetPeer?: string;
}

/**
 * How a change meets the session's path, before anything is applied:
 * - cuts: it touches the only path the session has;
 * - may-cut: it touches one of several paths (a tunnel may move to another);
 * - clear: trusted arrival evidence shows it does not touch the session;
 * - unknown: no evidence either way.
 * Only trusted arrival evidence can yield "clear"; route evidence can only
 * yield cuts, may-cut or unknown.
 */
export type CutVerdict = "cuts" | "may-cut" | "clear" | "unknown";

export function predictCut(
	devices: readonly string[],
	ingress: string | undefined,
	route: SessionRoute | undefined,
): { readonly verdict: CutVerdict; readonly via: string | undefined } {
	if (ingress)
		return devices.includes(ingress)
			? { verdict: "cuts", via: ingress }
			: { verdict: "clear", via: undefined };
	const carriers = route?.carriers ?? [];
	const hit = carriers.filter((carrier) => devices.includes(carrier));
	if (!hit.length) return { verdict: "unknown", via: undefined };
	return {
		verdict: hit.length === carriers.length ? "cuts" : "may-cut",
		via: hit[0],
	};
}

export function classifyPath(
	devices: readonly string[],
	ingress: string | undefined,
): ChangePath {
	if (!ingress) return "unknown";
	return devices.includes(ingress) ? "own" : "other";
}

/** Unknown is treated like own: one tap when unsure beats a silent lock-out. */
export function needsAskBefore(path: ChangePath, deliberate: boolean): boolean {
	return deliberate || path !== "other";
}

/** Catalog keys the UI resolves; the backend emits them as data. */
export const CHANGE_SAFETY_COPY = {
	askBeforeOwn: "network.changeSafety.askBefore.own",
	askBeforeUnknown: "network.changeSafety.askBefore.unknown",
	askBeforeRouteCuts: "network.changeSafety.askBefore.routeCuts",
	askBeforeRouteMayCut: "network.changeSafety.askBefore.routeMayCut",
	askBeforeUndo: "network.changeSafety.askBefore.undo",
	askBeforeUndoVia: "network.changeSafety.askBefore.undoVia",
	askBeforeUndoLocal: "network.changeSafety.askBefore.undoLocal",
	askBeforeReachable: "network.changeSafety.askBefore.reachable",
	askBeforeKeep: "network.changeSafety.askBefore.keep",
	askBeforeKeepRemote: "network.changeSafety.askBefore.keepRemote",
	askBeforeLive: "network.changeSafety.askBefore.live",
	confirmPrompt: "network.changeSafety.confirm.prompt",
	confirmAction: "network.changeSafety.confirm.action",
	confirmReachable: "network.changeSafety.confirm.reachable",
	noticeDisconnected: "network.changeSafety.notice.disconnected",
	noticeUnreachable: "network.changeSafety.notice.unreachable",
	noticeRestart: "network.changeSafety.notice.restart",
	noticeInterrupted: "network.changeSafety.notice.interrupted",
	noticeUnsaved: "network.changeSafety.notice.unsaved",
	noticeMake: "network.changeSafety.notice.make",
	noticeLeave: "network.changeSafety.notice.leave",
	keptUndo: "network.changeSafety.kept.undo",
	summaryEthernetRole: "network.changeSafety.summary.ethernetRole",
} as const;

export interface AskBeforeAction<A extends AskBeforeAnswer> {
	readonly answer: A;
	readonly labelKey: string;
}

/**
 * The ask-before step. There is no preselected answer and no toggle:
 *
 * - `primary` is the normal, protected action. For a session that can confirm
 *   from the changed path it is "undone unless confirmed within `seconds`".
 *   For a session that cannot (no arrival evidence), it is "kept only if the
 *   box still reaches the internet after `settleSeconds`" when the box has
 *   endpoints to probe, else "undone unless someone connected locally
 *   confirms", which is honest about who can confirm;
 * - `alternative`, for sessions that cannot confirm, is the other protected
 *   action (confirm-or-undo by someone on the changed path);
 * - `deliberate` keeps the change with no undo. It is a secondary action, never
 *   focused first and never bound to Enter. Its label states the consequence,
 *   so a keyboard or screen-reader user hears it as the button's name before
 *   they can activate it. A session that cannot see its own path is never told
 *   it will be disconnected; it is told there is no undo.
 *
 * Nothing is applied until one of them is chosen explicitly.
 */
export interface AskBeforePrompt {
	readonly kind: "ask-before";
	readonly messageKey: string;
	/** Interface name shown in the message; absent when unknown. */
	readonly via: string | undefined;
	/** How the change meets the session's path (never "clear" here). */
	readonly cut: Exclude<CutVerdict, "clear">;
	/** Whether this person can confirm from the changed path afterwards. */
	readonly canConfirm: boolean;
	readonly seconds: number;
	readonly settleSeconds: number;
	/** Set while the box is live: an undo at the deadline can drop the stream. */
	readonly liveKey?: string;
	readonly primary: AskBeforeAction<"undo-automatically" | "keep-if-reachable">;
	readonly alternative?: AskBeforeAction<"undo-automatically">;
	readonly deliberate: AskBeforeAction<"keep-change">;
}

const ASK_BEFORE_ANSWERS: readonly AskBeforeAnswer[] = [
	"undo-automatically",
	"keep-if-reachable",
	"keep-change",
];

/** Answers arrive from the UI as data; anything else is not an answer. */
export function isAskBeforeAnswer(value: unknown): value is AskBeforeAnswer {
	return ASK_BEFORE_ANSWERS.includes(value as AskBeforeAnswer);
}

export interface AskBeforeInput {
	readonly path: ChangePath;
	readonly ingress: string | undefined;
	readonly devices: readonly string[];
	readonly route?: SessionRoute | undefined;
	readonly seconds: number;
	readonly settleSeconds?: number;
	/**
	 * The box can test this requester's own access path after the change
	 * (network-reachability.ts), so keep-if-reachable can be offered.
	 */
	readonly reachability?: boolean;
	readonly live?: boolean;
}

/** The answers a prompt offers; any other answer to it is refused. */
export function offeredAnswers(prompt: AskBeforePrompt): AskBeforeAnswer[] {
	return [
		prompt.primary.answer,
		...(prompt.alternative ? [prompt.alternative.answer] : []),
		prompt.deliberate.answer,
	];
}

export function askBeforePrompt(input: AskBeforeInput): AskBeforePrompt {
	const { path, ingress, seconds } = input;
	const settleSeconds =
		input.settleSeconds ?? Math.round(DEFAULT_SETTLE_MS / 1000);
	const own = path === "own" && ingress !== undefined;
	const live = input.live ? { liveKey: CHANGE_SAFETY_COPY.askBeforeLive } : {};
	if (own) {
		return {
			kind: "ask-before",
			messageKey: CHANGE_SAFETY_COPY.askBeforeOwn,
			via: ingress,
			cut: "cuts",
			canConfirm: true,
			seconds,
			settleSeconds,
			...live,
			primary: {
				answer: "undo-automatically",
				labelKey: CHANGE_SAFETY_COPY.askBeforeUndo,
			},
			deliberate: {
				answer: "keep-change",
				labelKey: CHANGE_SAFETY_COPY.askBeforeKeep,
			},
		};
	}
	// No trusted arrival evidence (a deliberate re-apply from another path
	// also lands here only when `ingress` is set and differs: treat that like
	// an unknown path, since the question is about who can confirm).
	const { verdict, via } = ingress
		? { verdict: "unknown" as const, via: undefined }
		: predictCut(input.devices, undefined, input.route);
	const cut = verdict === "clear" ? "unknown" : verdict;
	const messageKey =
		cut === "cuts"
			? CHANGE_SAFETY_COPY.askBeforeRouteCuts
			: cut === "may-cut"
				? CHANGE_SAFETY_COPY.askBeforeRouteMayCut
				: CHANGE_SAFETY_COPY.askBeforeUnknown;
	const undoLocal: AskBeforeAction<"undo-automatically"> = {
		answer: "undo-automatically",
		labelKey: via
			? CHANGE_SAFETY_COPY.askBeforeUndoVia
			: CHANGE_SAFETY_COPY.askBeforeUndoLocal,
	};
	// Another known path (a deliberate re-apply from a session whose arrival
	// interface is not touched) can still confirm through its own connection.
	const canConfirm = path === "other";
	return {
		kind: "ask-before",
		messageKey,
		via,
		cut,
		canConfirm,
		seconds,
		settleSeconds,
		...live,
		...(input.reachability && !canConfirm
			? {
					primary: {
						answer: "keep-if-reachable" as const,
						labelKey: CHANGE_SAFETY_COPY.askBeforeReachable,
					},
					alternative: undoLocal,
				}
			: {
					primary: canConfirm
						? {
								answer: "undo-automatically" as const,
								labelKey: CHANGE_SAFETY_COPY.askBeforeUndo,
							}
						: undoLocal,
				}),
		// Only a session the change provably cuts is told "disconnect me".
		deliberate: {
			answer: "keep-change",
			labelKey: CHANGE_SAFETY_COPY.askBeforeKeepRemote,
		},
	};
}

const NOTICE_COPY: Record<NoticeReason, string> = {
	disconnected: CHANGE_SAFETY_COPY.noticeDisconnected,
	unreachable: CHANGE_SAFETY_COPY.noticeUnreachable,
	restart: CHANGE_SAFETY_COPY.noticeRestart,
	interrupted: CHANGE_SAFETY_COPY.noticeInterrupted,
	unsaved: CHANGE_SAFETY_COPY.noticeUnsaved,
};

export function noticeMessageKey(reason: NoticeReason): string {
	return NOTICE_COPY[reason] ?? CHANGE_SAFETY_COPY.noticeRestart;
}
