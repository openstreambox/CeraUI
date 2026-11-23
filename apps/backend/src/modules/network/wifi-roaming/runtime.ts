/**
 * Boot wiring for coordinated Wi-Fi roaming. Off unless the runtime config
 * enables it with a list of radios by identity; never next to the two-radio
 * coordinator (two owners must never act on one radio).
 *
 * Each round (once a second): one sender read, one coordinator step, then the
 * status file in /run and, when something changed, one journal line.
 */

import {
	appendFile,
	mkdir,
	readFile,
	rename,
	writeFile,
} from "node:fs/promises";
import { logger } from "../../../helpers/logger.ts";
import { run } from "../../../helpers/run.ts";
import { admitWifiAdapter } from "../../wifi/wifi-adapter-admission.ts";
import { isWifiDiscoveryActive } from "../../wifi/wifi-interfaces.ts";
import {
	getNetworkInterfaces,
	isBondCandidate,
	type NetworkInterface,
} from "../network-interfaces.ts";
import { holdOutOfBond, releaseBondHold } from "./bond-hold.ts";
import {
	type CoordinatorPorts,
	type CoordinatorStatus,
	type RadioObservation,
	RoamingCoordinator,
} from "./coordinator.ts";
import { createSearchNm, type SearchNmDeps } from "./nm-port.ts";
import type { HolderHealth } from "./policy.ts";
import { confirmRadio, lifetimeKey, withRadioLock } from "./radio-lock.ts";

export { lifetimeKey };

import {
	createSenderPort,
	defaultSenderPortDeps,
	type SenderPort,
} from "./sender-port.ts";

export const WIFI_ROAMING_RUN_DIR = "/run/ceralive/wifi-roaming";
export const ROUND_MS = 1_000;
/** Shutdown waits at most this long for roaming to stop. */
export const STOP_DEADLINE_MS = 5_000;
/** The journal keeps at most this many lines; older ones are dropped. */
export const JOURNAL_MAX_LINES = 2_000;

export type WifiRoamingConfig = Readonly<{
	enabled: boolean;
	radios: readonly Readonly<{ id: string; reserved?: "hotspot" | undefined }>[];
}>;

/** Why roaming does not start, or `null` when it may. */
export function roamingBlocker(
	config: WifiRoamingConfig | undefined,
	twoRadioEnabled: boolean,
): string | null {
	if (!config?.enabled) return "disabled";
	if (twoRadioEnabled) return "two-radio-coordinator-enabled";
	const clients = new Set(
		config.radios
			.filter((r) => r.reserved !== "hotspot")
			.map((r) => r.id.toLowerCase()),
	);
	if (clients.size < 2) return "needs-two-client-radios";
	// One physical radio listed twice (two clients, or client and hotspot).
	const ids = config.radios.map((r) => r.id.toLowerCase());
	if (new Set(ids).size !== ids.length) return "duplicate-radio-ids";
	return null;
}

/** Bond links that are not coordinated Wi-Fi: cellular, Ethernet, others. */
export function countOtherUplinks(
	netif: Readonly<Record<string, NetworkInterface>>,
	coordinated: ReadonlySet<string>,
	isCandidate: (name: string, int: NetworkInterface) => boolean,
): number {
	let n = 0;
	for (const [name, int] of Object.entries(netif))
		if (!coordinated.has(name) && isCandidate(name, int)) n++;
	return n;
}

/** What changed between two statuses that the journal records. */
export function journalEntry(
	before: CoordinatorStatus | null,
	after: CoordinatorStatus,
	at: number,
): Record<string, unknown> | null {
	const roles = (s: CoordinatorStatus | null) =>
		Object.fromEntries(
			(s?.radios ?? []).map((r) => [
				r.id,
				`${r.role}@${r.ifname}${r.present ? "" : "(absent)"}`,
			]),
		);
	const rb = roles(before);
	const ra = roles(after);
	const changedRoles = Object.keys(ra).filter((id) => rb[id] !== ra[id]);
	const outcome =
		after.lastOutcome !== (before?.lastOutcome ?? null)
			? after.lastOutcome
			: undefined;
	const swap =
		after.lastSwapOutcome !== (before?.lastSwapOutcome ?? null)
			? after.lastSwapOutcome
			: undefined;
	if (changedRoles.length === 0 && outcome === undefined && swap === undefined)
		return null;
	return {
		at,
		...(changedRoles.length > 0
			? { roles: Object.fromEntries(changedRoles.map((id) => [id, ra[id]])) }
			: {}),
		...(outcome !== undefined ? { outcome } : {}),
		...(swap !== undefined ? { swap } : {}),
	};
}

