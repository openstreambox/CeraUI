/*
  The production reconnect window (stream-reconnect.ts), built on first use.

  Its dependencies sit across the streaming and network graph, so they are
  resolved lazily, like the connection restart's own; the status snapshot only
  needs `getStreamReconnectStatus`, which answers `null` until a window opened.
*/

import { randomUUID } from "node:crypto";

import { logger } from "../../helpers/logger.ts";
import {
	createStreamReconnect,
	type KeepTryingResult,
	type RestartFailure,
	reconnectSettings,
	type StreamReconnect,
	type StreamReconnectExpiry,
	type StreamReconnectStatus,
} from "./stream-reconnect.ts";

let instance: StreamReconnect | undefined;
let building: Promise<StreamReconnect> | undefined;

/** The window's state for every status snapshot; `null` without one. */
export function getStreamReconnectStatus(): StreamReconnectStatus | null {
	return instance?.status() ?? null;
}

const EXPIRED_MESSAGES: Record<
	StreamReconnectExpiry,
	{ readonly key: string; readonly msg: string }
> = {
	no_link: {
		key: "notifications.reconnectExpiredNoLink",
		msg: "Couldn't reconnect: no network link came back. Nothing is retrying now.",
	},
	start_failed: {
		key: "notifications.reconnectExpiredStartFailed",
		msg: "Couldn't reconnect: the stream didn't start again on the links that are up. Nothing is retrying now.",
	},
};

async function build(): Promise<StreamReconnect> {
	const [
		{ getConfig },
		{ genSrtlaIpList, genSrtlaIpListForLocalIpAddress },
		{ isLocalIp },
		{ onNetworkInterfaceSourcesChange },
		{ onUsbNetScanCommitted },
		{ onOperatorStopIntent },
		{ getIsStreaming },
		{ beginConnectionRestart },
		{ restartStart, CONNECTION_RESTART_FAILED },
		{ broadcastMsg },
		{ notificationBroadcast, notificationRemove },
		{ clearArmedStreamMarker },
		{ armStreamRestoration },
	] = await Promise.all([
		import("../config.ts"),
		import("./srtla.ts"),
		import("../../helpers/ip-addresses.ts"),
		import("../network/network-interfaces.ts"),
		import("../network/router-cellular-scan.ts"),
		import("./operator-stop-intent.ts"),
		import("./streaming.ts"),
		import("./connection-restarting.ts"),
		import("./connection-restart.ts"),
		import("../ui/websocket-server.ts"),
		import("../ui/notifications.ts"),
		import("./armed-stream-marker.ts"),
		import("./stream-restoration.ts"),
	]);
	return createStreamReconnect({
		now: Date.now,
		schedule: (run, ms) => {
			const timer = setTimeout(run, ms);
			return () => clearTimeout(timer);
		},
		token: randomUUID,
		settings: () => reconnectSettings(getConfig()),
		// The same list a launch would bond: a receiver on a local subnet takes
		// its own links (prepareSrtlaIpAddresses), any other the bond.
		linkSources: () => {
			const receiver = getConfig().srtla_addr;
			return receiver !== undefined && isLocalIp(receiver)
				? genSrtlaIpListForLocalIpAddress(receiver)
				: genSrtlaIpList();
		},
		onLinkChange: (listener) => {
			const removeNetif = onNetworkInterfaceSourcesChange(listener);
			const removeScan = onUsbNetScanCommitted(listener);
			return () => {
				removeNetif();
				removeScan();
			};
		},
		onOperatorStop: onOperatorStopIntent,
		isStreaming: getIsStreaming,
		beginRestart: () => beginConnectionRestart(),
		start: (stillWanted) => restartStart(stillWanted, "link-recovery"),
		publish: (status) => broadcastMsg("status", { stream_reconnect: status }),
		announceReconnected: () =>
			notificationBroadcast(
				"connection_restarted",
				"info",
				"Stream reconnected.",
				10,
				false,
				true,
				true,
				"notifications.streamReconnected",
			),
		announceExpired: (reason, token) => {
			const { key, msg } = EXPIRED_MESSAGES[reason];
			notificationBroadcast(
				CONNECTION_RESTART_FAILED,
				"error",
				msg,
				0,
				true,
				true,
				true,
				key,
				undefined,
				{
					action: {
						schema: 1,
						kind: "command",
						command: "keep-reconnecting",
						token,
						labelKey: "notifications.keepTrying",
					},
				},
			);
		},
		clearExpired: () => {
			notificationRemove(CONNECTION_RESTART_FAILED);
		},
		disarmRestoration: () => clearArmedStreamMarker(),
		rearmRestoration: () => {
			armStreamRestoration();
		},
		log: (event, meta) => logger.info("stream reconnect", { event, ...meta }),
	});
}

/** The production window, built once. */
export function streamReconnect(): Promise<StreamReconnect> {
	if (instance !== undefined) return Promise.resolve(instance);
	building ??= build().then((built) => {
		instance = built;
		return built;
	});
	return building;
}

/** A restart's Start failed after its Stop: open the window (or its end). */
export async function reconnectAfterRestartFailure(
	failure: RestartFailure,
	stillWanted: () => boolean,
): Promise<void> {
	const reconnect = await streamReconnect();
	// An operator Stop while the window was being built: nothing opens.
	if (stillWanted()) reconnect.afterRestartStartFailed(failure);
}

export async function keepReconnecting(
	token: string,
): Promise<KeepTryingResult> {
	return (await streamReconnect()).keepTrying(token);
}

/** A session committed: a running window has done its job. */
export function noteStreamCommittedForReconnect(): void {
	instance?.noteStreamStarted();
}

/** Tests only: drop the window and rebuild it with the current modules. */
export function resetStreamReconnectForTest(): void {
	instance?.resetForTest();
	instance = undefined;
	building = undefined;
}
