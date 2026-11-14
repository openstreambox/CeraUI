import type { AudioLevelMessage } from "@ceraui/rpc/schemas";
import { getConfig } from "../config.ts";
import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";
import { getActiveEncodeStatus } from "./active-encode-status.ts";
import { isMeterSilencedByPick } from "./audio.ts";
import { getSourcesMessage } from "./sources.ts";
import {
	isLiveNoticeSuppressed,
	type LiveNotice,
	StillLiveDetector,
} from "./still-live-detector.ts";
import { getIsStreaming } from "./streaming.ts";

let cameraStopped = false;
let processAlive = false;
function selectedSource() {
	const active = getActiveEncodeStatus();
	const id =
		active?.capture?.active_source?.input_id ??
		active?.active_input ??
		getConfig().source;
	return getSourcesMessage().sources.find(
		(source) =>
			source.id === id ||
			(source.origin === "capture" && source.previousIds?.includes(id ?? "")),
	);
}
function publish(notice: LiveNotice, active: boolean): void {
	const name = `still-live-${notice}`;
	if (!active) {
		notificationRemove(name);
		return;
	}
	const source = selectedSource();
	const kind =
		source?.origin === "network"
			? "Network"
			: source?.origin === "capture" && source.kind === "hdmi"
				? "Hdmi"
				: "Camera";
	const keys = {
		Camera: "notifications.stillLiveCamera",
		Hdmi: "notifications.stillLiveHdmi",
		Network: "notifications.stillLiveNetwork",
	};
	const messages = {
		Camera:
			"Camera feed stopped. You're still live. Check the camera's connection.",
		Hdmi: "HDMI camera feed stopped. You're still live. Check the HDMI connection.",
		Network:
			"Network camera feed stopped. You're still live. Check the camera's network connection.",
	};
	notificationBroadcast(
		name,
		"warning",
		notice === "silence"
			? "No sound in your stream for 10 s. You're still live. Check the mic."
			: messages[kind],
		0,
		true,
		true,
		true,
		notice === "silence" ? "notifications.stillLiveSilence" : keys[kind],
	);
}
const detector = new StillLiveDetector({
	context: () => {
		const config = getConfig();
		const active = getActiveEncodeStatus();
		const source = selectedSource();
		return {
			streaming: getIsStreaming() && processAlive,
			// Standby already has a capture-resilience notice. Synthetic output is
			// deliberate, while an audio-only mute must not hide a camera outage.
			suppressed: isLiveNoticeSuppressed(source?.origin === "virtual", active),
			audioSuppressed: isMeterSilencedByPick(config.asrc),
			cameraStopped,
			selection: `${active?.capture?.active_source?.input_id ?? active?.active_input ?? config.source}:${config.asrc}`,
		};
	},
	publish,
	now: () => performance.now(),
	setTimer: (fn, ms) => {
		const timer = setTimeout(fn, ms);
		timer.unref();
		return timer;
	},
	clearTimer: clearTimeout,
});
export function noteLiveAudioLevel(level: AudioLevelMessage): void {
	detector.update(level);
}
export function noteLiveFrameHealth(
	streaming: boolean,
	alive: boolean | null,
	stopped: boolean,
): void {
	processAlive = streaming && alive === true;
	cameraStopped = stopped;
	detector.update();
}
export function resetStillLiveNotices(): void {
	processAlive = false;
	cameraStopped = false;
	detector.reset();
}
