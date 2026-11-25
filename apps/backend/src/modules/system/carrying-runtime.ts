import { closeSync, lstatSync, openSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { logger } from "../../helpers/logger.ts";
import { isSharedLanPort } from "../network/ethernet-role.ts";
import {
	getNetworkInterfaces,
	NETIF_ERR_HOTSPOT,
	NETIF_ERR_SHAREDLAN,
} from "../network/network-interfaces.ts";
import { setup } from "../setup.ts";
import {
	initialOtaStreamLiveness,
	setCarryingOtaProtection,
} from "../streaming/ota-streaming-marker.ts";
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

/** Positive evidence for the next backend process in this boot that this one
 * held no carrying protection. /run/ceralive outlives a restart, like the
 * marker and the boot claim. */
export function carryingIdleRecordPath(): string {
	return (
		process.env.CERALIVE_CARRYING_IDLE_RECORD ?? "/run/ceralive/carrying-idle"
	);
}

type IdleRecordFs = Pick<
	typeof import("node:fs"),
	"lstatSync" | "openSync" | "closeSync" | "rmSync"
>;

/**
 * The record exists only while this process has published confirmed idle:
 * it is written after the carrying marker was cleared, and withdrawn before
 * any protection is published. A write that fails, a crash between the two
 * steps, or a backend from before the record leaves no record, and the
 * restart then keeps the hold. Absence of the marker alone is not idle
 * evidence: a marker write may fail while the process still protects.
 */
export function createCarryingIdleRecord(
	path: () => string = carryingIdleRecordPath,
	fs: IdleRecordFs = { lstatSync, openSync, closeSync, rmSync },
) {
	// Unknown at start: whatever is on disk belongs to the earlier process.
	let recorded: boolean | undefined;
	return {
		/** Read once at start, before this process publishes anything. */
		present(): boolean {
			try {
				return fs.lstatSync(path()).isFile();
			} catch {
				return false;
			}
		},
		withdraw(): boolean {
			if (recorded === false) return true;
			try {
				fs.rmSync(path(), { force: true });
				recorded = false;
				return true;
			} catch (error) {
				recorded = undefined;
				logger.warn("carrying idle record could not be withdrawn", { error });
				return false;
			}
		},
		record(): void {
			if (recorded === true) return;
			try {
				fs.closeSync(fs.openSync(path(), "w", 0o600));
				recorded = true;
			} catch {
				// No record keeps the next restart's hold; nothing else depends on it.
				recorded = undefined;
			}
		},
	};
}
export type CarryingIdleRecord = ReturnType<typeof createCarryingIdleRecord>;

/**
 * One carrying publication's persistence, in the order a crash or a failed
 * write must not defeat: withdraw the idle record, then take the marker;
 * release the marker, then record idle. Returns the marker state now held.
 */
export function persistCarryingProtection(
	protect: boolean,
	markerProtected: boolean | undefined,
	io: {
		readonly setMarker: (protect: boolean) => boolean;
		readonly idleRecord: CarryingIdleRecord;
	},
): boolean | undefined {
	if (protect) io.idleRecord.withdraw();
	let held = markerProtected;
	if (held !== protect && io.setMarker(protect)) held = protect;
	if (!protect && held === false) io.idleRecord.record();
	return held;
}

const idleRecord = createCarryingIdleRecord();
let published: string | undefined;
let markerProtected: boolean | undefined;
function publishCarrying(): void {
	const carrying = getCarryingStatus();
	const { state, startup } = carrying;
	markerProtected = persistCarryingProtection(
		state !== "idle",
		markerProtected,
		{ setMarker: setCarryingOtaProtection, idleRecord },
	);
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
				? "The box is checking whether your phone uses it. Updates and restarts wait; you can power off after confirming the interruption."
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
 *
 * A restart within the boot has a predecessor. It skips the hold only on
 * positive evidence that the predecessor held nothing: its idle record (see
 * `createCarryingIdleRecord`) and no OTA streaming marker. Without that an idle
 * box refused SSH and power actions for two minutes after every package
 * install or service restart. Anything else keeps the hold: no record (a
 * failed write, a crash mid-publication, an older backend), or a marker that
 * is present or cannot be examined.
 */
export type RestartEvidence = {
	readonly idleRecord: boolean;
	readonly marker: "idle" | "unknown";
};

export function restartNeedsCarryingHold(
	firstStartThisBoot: boolean,
	evidence: RestartEvidence,
): boolean {
	if (firstStartThisBoot) return false;
	return !(evidence.idleRecord && evidence.marker === "idle");
}

export function initCarrying(
	firstStartThisBoot: boolean = claimFirstStartThisBoot(),
	// Read before this process publishes its own carrying state below, which
	// withdraws the record while the first sample is outstanding.
	evidence: RestartEvidence = {
		idleRecord: idleRecord.present(),
		marker: initialOtaStreamLiveness(),
	},
): void {
	enabled = true;
	carryingTracker.bind(publishCarrying);
	if (restartNeedsCarryingHold(firstStartThisBoot, evidence))
		carryingTracker.start(performance.now());
	carryingTracker.upload(performance.now(), null);
	publishCarrying();
}
