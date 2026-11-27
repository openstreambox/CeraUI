import { setup } from "../setup.ts";
import { notificationBroadcast } from "../ui/notifications.ts";
import {
	type DisruptiveRefusalReason,
	isDisruptiveActionPending,
} from "./disruptive-action-reservation.ts";
import { getOwnStreamState } from "./stream-liveness-source.ts";

const CLIENT_TRAFFIC = {
	text: "This action was not run. Try again when the box’s own stream and connected devices’ stream traffic are idle and no update is in progress.",
	key: "notifications.disruptiveActionClientTraffic",
} as const;
// Unknown is not a stream: the box is idle or still finding out, so the notice
// says which part is still being checked and what helps. Stop settles only an
// unconfirmed stream of the box's own; client traffic and the startup
// reconciliation can only be waited out, and a phone-only box has no Stop
// Stream to offer. The part is read from the box's own session; the decision
// itself is made before this notice and is not changed by it.
const CARRYING_CHECKING = {
	text: "This action was not run. The box is still checking whether connected devices send stream traffic through it. Try again in a few minutes.",
	key: "notifications.disruptiveActionCarryingChecking",
} as const;
const STREAM_UNCONFIRMED = {
	text: "This action was not run. The box cannot yet confirm that its own stream has stopped. Try again in a moment. If it keeps refusing, use Stop Stream on the Live page first.",
	key: "notifications.disruptiveActionStreamUnconfirmed",
} as const;
const STILL_CHECKING = {
	text: "This action was not run. The box is still checking its own state. Try again in a moment.",
	key: "notifications.disruptiveActionStillChecking",
} as const;
const BUSY = {
	text: "Device is busy, try again in a moment",
	key: "network.os.deviceBusy",
} as const;

export function notifyDisruptiveActionRefused(
	reason?: DisruptiveRefusalReason,
): void {
	const unknown = reason === "stream_liveness_unknown";
	const message =
		reason === "update_in_progress" && isDisruptiveActionPending()
			? BUSY
			: unknown
				? unknownLivenessMessage()
				: CLIENT_TRAFFIC;
	notificationBroadcast(
		"disruptive_action_refused",
		"warning",
		message.text,
		10,
		false,
		true,
		// The unknown copy tells client traffic apart from the box's own stream,
		// which only signed-in clients see elsewhere (the carrying status).
		unknown,
		message.key,
	);
}

function unknownLivenessMessage():
	| typeof CARRYING_CHECKING
	| typeof STILL_CHECKING
	| typeof STREAM_UNCONFIRMED {
	const own = getOwnStreamState();
	if (own === "idle") return CARRYING_CHECKING;
	if (own === "reconciling" || setup.engine === "none") return STILL_CHECKING;
	return STREAM_UNCONFIRMED;
}
