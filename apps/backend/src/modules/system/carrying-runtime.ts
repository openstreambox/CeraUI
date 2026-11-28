import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isSharedLanPort } from "../network/ethernet-role.ts";
import {
	getNetworkInterfaces,
	NETIF_ERR_HOTSPOT,
	NETIF_ERR_SHAREDLAN,
} from "../network/network-interfaces.ts";
import { setup } from "../setup.ts";
import { setCarryingOtaProtection } from "../streaming/ota-streaming-marker.ts";
import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import { isConcurrentApIfname } from "../wifi/wifi-concurrent-interface.ts";
import { carryingTracker, getCarryingStatus } from "./carrying.ts";

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
let markerProtected: boolean | undefined;
function publishCarrying(): void {
	const carrying = getCarryingStatus();
	const { state, startup } = carrying;
	const protect = state !== "idle";
	if (markerProtected !== protect && setCarryingOtaProtection(protect))
		markerProtected = protect;
	const signature = `${state}:${startup}`;
	if (signature === published) return;
	published = signature;
	broadcastMsg("status", { carrying });
	if (state === "idle") {
		notificationRemove("client-carrying");
		return;
	}
	const key =
		state === "streaming"
			? "notifications.clientCarrying"
			: setup.engine === "none" && startup
				? "live.phone.carryingChecking"
				: "notifications.clientCarryingUnknown";
	const message =
		state === "streaming"
			? "The box is carrying client traffic. Updates, restarts, power-off and idle link changes will wait."
			: setup.engine === "none" && startup
				? "The box is checking whether a device is sending through it. Updates and restarts wait; you can power off after confirming the interruption."
				: "The box is checking client activity. Updates, restarts, power-off and idle link changes will wait.";
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

/** /run starts empty on every boot, and the service keeps /run/ceralive across
 * its own restarts (RuntimeDirectoryPreserve=yes), so this file tells a restart
 * from the first start of a boot. */
export function carryingBootClaimPath(): string {
	return (
		process.env.CERALIVE_CARRYING_BOOT_CLAIM ??
		"/run/ceralive/carrying-boot-claim"
	);
}

/** Only creating the claim proves a first start; an existing or unwritable
 * claim counts as a restart, which keeps the startup hold. */
export function claimFirstStartThisBoot(
	path: string = carryingBootClaimPath(),
): boolean {
	try {
		closeSync(openSync(path, "wx", 0o600));
		return true;
	} catch {
		return false;
	}
}

/**
 * The startup hold stands in for client evidence an earlier backend process
 * held and lost with its memory. The first start after a boot has no such
 * predecessor: anything carried before the reboot was already cut, and new
 * client traffic is measured by the sampler from its first interval. Holding
 * there only refused restarts, power-off and SSH for two minutes after every
 * boot.
 */
export function initCarrying(
	firstStartThisBoot: boolean = claimFirstStartThisBoot(),
): void {
	enabled = true;
	carryingTracker.bind(publishCarrying);
	if (!firstStartThisBoot) carryingTracker.start(performance.now());
	carryingTracker.upload(performance.now(), null);
	publishCarrying();
}
