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
 */

export type ChangePath = "own" | "other" | "unknown";
export type AskBeforeAnswer = "undo-automatically" | "keep-change";
export type NoticeReason = "disconnected" | "restart";
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
	askBeforeUndo: "network.changeSafety.askBefore.undo",
	askBeforeKeep: "network.changeSafety.askBefore.keep",
	confirmPrompt: "network.changeSafety.confirm.prompt",
	confirmAction: "network.changeSafety.confirm.action",
	noticeDisconnected: "network.changeSafety.notice.disconnected",
	noticeRestart: "network.changeSafety.notice.restart",
	noticeMake: "network.changeSafety.notice.make",
	noticeLeave: "network.changeSafety.notice.leave",
	keptUndo: "network.changeSafety.kept.undo",
} as const;

export interface AskBeforeAction<A extends AskBeforeAnswer> {
	readonly answer: A;
	readonly labelKey: string;
}

/**
 * The ask-before step. There is no preselected answer and no toggle:
 *
 * - `primary` is the normal action, the protected change: it is made and undone
 *   unless someone confirms within `seconds`;
 * - `deliberate` keeps a disconnecting change. It is a secondary action, never
 *   focused first and never bound to Enter. Its label states the consequence,
 *   so a keyboard or screen-reader user hears it as the button's name before
 *   they can activate it.
 *
 * Nothing is applied until one of the two is chosen explicitly.
 */
export interface AskBeforePrompt {
	readonly kind: "ask-before";
	readonly messageKey: string;
	/** Interface name shown in the message; absent when unknown. */
	readonly via: string | undefined;
	readonly seconds: number;
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

export function askBeforePrompt(
	path: ChangePath,
	ingress: string | undefined,
	seconds: number,
): AskBeforePrompt {
	const own = path === "own" && ingress !== undefined;
	return {
		kind: "ask-before",
		messageKey: own
			? CHANGE_SAFETY_COPY.askBeforeOwn
			: CHANGE_SAFETY_COPY.askBeforeUnknown,
		via: own ? ingress : undefined,
		seconds,
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

export function noticeMessageKey(reason: NoticeReason): string {
	return reason === "restart"
		? CHANGE_SAFETY_COPY.noticeRestart
		: CHANGE_SAFETY_COPY.noticeDisconnected;
}
