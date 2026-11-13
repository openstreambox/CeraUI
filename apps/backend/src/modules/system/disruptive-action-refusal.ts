import { notificationBroadcast } from "../ui/notifications.ts";
import {
	type DisruptiveRefusalReason,
	isDisruptiveActionPending,
} from "./disruptive-action-reservation.ts";

export function notifyDisruptiveActionRefused(
	reason?: DisruptiveRefusalReason,
): void {
	const pending =
		reason === "update_in_progress" && isDisruptiveActionPending();
	notificationBroadcast(
		"disruptive_action_refused",
		"warning",
		pending
			? "Device is busy, try again in a moment"
			: "This action will wait until the box’s own stream and connected devices’ stream traffic have stopped and no update is in progress.",
		10,
		false,
		true,
		false,
		pending
			? "network.os.deviceBusy"
			: "notifications.disruptiveActionClientTraffic",
	);
}