export type RuntimeIo = Readonly<{
	writeStatus(json: string): Promise<void>;
	appendJournal(line: string): Promise<void>;
}>;

/**
 * Atomic status writes (mode 0600: the status names SSIDs and BSSIDs) and a
 * bounded JSONL journal under the run directory. Journal writes are serialized
 * and rotation replaces the file atomically, so no line is lost to a race.
 */
export function fileIo(dir = WIFI_ROAMING_RUN_DIR): RuntimeIo {
	let lines: number | null = null;
	let queue: Promise<void> = Promise.resolve();
	const journal = `${dir}/journal.jsonl`;
	const read = async () =>
		(await readFile(journal, "utf8").catch(() => ""))
			.split("\n")
			.filter(Boolean);
	return {
		async writeStatus(json) {
			await mkdir(dir, { recursive: true });
			const tmp = `${dir}/status.json.${process.pid}.tmp`;
			await writeFile(tmp, json, { mode: 0o600 });
			await rename(tmp, `${dir}/status.json`);
		},
		appendJournal(line) {
			const next = queue.then(async () => {
				await mkdir(dir, { recursive: true });
				if (lines === null) lines = (await read()).length;
				if (lines >= JOURNAL_MAX_LINES) {
					const kept = (await read()).slice(-Math.floor(JOURNAL_MAX_LINES / 2));
					const tmp = `${journal}.${process.pid}.tmp`;
					await writeFile(tmp, `${kept.join("\n")}\n`, { mode: 0o600 });
					await rename(tmp, journal);
					lines = kept.length;
				}
				await appendFile(journal, `${line}\n`, { mode: 0o600 });
				lines++;
			});
			queue = next.catch(() => {
				// The caller sees the failure; the queue only keeps the order.
			});
			return next;
		},
	};
}

/**
 * The production ports. Radios are resolved by identity each round; the
 * sender port maps this round's names; holder health takes the signal from
 * the last observation (the coordinator's own samples), and leaves the
 * delivered rate and loss unknown: the proof uses the sender's arrival reports.
 */
export function productionPorts(
	now: () => number,
	currentNames: () => readonly string[],
	/** Test seam: a profile-MAC reader instead of sysfs. */
	overrides: Pick<SearchNmDeps, "macOf"> = {},
): { ports: CoordinatorPorts; sender: SenderPort } {
	const nm = createSearchNm({
		run,
		identity: confirmRadio,
		...(overrides.macOf ? { macOf: overrides.macOf } : {}),
	});
	const lastObs = new Map<string, RadioObservation | undefined>();
	const sender = createSenderPort(defaultSenderPortDeps(currentNames, now));
	const ports: CoordinatorPorts = {
		now,
		publicationPending: isWifiDiscoveryActive,
		resolve: (id) => {
			const a = admitWifiAdapter(id);
			return a
				? { ifname: a.row.ifname, lifetime: lifetimeKey(a.lifetime) }
				: undefined;
		},
		observe: async (ifname) => {
			const o = await nm.observe(ifname);
			lastObs.set(ifname, o);
			return o;
		},
		scan: (ifname, gate) => nm.scan(ifname, gate),
		savedSsids: (ifname) => nm.savedSsids(ifname),
		join: (ifname, ssid, bssid, gate) => nm.join(ifname, ssid, bssid, gate),
		radioMode: (ifname) => nm.radioMode(ifname),
		abandon: (ifname, activation, gate) => nm.abandon(ifname, activation, gate),
		uplinkOf: (ifname, o) => nm.uplinkOf(ifname, o),
		holderHealth: (ifname): HolderHealth => ({
			signalDbm: lastObs.get(ifname)?.signalDbm ?? null,
			attributedBps: null,
			encoderBps: sender.encoderRate(),
			nakRatio: null,
		}),
		otherUplinks: () =>
			countOtherUplinks(
				getNetworkInterfaces(),
				new Set(currentNames()),
				isBondCandidate,
			),
		senderLinks: () => sender.senderLinks(),
		encoderRate: () => sender.encoderRate(),
		holdOutOfBond,
		releaseBondHold,
		withRadioLock,
	};
	return { ports, sender };
}

export type RoamingHandle = Readonly<{
	coordinator: RoamingCoordinator;
	/** One round: sender read, coordinator step, status, journal. */
	round(): Promise<void>;
	stop(): Promise<void>;
}>;

