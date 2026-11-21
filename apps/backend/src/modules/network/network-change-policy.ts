/**
 * Who has to be asked about a network change, and who may keep it.
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
 * Who may keep a change (the confirm rule): the person who made it, proving
 * they can still reach the box after it. Proof is a NEW connection from the
 * same browser login (auth token), to the same UI address (`Origin` and `Host`
 * of the WebSocket upgrade), opened at least the settle time after the change,
 * that presents the one-time code the page minted for that change, before the
 * deadline. The arrival interface is not required; it is recorded and shown.
 * The requester's existing connection may confirm only when front-door
 * evidence shows the change did not touch its own path. Nothing else keeps a
 * change: no reachability probe, no other login, no tab without the code.
 *
 * The arrival interface, where used (ask-before, the "other path" exception,
 * the label), comes from trusted kernel evidence (network-ingress.ts), never
 * from a destination address or a route lookup. A route lookup
 * (network-session-route.ts) may only make the prompt more specific.
 */

export type ChangePath = "own" | "other" | "unknown";
/**
 * - undo-automatically: undone unless the requester confirms in time;
 * - keep-change: kept without any undo (deliberate).
 */
export type AskBeforeAnswer = "undo-automatically" | "keep-change";
/**
 * Why the box undid a change, for the ask-after notice:
 * - disconnected: nobody confirmed in time;
 * - restart: the network or the box restarted before anyone confirmed;
 * - interrupted: the box restarted while still making the change;
 * - unsaved: the change was confirmed (or kept), but the box restarted before
 *   it reached disk.
 */
export type NoticeReason =
	| "disconnected"
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
 * A confirmation must come from a connection opened at least this long after
 * the apply finished (or, on another path, arrive this long after it). Shorter
 * would let a quick reconnect beat a cut that takes a few seconds to show
 * (Wi-Fi re-association, routes, DHCP).
 */
export const DEFAULT_SETTLE_MS = 15_000;

/**
 * The one-time code: 32 random bytes in base64url, minted by the page before
 * it sends the request (the reply may never arrive when the change cuts the
 * socket). The box stores only its hash.
 */
export const CONFIRMATION_CODE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Whether a session can ever confirm: a browser login with a token and the UI
 * address it reached the box at. One predicate for the prompt (what it
 * offers) and the transaction (what it will accept).
 */
export function sessionCanConfirm(session: {
	readonly authenticated: boolean;
	readonly tokenHash?: string | undefined;
	readonly origin?: string | undefined;
	readonly host?: string | undefined;
}): boolean {
	return (
		session.authenticated &&
		!!session.tokenHash &&
		!!session.origin &&
		!!session.host
	);
}

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
	askBeforeUndoNoConfirm: "network.changeSafety.askBefore.undoNoConfirm",
	askBeforeKeep: "network.changeSafety.askBefore.keep",
	askBeforeKeepRemote: "network.changeSafety.askBefore.keepRemote",
	askBeforeLive: "network.changeSafety.askBefore.live",
	confirmPrompt: "network.changeSafety.confirm.prompt",
	confirmWaiting: "network.changeSafety.confirm.waiting",
	confirmAction: "network.changeSafety.confirm.action",
	confirmedVia: "network.changeSafety.confirmed.via",
	confirmedRemote: "network.changeSafety.confirmed.remote",
	noticeDisconnected: "network.changeSafety.notice.disconnected",
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
 * - `primary` is the normal, protected action: undone unless the requester
 *   confirms within `seconds`. For a session that can confirm (a browser
 *   login, see `sessionCanConfirm`) the label says this browser confirms; for
 *   one that can't (a script, the control channel), it says the change is
 *   undone after `seconds` and this connection can't confirm it;
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
	/** Whether this session can confirm the change afterwards. */
	readonly canConfirm: boolean;
	readonly seconds: number;
	readonly settleSeconds: number;
	/** Set while the box is live: an undo at the deadline can drop the stream. */
	readonly liveKey?: string;
	readonly primary: AskBeforeAction<"undo-automatically">;
	readonly deliberate: AskBeforeAction<"keep-change">;
}

const ASK_BEFORE_ANSWERS: readonly AskBeforeAnswer[] = [
	"undo-automatically",
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
	/** `sessionCanConfirm` of the requesting session. */
	readonly canConfirm: boolean;
	readonly live?: boolean;
}

export function askBeforePrompt(input: AskBeforeInput): AskBeforePrompt {
	const { path, ingress, seconds, canConfirm } = input;
	const settleSeconds =
		input.settleSeconds ?? Math.round(DEFAULT_SETTLE_MS / 1000);
	const live = input.live ? { liveKey: CHANGE_SAFETY_COPY.askBeforeLive } : {};
	const primary: AskBeforeAction<"undo-automatically"> = {
		answer: "undo-automatically",
		labelKey: canConfirm
			? CHANGE_SAFETY_COPY.askBeforeUndo
			: CHANGE_SAFETY_COPY.askBeforeUndoNoConfirm,
	};
	if (path === "own" && ingress !== undefined) {
		return {
			kind: "ask-before",
			messageKey: CHANGE_SAFETY_COPY.askBeforeOwn,
			via: ingress,
			cut: "cuts",
			canConfirm,
			seconds,
			settleSeconds,
			...live,
			primary,
			deliberate: {
				answer: "keep-change",
				labelKey: CHANGE_SAFETY_COPY.askBeforeKeep,
			},
		};
	}
	// No trusted arrival evidence, or a deliberate re-apply from another
	// known path: the route may only make the message more specific.
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
	return {
		kind: "ask-before",
		messageKey,
		via,
		cut,
		canConfirm,
		seconds,
		settleSeconds,
		...live,
		primary,
		// Only a session the change provably cuts is told "disconnect me".
		deliberate: {
			answer: "keep-change",
			labelKey: CHANGE_SAFETY_COPY.askBeforeKeepRemote,
		},
	};
}

const NOTICE_COPY: Record<NoticeReason, string> = {
	disconnected: CHANGE_SAFETY_COPY.noticeDisconnected,
	restart: CHANGE_SAFETY_COPY.noticeRestart,
	interrupted: CHANGE_SAFETY_COPY.noticeInterrupted,
	unsaved: CHANGE_SAFETY_COPY.noticeUnsaved,
};

export function noticeMessageKey(reason: NoticeReason): string {
	return NOTICE_COPY[reason] ?? CHANGE_SAFETY_COPY.noticeRestart;
}

/** The label for a kept change: the interface it was confirmed over, or remote. */
export function confirmedLabelKey(via: string | null): string {
	return via === null
		? CHANGE_SAFETY_COPY.confirmedRemote
		: CHANGE_SAFETY_COPY.confirmedVia;
}
