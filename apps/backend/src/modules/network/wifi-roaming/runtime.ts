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
import { createSearchNm } from "./nm-port.ts";
import type { HolderHealth } from "./policy.ts";
import { withRadioLock } from "./radio-lock.ts";
import {
	createSenderPort,
	defaultSenderPortDeps,
	radioAddressesOf,
	type SenderPort,
} from "./sender-port.ts";

export const WIFI_ROAMING_RUN_DIR = "/run/ceralive/wifi-roaming";
export const ROUND_MS = 1_000;
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
	if (config.radios.filter((r) => r.reserved !== "hotspot").length < 2)
		return "needs-two-client-radios";
	return null;
}

/** A radio lifetime as one comparable string. */
export function lifetimeKey(l: {
	ifindex: number;
	wiphy: number;
	phyPath: string;
}): string {
	return `${l.ifindex}:${l.wiphy}:${l.phyPath}`;
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

/** Atomic status writes and a bounded JSONL journal under the run directory. */
export function fileIo(dir = WIFI_ROAMING_RUN_DIR): RuntimeIo {
	let lines: number | null = null;
	const journal = `${dir}/journal.jsonl`;
	return {
		async writeStatus(json) {
			await mkdir(dir, { recursive: true });
			const tmp = `${dir}/status.json.tmp`;
			await writeFile(tmp, json);
			await rename(tmp, `${dir}/status.json`);
		},
		async appendJournal(line) {
			await mkdir(dir, { recursive: true });
			if (lines === null)
				lines = (await readFile(journal, "utf8").catch(() => ""))
					.split("\n")
					.filter(Boolean).length;
			if (lines >= JOURNAL_MAX_LINES) {
				const kept = (await readFile(journal, "utf8").catch(() => ""))
					.split("\n")
					.filter(Boolean)
					.slice(-Math.floor(JOURNAL_MAX_LINES / 2));
				await writeFile(journal, `${kept.join("\n")}\n`);
				lines = kept.length;
			}
			await appendFile(journal, `${line}\n`);
			lines++;
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
): { ports: CoordinatorPorts; sender: SenderPort } {
	const nm = createSearchNm({ run });
	const lastObs = new Map<string, RadioObservation | undefined>();
	const senderDeps = defaultSenderPortDeps([], now);
	const sender = createSenderPort({
		...senderDeps,
		radios: () => radioAddressesOf(getNetworkInterfaces(), currentNames()),
	});
	const ports: CoordinatorPorts = {
		now,
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
		scan: (ifname) => nm.scan(ifname),
		savedSsids: (ifname) => nm.savedSsids(ifname),
		join: (ifname, ssid, bssid, mayActivate) =>
			nm.join(ifname, ssid, bssid, mayActivate),
		radioMode: (ifname) => nm.radioMode(ifname),
		abandon: (ifname, activation) => nm.abandon(ifname, activation),
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
		sweepOrphans: () => nm.sweepOrphans(),
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
	const round = async () => {
		if (stopped) return;
		await sender.poll();
		await c.step();
		const status = c.status();
		const at = Date.now();
		try {
			await io.writeStatus(JSON.stringify({ at, ...status }));
			const entry = journalEntry(last, status, at);
			if (entry) await io.appendJournal(JSON.stringify(entry));
		} catch (error) {
			logger.debug("wifi-roaming: status or journal write failed", { error });
		}
		last = status;
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
			sender.close();
		},
	};
}

let running: RoamingHandle | null = null;

/** Boot entry: start roaming when the config enables it, else do nothing. */
export async function initWifiRoaming(
	config: WifiRoamingConfig | undefined,
	twoRadioEnabled: boolean,
): Promise<void> {
	if (running) return;
	const blocker = roamingBlocker(config, twoRadioEnabled);
	if (blocker !== null || !config) {
		if (blocker !== "disabled")
			logger.warn(`wifi-roaming: not started (${blocker})`);
		return;
	}
	const now = () => Math.round(performance.now());
	running = startRoaming(
		config,
		(currentNames) => productionPorts(now, currentNames),
		fileIo(),
	);
	logger.info(
		`wifi-roaming: started with ${config.radios.length} radios (${config.radios.filter((r) => r.reserved).length} hotspot-reserved)`,
	);
}

export async function stopWifiRoaming(): Promise<void> {
	const r = running;
	running = null;
	await r?.stop();
}