/** Build a running loop around a coordinator. `schedule` defaults to timers. */
export function startRoaming(
	config: WifiRoamingConfig,
	build: (currentNames: () => readonly string[]) => {
		ports: CoordinatorPorts;
		sender: Pick<SenderPort, "poll" | "close">;
	},
	io: RuntimeIo,
	schedule: (fn: () => void) => { cancel(): void } = (fn) => {
		const t = setInterval(fn, ROUND_MS);
		return { cancel: () => clearInterval(t) };
	},
): RoamingHandle {
	let coordinator: RoamingCoordinator | null = null;
	const names = () =>
		coordinator
			?.status()
			.radios.flatMap((r) => (r.present ? [r.ifname] : [])) ?? [];
	const { ports, sender } = build(names);
	coordinator = new RoamingCoordinator(ports, {
		radios: config.radios.map((r) =>
			r.reserved ? { id: r.id, reserved: r.reserved } : { id: r.id },
		),
	});
	const c = coordinator;
	let last: CoordinatorStatus | null = null;
	let stopped = false;
	let busy = false;
	/** Journal lines not yet written, oldest first. */
	const pending: string[] = [];
	/** The status and journal I/O of the round in flight. */
	let writing: Promise<void> | null = null;
	const round = async () => {
		// One round at a time; a tick during a long scan or join is skipped.
		if (stopped || busy) return;
		busy = true;
		try {
			await sender.poll();
			if (stopped) return;
			await c.step();
			if (stopped) return;
			const status = c.status();
			const at = Date.now();
			const entry = journalEntry(last, status, at);
			if (entry) pending.push(JSON.stringify(entry));
			last = status;
			// The I/O runs as one tracked step, so stop() can wait for it.
			const write = (async () => {
				try {
					await io.writeStatus(JSON.stringify({ at, ...status }));
				} catch (error) {
					logger.debug("wifi-roaming: status write failed", { error });
				}
				// A failed line stays queued, in order, and goes out first next round.
				while (pending.length > 0) {
					try {
						await io.appendJournal(pending[0] as string);
					} catch (error) {
						logger.debug("wifi-roaming: journal write failed", { error });
						return;
					}
					pending.shift();
				}
			})();
			writing = write;
			await write;
		} finally {
			writing = null;
			busy = false;
		}
	};
	const timer = schedule(() => {
		void round().catch((error) =>
			logger.warn("wifi-roaming: round failed", { error }),
		);
	});
	return {
		coordinator: c,
		round,
		async stop() {
			stopped = true;
			timer.cancel();
			await c.stop();
			// Drain the round's status and journal I/O; never wait on a sender read.
			await writing;
			sender.close();
		},
	};
}

let running: RoamingHandle | null = null;

/** Boot entry: start roaming when the config enables it, else do nothing. */
export async function initWifiRoaming(
	config: WifiRoamingConfig | undefined,
	twoRadioEnabled: boolean,
	start: (config: WifiRoamingConfig) => RoamingHandle = (cfg) => {
		const now = () => Math.round(performance.now());
		return startRoaming(
			cfg,
			(currentNames) => productionPorts(now, currentNames),
			fileIo(),
		);
	},
): Promise<void> {
	if (running) return;
	const blocker = roamingBlocker(config, twoRadioEnabled);
	if (blocker !== null || !config) {
		if (blocker !== "disabled")
			logger.warn(`wifi-roaming: not started (${blocker})`);
		return;
	}
	running = start(config);
	logger.info(
		`wifi-roaming: started with ${config.radios.length} radios (${config.radios.filter((r) => r.reserved).length} hotspot-reserved)`,
	);
}

/**
 * Stop roaming for shutdown, within one overall deadline. The coordinator is
 * fenced at once (no effect dispatches after this call); the wait is only for
 * a round in flight and its status write. Links the coordinator made stay up;
 * their volatile profiles go when NetworkManager deactivates them.
 */
export async function stopWifiRoaming(
	deadlineMs = STOP_DEADLINE_MS,
): Promise<void> {
	const r = running;
	running = null;
	if (!r) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stopped = r.stop().catch((error) => {
		logger.warn("wifi-roaming: stop failed", { error });
	});
	const late = new Promise<"late">((resolve) => {
		timer = setTimeout(() => resolve("late"), deadlineMs);
	});
	try {
		if ((await Promise.race([stopped, late])) === "late")
			logger.warn("wifi-roaming: stop deadline passed; not waiting further");
	} finally {
		clearTimeout(timer);
	}
}
