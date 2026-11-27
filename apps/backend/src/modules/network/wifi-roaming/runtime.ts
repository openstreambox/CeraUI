/**
 * Boot wiring for the roaming observer (`wifi_roaming.level: observe`). Off by
 * default, and off does no IO. Never next to the two-radio coordinator.
 *
 * Each round (once a second, never overlapping): one sender read, one read of
 * the radios, one observer step, then the status file (when it changed, or
 * every 10 s) and any journal lines. Both live under /run, mode 0600 in a 0700
 * directory (they name networks and radios), and are diagnostics only: nothing
 * reads them back for a decision, so a restart or a failed write loses nothing
 * that matters. At most 256 journal lines wait for the disk; past that new
 * events are dropped and counted in the status.
 *
 * `stop()` ends the loop and, within 2 s, waits for the round in flight,
 * closes the sender client, writes a final "stopped" status and drains the
 * journal. After that deadline nothing more is written.
 */

import {
	appendFile,
	chmod,
	mkdir,
	readFile,
	rename,
	unlink,
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
/** Shutdown waits at most this long for the round in flight and the drain. */
export const STOP_DEADLINE_MS = 2_000;
/** A sender read that has not answered in this long has failed. */
export const SENDER_TIMEOUT_MS = 1_000;
/** Journal lines that may wait for the disk; newer events are dropped past it. */
export const JOURNAL_MAX_PENDING = 256;
/** An unchanged status is still rewritten this often, as a liveness mark. */
export const STATUS_REFRESH_MS = 10_000;
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
	/** From now on no file step runs: a write in progress stops at its next step. */
	seal?(): void;
}>;

/**
 * Atomic status writes and a bounded JSONL journal, both 0600 in a 0700
 * directory. Journal writes are serialized and rotation replaces the file
 * atomically, so no line is lost to a race.
 */
export function fileIo(dir = WIFI_ROAMING_RUN_DIR): RuntimeIo {
	let sealed = false;
	let lines: number | null = null;
	let queue: Promise<void> = Promise.resolve();
	const journal = `${dir}/journal.jsonl`;
	const read = async () =>
		(await readFile(journal, "utf8").catch(() => ""))
			.split("\n")
			.filter(Boolean);
	let prepared = false;
	// Existing files keep their mode on rename and append: set it once.
	const ensureDir = async () => {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		if (prepared) return;
		await chmod(dir, 0o700);
		await chmod(journal, 0o600).catch(() => {
			// No journal yet: it is created 0600.
		});
		prepared = true;
	};
	return {
		seal() {
			sealed = true;
		},
		async writeStatus(json) {
			if (sealed) return;
			await ensureDir();
			if (sealed) return;
			const tmp = `${dir}/status.json.${process.pid}.tmp`;
			await writeFile(tmp, json, { mode: 0o600 });
			// Sealed while writing: the new status is never published.
			if (sealed) {
				await unlink(tmp).catch(() => {
					// Gone already: nothing was published.
				});
				return;
			}
			await rename(tmp, `${dir}/status.json`);
		},
		appendJournal(line) {
			const next = queue.then(async () => {
				if (sealed) return;
				await ensureDir();
				if (sealed) return;
				if (lines === null) lines = (await read()).length;
				if (lines >= JOURNAL_MAX_LINES) {
					const kept = (await read()).slice(-Math.floor(JOURNAL_MAX_LINES / 2));
					const tmp = `${journal}.${process.pid}.tmp`;
					await writeFile(tmp, `${kept.join("\n")}\n`, { mode: 0o600 });
					if (sealed) {
						await unlink(tmp).catch(() => {
							// Gone already: nothing was published.
						});
						return;
					}
					await rename(tmp, journal);
					lines = kept.length;
				}
				if (sealed) return;
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
	journalDropped: number,
): string {
	return `${JSON.stringify({ level: "observe", state, startedAt, journalDropped, ...(status ?? {}) }, null, 2)}\n`;
}

export function createObserverRuntime(deps: RuntimeDeps): ObserverRuntime {
	const observer = new RoamingObserver();
	const startedAt = deps.now();
	let stopped = false;
	/** Set when the stop deadline passed: nothing is written after it. */
	let sealed = false;
	let inFlight: Promise<void> | null = null;
	/** The last journal append; appends are ordered and never reject. */
	let journalTail: Promise<void> = Promise.resolve();
	let journalPending = 0;
	let journalDropped = 0;
	let lastStatus: { body: string; at: number } | null = null;

	const document = (state: "observing" | "stopped") =>
		statusDocument(state, startedAt, observer.status(), journalDropped);

	const writeStatus = async (state: "observing" | "stopped") => {
		if (sealed) return;
		const now = deps.now();
		// Compare without the round's time: only a change is worth a write.
		const body = statusDocument(
			state,
			startedAt,
			observer.status()
				? { ...(observer.status() as ObserverStatus), at: 0 }
				: null,
			journalDropped,
		);
		if (
			state === "observing" &&
			lastStatus?.body === body &&
			now - lastStatus.at < STATUS_REFRESH_MS
		)
			return;
		try {
			await deps.io.writeStatus(document(state));
			lastStatus = { body, at: now };
		} catch (error) {
			logger.debug("wifi-roaming: status write failed", { error });
		}
	};

	const journal = (line: string) => {
		if (journalPending >= JOURNAL_MAX_PENDING) {
			journalDropped++;
			return;
		}
		journalPending++;
		journalTail = journalTail
			.then(() => (sealed ? undefined : deps.io.appendJournal(line)))
			.catch((error: unknown) => {
				logger.debug("wifi-roaming: journal write failed", { error });
			})
			.finally(() => {
				journalPending--;
			});
	};

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
		if (stopped) return;
		for (const event of events) journal(JSON.stringify(event));
		await writeStatus("observing");
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
						await writeStatus("stopped");
						await journalTail;
					})(),
					deadline,
				]);
			} finally {
				sealed = true;
				deps.io.seal?.();
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
		sender: createSenderPort(defaultSenderPortDeps(now, SENDER_TIMEOUT_MS)),
		radios: createRadioPort(defaultRadioPortDeps(run, now, exclude)),
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
