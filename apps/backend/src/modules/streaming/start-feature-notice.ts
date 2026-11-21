/**
 * The operator notice for configured start features the running session went
 * without (an audio mix, a composition or its custom layout). Kept here, apart
 * from the backend, because a later live change can make part of it untrue: a
 * custom layout applied on air ends the layout half while a dropped mix still
 * stands until the next start.
 */
import {
	type DroppedStartFeature,
	droppedStartFeaturesMessage,
} from "./start-feature-authorization.ts";

/** Notification naming configured start features the engine did not get. */
export const START_FEATURES_NOTIFICATION = "stream-start-features";

export interface StartFeatureNoticeBridge {
	notify(
		name: string,
		type: "success" | "warning" | "error",
		msg: string,
		duration: number,
		isPersistent: boolean,
		isDismissable: boolean,
	): void;
	notificationExists(name: string): boolean;
	removeNotification(name: string): void;
}

let posted:
	| {
			dropped: readonly DroppedStartFeature[];
			answered: boolean;
			bridge: StartFeatureNoticeBridge;
	  }
	| undefined;

/** Post (or replace) the notice; an empty list clears it. */
export function postStartFeatureNotice(
	bridge: StartFeatureNoticeBridge,
	dropped: readonly DroppedStartFeature[],
	answered: boolean,
): void {
	if (dropped.length === 0) {
		clearStartFeatureNotice(bridge);
		return;
	}
	posted = { dropped: [...dropped], answered, bridge };
	bridge.notify(
		START_FEATURES_NOTIFICATION,
		"warning",
		droppedStartFeaturesMessage(dropped, answered),
		0,
		true,
		true,
	);
}

/** The session ended or started with everything: nothing is missing any more. */
export function clearStartFeatureNotice(
	bridge: StartFeatureNoticeBridge | undefined = posted?.bridge,
): void {
	posted = undefined;
	if (bridge?.notificationExists(START_FEATURES_NOTIFICATION))
		bridge.removeNotification(START_FEATURES_NOTIFICATION);
}

/**
 * A composition change was applied to the running stream: whatever composition
 * the start went without is no longer what is on air. A dropped mix stays.
 */
export function noteLiveCompositionApplied(): void {
	if (posted === undefined) return;
	const remaining = posted.dropped.filter((feature) => feature === "audio-mix");
	if (remaining.length === posted.dropped.length) return;
	postStartFeatureNotice(posted.bridge, remaining, posted.answered);
}

/** Test seam: forget the posted notice without touching any bridge. */
export function resetStartFeatureNoticeForTest(): void {
	posted = undefined;
}
