import { readFile } from "node:fs/promises";
import { isSharedLanPort } from "../network/ethernet-role.ts";
import {
	getNetworkInterfaces,
	NETIF_ERR_HOTSPOT,
	NETIF_ERR_SHAREDLAN,
} from "../network/network-interfaces.ts";
import { setCarryingOtaProtection } from "../streaming/ota-streaming-marker.ts";
import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";
import { isConcurrentApIfname } from "../wifi/wifi-concurrent-interface.ts";
import { carryingTracker, getCarryingLiveness } from "./carrying.ts";

/** RX on client-facing ports excludes the box's own uplink traffic. It also
 * works before a streaming shaper root exists and with NM's sharing floor. */
export async function readClientUploadCounters(
	ifnames: readonly string[],
	read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<Record<string, number>> {
	const counters: Record<string, number> = {};
	for (const ifname of ifnames) {
		if (!/^[a-zA-Z0-9_.:-]+$/.test(ifname))
			throw new Error("Invalid client interface");
		const raw = (
			await read(`/sys/class/net/${ifname}/statistics/rx_bytes`)
		).trim();
		if (!/^\d+$/.test(raw)) throw new Error("Unreadable client counter");
		const bytes = Number(raw);
		if (!Number.isSafeInteger(bytes) || bytes < 0)
			throw new Error("Unreadable client counter");
		counters[ifname] = bytes;
	}
	return counters;
}

let published: string | undefined;
function publishCarrying(): void {
	const state = getCarryingLiveness();
	setCarryingOtaProtection(state !== "idle");
	if (state === published) return;
	published = state;
	if (state === "idle") {
		notificationRemove("client-carrying");
		return;
	}
	const key =
		state === "streaming"
			? "notifications.clientCarrying"
			: "notifications.clientCarryingUnknown";
	const message =
		state === "streaming"
			? "The box is carrying client traffic. Updates and idle link changes will wait."
			: "The box is checking client activity. Updates and idle link changes will wait.";
	notificationBroadcast(
		"client-carrying",
		"info",
		message,
		0,
		true,
		false,
		true,
		key,
	);
}
let enabled = false;
let sampling = false;
export async function tickCarrying(): Promise<void> {
	if (!enabled || sampling) return;
	sampling = true;
	try {
		const ifnames = Object.entries(getNetworkInterfaces())
			.filter(
				([name, entry]) =>
					entry &&
					(isSharedLanPort(name) ||
						isConcurrentApIfname(name) ||
						(entry.error & (NETIF_ERR_HOTSPOT | NETIF_ERR_SHAREDLAN)) !== 0),
			)
			.map(([name]) => name);
		carryingTracker.upload(
			performance.now(),
			await readClientUploadCounters(ifnames),
		);
	} catch {
		carryingTracker.upload(performance.now(), null);
	} finally {
		publishCarrying();
		sampling = false;
	}
}

export function initCarrying(): void {
	enabled = true;
	carryingTracker.bind(publishCarrying);
	carryingTracker.upload(performance.now(), null);
	setCarryingOtaProtection(true);
}
