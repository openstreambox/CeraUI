import { notificationBroadcast } from "../ui/notifications.ts";
import { getCarryingLiveness } from "./carrying.ts";
import {
	type DisruptiveRefusalReason,
	isDisruptiveActionPending,
} from "./disruptive-action-reservation.ts";

const CLIENT_TRAFFIC = {
	text: "This action was not run. Try again when the box’s own stream and connected devices’ stream traffic are idle and no update is in progress.",
	key: "notifications.disruptiveActionClientTraffic",
} as const;
// Unknown is not a stream: the box is idle or still finding out, so it says
// which part is still checking and what helps. Stop settles only an
// unconfirmed stream of the box's own; client traffic can only be waited out.
const CARRYING_CHECKING = {
	text: "This action was not run. The box is still checking whether connected devices send stream traffic through it. Try again in a few minutes.",
	key: "notifications.disruptiveActionCarryingChecking",
} as const;
const STREAM_UNCONFIRMED = {
	text: "This action was not run. The box cannot yet confirm that its own stream has stopped. Try again in a moment. If it keeps refusing, use Stop Stream on the Live page first.",
	key: "notifications.disruptiveActionStreamUnconfirmed",
} as const;
const BUSY = {
	text: "Device is busy, try again in a moment",
	key: "network.os.deviceBusy",
} as const;

export function notifyDisruptiveActionRefused(
	reason?: DisruptiveRefusalReason,
): void {
	const message =
		reason === "update_in_progress" && isDisruptiveActionPending()
			? BUSY
			: reason === "stream_liveness_unknown"
				? getCarryingLiveness() === "unknown"
					? CARRYING_CHECKING
					: STREAM_UNCONFIRMED
				: CLIENT_TRAFFIC;
	notificationBroadcast(
		"disruptive_action_refused",
		"warning",
		message.text,
		10,
		false,
		true,
		false,
		message.key,
	);
}
