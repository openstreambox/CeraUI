import {
	closeSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
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

/** Bumped by every backend start in a boot; /run/ceralive outlives a restart. */
export function carryingGenerationPath(): string {
	return (
		process.env.CERALIVE_CARRYING_GENERATION ??
		"/run/ceralive/carrying-generation"
	);
}

/** Written only by a clean exit that found the whole box idle. */
export function carryingIdleExitPath(): string {
	return (
		process.env.CERALIVE_CARRYING_IDLE_EXIT ??
		"/run/ceralive/carrying-idle-exit"
	);
}

type RestartEvidenceFs = Pick<
	typeof import("node:fs"),
	"readFileSync" | "writeFileSync" | "renameSync" | "rmSync"
>;

/**
 * Positive evidence that the process this one replaces held nothing when it
 * stopped. Each start bumps a per-boot generation; a clean exit that finds
 * stream liveness idle (no stream, no session doubt, no carrying evidence)
 * writes its own generation into the idle-exit record. A restart trusts the
 * record only when it names the generation it is replacing, so a record can
 * never outlive the process that wrote it: a crash, a watchdog kill, a stream
 * or any protection at exit, a failed write, a read-only directory, or a
 * backend from before this record (the first upgrade to it) all leave no
 * matching record and keep the hold. Nothing has to be withdrawn in time.
 */
export function createCarryingRestartEvidence(
	paths: {
		readonly generation: () => string;
		readonly idleExit: () => string;
	} = { generation: carryingGenerationPath, idleExit: carryingIdleExitPath },
	fs: RestartEvidenceFs = { readFileSync, writeFileSync, renameSync, rmSync },
) {
	const readNumber = (path: string): number | undefined => {
		try {
			const text = fs.readFileSync(path, "utf8");
			if (!/^\d+\n$/.test(text)) return undefined;
			const value = Number(text);
			return Number.isSafeInteger(value) ? value : undefined;
		} catch {
			return undefined;
		}
	};
	const writeNumber = (path: string, value: number): boolean => {
		try {
			fs.writeFileSync(`${path}.new`, `${value}\n`, { mode: 0o600 });
			fs.renameSync(`${path}.new`, path);
			return true;
		} catch {
			try {
				fs.rmSync(`${path}.new`, { force: true });
			} catch {
				// A sibling left behind is never read; the next write replaces it.
			}
			return false;
		}
	};
	let generation: number | undefined;
	return {
		/** Once, at start: whether the replaced process exited idle. Bumping
		 * the generation must succeed, or later exits could not be told apart. */
		start(): boolean {
			const previous = readNumber(paths.generation());
			const idleExit = readNumber(paths.idleExit());
			// Past any recorded exit too, so a lost or damaged generation can
			// never make an old record name the process being replaced.
			const next = Math.max(previous ?? 0, idleExit ?? 0) + 1;
			generation = writeNumber(paths.generation(), next) ? next : undefined;
			return (
				generation !== undefined &&
				previous !== undefined &&
				idleExit === previous
			);
		},
		/** At the first termination signal, before any teardown changes state. */
		recordExit(liveness: "streaming" | "idle" | "unknown"): boolean {
			if (generation === undefined || liveness !== "idle") return false;
			return writeNumber(paths.idleExit(), generation);
		},
	};
}

const restartEvidence = createCarryingRestartEvidence();

/** Called from the termination handler with the box's current liveness. */
export function recordCarryingIdleExit(
	liveness: "streaming" | "idle" | "unknown",
): boolean {
	return restartEvidence.recordExit(liveness);
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
 * positive evidence that the predecessor held nothing: its clean idle exit
 * (`createCarryingRestartEvidence`) and no OTA streaming marker. Without that
 * an idle box refused SSH and power actions for two minutes after every
 * package install or service restart. A marker that is present or cannot be
 * examined keeps the hold even beside an idle exit.
 */
export type RestartEvidence = {
	readonly idleExit: boolean;
	readonly marker: "idle" | "unknown";
};

export function restartNeedsCarryingHold(
	firstStartThisBoot: boolean,
	evidence: RestartEvidence,
): boolean {
	if (firstStartThisBoot) return false;
	return !(evidence.idleExit && evidence.marker === "idle");
}

export function initCarrying(
	firstStartThisBoot: boolean = claimFirstStartThisBoot(),
	evidence: RestartEvidence = {
		idleExit: restartEvidence.start(),
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
