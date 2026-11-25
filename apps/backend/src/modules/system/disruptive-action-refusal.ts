import { notificationBroadcast } from "../ui/notifications.ts";
import {
	type DisruptiveRefusalReason,
	isDisruptiveActionPending,
} from "./disruptive-action-reservation.ts";

const CLIENT_TRAFFIC = {
	text: "This action was not run. Try again when the box’s own stream and connected devices’ stream traffic are idle and no update is in progress.",
	key: "notifications.disruptiveActionClientTraffic",
} as const;
// Unknown is not a stream: the box is idle or still finding out, so it says it
// is checking, how long to wait, and the one step that settles it if it stays.
const LIVENESS_UNKNOWN = {
	text: "This action was not run. The box is still checking that no stream and no connected device’s stream traffic is running. Try again in a few minutes. If it keeps refusing, use Stop Stream on the Live page first.",
	key: "notifications.disruptiveActionLivenessUnknown",
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
				? LIVENESS_UNKNOWN
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
