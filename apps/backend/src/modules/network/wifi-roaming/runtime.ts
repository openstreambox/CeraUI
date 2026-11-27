/**
 * Boot wiring for the roaming observer (`wifi_roaming.level: observe`). Off by
 * default, and off does no IO. Never next to the two-radio coordinator.
 *
 * Each round (once a second, never overlapping): one sender read, one read of
 * the radios, one observer step, then the status file and any journal lines.
 * Both live under /run, mode 0600 (they name networks and radios), and are
 * diagnostics only: nothing reads them back for a decision, so a restart or a
 * failed write loses nothing that matters.
 *
 * `stop()` ends the loop, waits for the round in flight (bounded), closes the
 * sender client, writes a final "stopped" status and drains the journal.
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
import { normalizeMacAddress } from "../../wifi/wifi-permanent-mac.ts";
import { type ObserverStatus, RoamingObserver } from "./observer.ts";
import {
	createRadioPort,
	defaultRadioPortDeps,
	type RadioRead,
} from "./radio-port.ts";
import {
	createSenderPort,
	defaultSenderPortDeps,
	type SenderPort,
} from "./sender-port.ts";

export const WIFI_ROAMING_RUN_DIR = "/run/ceralive/wifi-roaming";
export const ROUND_MS = 1_000;
/** Shutdown waits at most this long for the round in flight. */
export const STOP_DEADLINE_MS = 5_000;
/** The journal keeps at most this many lines; older ones are dropped. */
export const JOURNAL_MAX_LINES = 2_000;

export type WifiRoamingConfig = Readonly<{
	level: "off" | "observe";
	exclude?: readonly string[] | undefined;
}>;

/** Why the observer does not start, or `null` when it may. */
export function roamingBlocker(
	config: WifiRoamingConfig | undefined,
	twoRadioEnabled: boolean,
): "off" | "two-radio-coordinator-enabled" | null {
	if (config?.level !== "observe") return "off";
	if (twoRadioEnabled) return "two-radio-coordinator-enabled";
	return null;
}

export type RuntimeIo = Readonly<{
	writeStatus(json: string): Promise<void>;
	appendJournal(line: string): Promise<void>;
}>;

/**
 * Atomic status writes and a bounded JSONL journal, both 0600 in a 0700
 * directory. Journal writes are serialized and rotation replaces the file
 * atomically, so no line is lost to a race.
 */
export function fileIo(dir = WIFI_ROAMING_RUN_DIR): RuntimeIo {
	let lines: number | null = null;
	let queue: Promise<void> = Promise.resolve();
	const journal = `${dir}/journal.jsonl`;
	const read = async () =>
		(await readFile(journal, "utf8").catch(() => ""))
			.split("\n")
			.filter(Boolean);
	const ensureDir = () => mkdir(dir, { recursive: true, mode: 0o700 });
	return {
		async writeStatus(json) {
			await ensureDir();
			const tmp = `${dir}/status.json.${process.pid}.tmp`;
			await writeFile(tmp, json, { mode: 0o600 });
			await rename(tmp, `${dir}/status.json`);
		},
		appendJournal(line) {
			const next = queue.then(async () => {
				await ensureDir();
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

export type RuntimeDeps = Readonly<{
	now(): number;
	sender: SenderPort;
	radios: { read(): Promise<RadioRead> };
	io: RuntimeIo;
	setInterval(fn: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}>;

export type ObserverRuntime = Readonly<{
	/** One round now; rounds never overlap (a call during one joins it). */
	round(): Promise<void>;
	stop(): Promise<void>;
	status(): ObserverStatus | null;
}>;

function statusDocument(
	state: "observing" | "stopped",
	startedAt: number,
	status: ObserverStatus | null,
): string {
	return `${JSON.stringify({ level: "observe", state, startedAt, ...(status ?? {}) }, null, 2)}\n`;
}

export function createObserverRuntime(deps: RuntimeDeps): ObserverRuntime {
	const observer = new RoamingObserver();
	const startedAt = deps.now();
	let stopped = false;
	let inFlight: Promise<void> | null = null;
	/** The last journal append; appends are ordered and never reject. */
	let journalTail: Promise<void> = Promise.resolve();

	const once = async () => {
		await deps.sender.poll();
		if (stopped) return;
		const read = await deps.radios.read();
		if (stopped) return;
		const events = observer.round({
			at: deps.now(),
			radios: read.radios,
			skipped: read.skipped,
			snapshot: deps.sender.snapshot(),
			sender: deps.sender.view(),
		});
		try {
			await deps.io.writeStatus(
				statusDocument("observing", startedAt, observer.status()),
			);
		} catch (error) {
			logger.debug("wifi-roaming: status write failed", { error });
		}
		for (const event of events) {
			const line = JSON.stringify(event);
			journalTail = journalTail
				.then(() => deps.io.appendJournal(line))
				.catch((error: unknown) => {
					logger.debug("wifi-roaming: journal write failed", { error });
				});
		}
	};

	const round = () => {
		if (stopped) return Promise.resolve();
		inFlight ??= once()
			.catch((error: unknown) => {
				logger.warn(`wifi-roaming: observer round failed: ${error}`);
			})
			.finally(() => {
				inFlight = null;
			});
		return inFlight;
	};

	const handle = deps.setInterval(() => {
		void round();
	}, ROUND_MS);

	return {
		round,
		status: () => observer.status(),
		async stop() {
			if (stopped) return;
			stopped = true;
			deps.clearInterval(handle);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const deadline = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, STOP_DEADLINE_MS);
			});
			try {
				await Promise.race([
					(async () => {
						await inFlight;
						deps.sender.close();
						await deps.io
							.writeStatus(
								statusDocument("stopped", startedAt, observer.status()),
							)
							.catch((error: unknown) => {
								logger.debug("wifi-roaming: final status write failed", {
									error,
								});
							});
						await journalTail;
					})(),
					deadline,
				]);
			} finally {
				clearTimeout(timer);
				deps.sender.close();
			}
		},
	};
}

let current: ObserverRuntime | null = null;

/** Start the observer when the runtime config asks for it. */
export async function initWifiRoaming(
	config: WifiRoamingConfig | undefined,
	twoRadioEnabled: boolean,
): Promise<void> {
	const blocker = roamingBlocker(config, twoRadioEnabled);
	if (blocker === "off") return;
	if (blocker !== null) {
		logger.warn(`wifi-roaming: observer not started: ${blocker}`);
		return;
	}
	if (current) return;
	const exclude = new Set(
		(config?.exclude ?? [])
			.map((mac) => normalizeMacAddress(mac))
			.filter((mac): mac is string => mac !== undefined),
	);
	const now = () => Date.now();
	current = createObserverRuntime({
		now,
		sender: createSenderPort(defaultSenderPortDeps(now)),
		radios: createRadioPort(defaultRadioPortDeps(run, exclude)),
		io: fileIo(),
		setInterval: (fn, ms) => setInterval(fn, ms),
		clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
	});
	logger.info(
		"wifi-roaming: observer started (level observe, acts on nothing)",
	);
}

/** Stop the observer and drain its round in flight; a no-op when off. */
export async function stopWifiRoaming(): Promise<void> {
	const runtime = current;
	current = null;
	await runtime?.stop();
}
