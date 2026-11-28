/**
 * A Stop Stream the operator pressed while a new socket was being signed in.
 *
 * The client refuses to replay it (session-gate-policy.ts). Its owner keeps
 * this one pending intent, fenced to the session it was made in, and sends it
 * ONCE after the re-auth succeeds, and only if the device still reports a
 * stream. Newer requests join it. It survives a stalled socket being replaced.
 * It is dropped, and the operator told, when the session ends first or when it
 * outlives `STOP_INTENT_LIFETIME_MS`: a Stop pressed before an outage must not
 * end a stream that is live when the tab finally comes back.
 *
 * Limit: `streaming.stop` names no stream. If another tab stopped and restarted
 * the stream within that lifetime, the late Stop stops the restarted stream.
 * The device coalesces stops of one stream and answers "stopped" when idle.
 *
 * Kept apart from subscriptions.svelte.ts so the Stop caller (SystemHelper)
 * reaches it synchronously: an asynchronous hop could let the session end
 * before the intent exists, losing the notice.
 */
import { rpcClient } from "$lib/rpc/client";
import { NotSentError } from "$lib/rpc/rpc-error";
import { getSessionToken } from "$lib/stores/auth-status.svelte";
import { push as pushNotification } from "$lib/stores/notifications.svelte";

/**
 * How long a pending Stop may wait for the session: one prompt re-auth plus the
 * stalled sockets before the tab gives up (three timeouts at the 30 s RPC
 * budget with growing backoff), rounded up. Longer than that, the stream that
 * is live when the session returns may well be a different one.
 */
const STOP_INTENT_LIFETIME_MS = 120_000;

interface StopIntent {
	session: string;
	/** Monotonic time after which it is dropped instead of sent. */
	deadline: number;
	expiry: ReturnType<typeof setTimeout>;
	send: () => Promise<unknown>;
	resolve: () => void;
	reject: (error: Error) => void;
	promise: Promise<void>;
}

let stopIntent: StopIntent | undefined;

/** Tell the operator a Stop they pressed was not sent. */
export function noticeStopNotSent(): void {
	pushNotification({
		name: "stop-not-sent",
		type: "error",
		key: "notifications.stopNotSent",
		msg: "The stream may still be live: Stop was not sent. Check the stream and stop it again.",
		is_dismissable: true,
		is_persistent: false,
		duration: 10,
	});
}

/**
 * Keep a Stop for after the re-auth. `send` dispatches it; the newest request's
 * `send` is the one used. Rejects with `NotSentError("signed-out")`, after the
 * notice, when the session ends or the lifetime passes first.
 */
export function stopOnceSignedIn(send: () => Promise<unknown>): Promise<void> {
	const session = getSessionToken();
	if (session === null) {
		noticeStopNotSent();
		return Promise.reject(new NotSentError("signed-out"));
	}
	if (stopIntent === undefined || stopIntent.session !== session) {
		dropStopIntent();
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const promise = new Promise<void>((ok, fail) => {
			resolve = ok;
			reject = fail;
		});
		stopIntent = {
			session,
			send,
			resolve,
			reject,
			promise,
			deadline: performance.now() + STOP_INTENT_LIFETIME_MS,
			expiry: setTimeout(dropStopIntent, STOP_INTENT_LIFETIME_MS),
		};
	} else {
		stopIntent.send = send;
	}
	return stopIntent.promise;
}

/**
 * The session is back on a signed-in socket: send the pending Stop once, if
 * `deviceStillStreams` (the caller's view of fresh device state).
 */
export function flushStopIntent(deviceStillStreams: boolean): void {
	const intent = stopIntent;
	if (intent === undefined || rpcClient.isAwaitingSignIn()) return;
	// Checked again here: a throttled tab may run this before the expiry timer.
	if (
		intent.session !== getSessionToken() ||
		performance.now() >= intent.deadline
	) {
		dropStopIntent();
		return;
	}
	stopIntent = undefined;
	clearTimeout(intent.expiry);
	if (!deviceStillStreams) {
		intent.resolve();
		return;
	}
	intent.send().then(() => intent.resolve(), intent.reject);
}

/** The session ended or the lifetime passed before the Stop could be sent. */
export function dropStopIntent(): void {
	const intent = stopIntent;
	if (intent === undefined) return;
	stopIntent = undefined;
	clearTimeout(intent.expiry);
	intent.reject(new NotSentError("signed-out"));
	noticeStopNotSent();
}
