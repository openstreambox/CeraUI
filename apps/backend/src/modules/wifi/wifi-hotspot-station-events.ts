/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
  The kernel's own "a station appeared / left" events, used as a TRIGGER for the
  hotspot roster read in `wifi-hotspot-clients.ts`.

  WHERE THE EVENT COMES FROM. cfg80211 multicasts NL80211_CMD_NEW_STATION and
  NL80211_CMD_DEL_STATION on the `mlme` group whenever a driver adds or removes
  a station: mac80211 does it for every soft-MAC radio, and full-MAC drivers such
  as brcmfmac call the same `cfg80211_new_sta` / `cfg80211_del_sta` from their
  AP event handlers. `iw event` subscribes to that group and prints one line per
  event: `<ifname> (phy #<n>): new station <mac>` (or `del station`).
  NetworkManager publishes no per-station signal for an AP profile, so this is
  the one source that is both immediate and already on the image (`iw` is the
  binary the roster and capability reads use).

  A TRIGGER, NOT DATA. The line only says that something changed on an
  interface. Who is joined stays the roster's answer (`iw dev <ap> station
  dump`), for one reason that matters to the operator: the kernel adds a station
  at ASSOCIATION, before the WPA handshake proves it knows the password. A phone
  with a wrong password produces a `new station` line and then a `del station`
  line, and must never be announced as "a new device joined". The roster skips
  stations whose dump says `authorized: no`, and the handshake finishes without
  any further nl80211 event, so a `new station` schedules a read now and two
  follow-ups ({@link JOIN_FOLLOW_UP_MS}). The 5 s roster poll remains the
  backstop whenever this watcher is down.

  It runs only while at least one hotspot is broadcasting (the roster poll
  decides each tick through {@link syncHotspotStationEvents}), never under mocks,
  and it is a `watcher`-class spawn site (`helpers/spawn-policy.ts`): no
  timeout, killed on shutdown. A child that keeps dying is restarted with a
  growing delay, so a board without a working `iw` costs one spawn a minute.
*/

import { logger } from "../../helpers/logger.ts";
import {
	spawnWatcher,
	type WatcherHandle,
} from "../../helpers/spawn-policy.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { IW_FALLBACK_PATH } from "./regdomain.ts";
import {
	currentHotspotApIfnames,
	refreshHotspotClients,
} from "./wifi-hotspot-clients.ts";

export type IwStationEvent = {
	readonly ifname: string;
	readonly kind: "new" | "del";
	readonly mac: string;
};

/**
 * `wlan0 (phy #0): new station 8c:85:90:1a:2b:3c`, optionally prefixed by the
 * `-t`/`-r` timestamp (`1755823102.841234: `). Anchored at both ends, so any
 * other event (`connected to`, `scan started`, `ch_switch_started_notify`) and
 * any drifted shape is ignored instead of half-read.
 */
const STATION_EVENT_RE =
	/^(?:\d+\.\d+:\s+)?([A-Za-z0-9._-]{1,15}) \(phy #\d+\): (new|del) station ((?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})\s*$/;

export function parseIwStationEvent(line: string): IwStationEvent | undefined {
	const match = STATION_EVENT_RE.exec(line.trim());
	if (!match?.[1] || !match[2] || !match[3]) return undefined;
	return {
		ifname: match[1],
		kind: match[2] === "new" ? "new" : "del",
		mac: match[3].toLowerCase(),
	};
}

/**
 * Roster reads after a `new station`: at once, then twice more while the WPA
 * handshake usually completes (well under a second on a phone, a few seconds
 * on a slow one).
 */
export const JOIN_FOLLOW_UP_MS = [0, 1_000, 3_000] as const;

/** Restart delay for a child that exited: doubles from 1 s up to a minute. */
export const RESTART_MIN_MS = 1_000;
export const RESTART_MAX_MS = 60_000;

type Timer = ReturnType<typeof setTimeout> | number;

export type HotspotStationEventDeps = {
	readonly spawn: (argv: string[]) => WatcherHandle;
	readonly iwPath: () => string;
	readonly apIfnames: () => readonly string[];
	readonly refresh: (ifnames: readonly string[]) => Promise<void>;
	readonly setTimeout: (callback: () => void, ms: number) => Timer;
	readonly clearTimeout: (timer: Timer) => void;
};

const defaultDeps: HotspotStationEventDeps = {
	spawn: (argv) => spawnWatcher(argv),
	iwPath: () => Bun.which("iw") ?? IW_FALLBACK_PATH,
	apIfnames: currentHotspotApIfnames,
	refresh: (ifnames) => refreshHotspotClients(ifnames, { force: true }),
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (timer) => clearTimeout(timer),
};

export class HotspotStationEvents {
	#wanted = false;
	#handle: WatcherHandle | undefined;
	#restartTimer: Timer | undefined;
	#restartDelayMs = RESTART_MIN_MS;
	readonly #followUps = new Map<string, Timer[]>();

	constructor(private readonly deps: HotspotStationEventDeps = defaultDeps) {}

	get running(): boolean {
		return this.#handle !== undefined;
	}

	/** Run the watcher while `wanted`; stop it otherwise. Idempotent. */
	sync(wanted: boolean): void {
		if (wanted === this.#wanted) return;
		this.#wanted = wanted;
		if (wanted) {
			this.#restartDelayMs = RESTART_MIN_MS;
			this.#start();
		} else {
			this.stop();
		}
	}

	stop(): void {
		this.#wanted = false;
		if (this.#restartTimer !== undefined) {
			this.deps.clearTimeout(this.#restartTimer);
			this.#restartTimer = undefined;
		}
		for (const timers of this.#followUps.values())
			for (const timer of timers) this.deps.clearTimeout(timer);
		this.#followUps.clear();
		const handle = this.#handle;
		this.#handle = undefined;
		handle?.abort();
	}

	/** Act on one line of `iw event` output. Exported for the parser tests. */
	handleLine(line: string): void {
		const event = parseIwStationEvent(line);
		if (event === undefined) return;
		// Only the hotspot's own AP interface: a station leg on the same radio
		// reports the router it joined as a "new station" too.
		if (!this.deps.apIfnames().includes(event.ifname)) return;
		this.#scheduleReads(event);
	}

	#scheduleReads(event: IwStationEvent): void {
		const { ifname } = event;
		for (const timer of this.#followUps.get(ifname) ?? [])
			this.deps.clearTimeout(timer);
		const delays = event.kind === "new" ? JOIN_FOLLOW_UP_MS : [0];
		const timers = delays.map((ms) =>
			this.deps.setTimeout(() => {
				// A follow-up belongs to the AP the event came from: once that
				// interface no longer hosts an AP (Stop, or it became a station
				// leg), its dump would name the router it joined, so nothing is
				// read. A restarted AP gets its own events and its own poll.
				if (!this.#wanted || !this.deps.apIfnames().includes(ifname)) return;
				void this.deps.refresh([ifname]).catch((err) => {
					logger.debug(`hotspot station events: read failed: ${err}`);
				});
			}, ms),
		);
		this.#followUps.set(ifname, timers);
	}

	#start(): void {
		if (!this.#wanted || this.#handle !== undefined) return;
		let handle: WatcherHandle;
		try {
			handle = this.deps.spawn([this.deps.iwPath(), "event"]);
		} catch (err) {
			logger.debug(`hotspot station events: spawn failed: ${err}`);
			this.#scheduleRestart();
			return;
		}
		this.#handle = handle;
		void this.#read(handle).finally(() => {
			if (this.#handle !== handle) return;
			this.#handle = undefined;
			this.#scheduleRestart();
		});
	}

	async #read(handle: WatcherHandle): Promise<void> {
		const stdout = handle.proc.stdout;
		if (!stdout) return;
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for await (const chunk of stdout) {
				// A healthy child resets the restart delay.
				this.#restartDelayMs = RESTART_MIN_MS;
				buffer += decoder.decode(chunk, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					this.handleLine(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
				}
				// One event line is short; a runaway line without a newline is
				// drift, and holding it would grow without bound.
				if (buffer.length > 4_096) buffer = "";
			}
			buffer += decoder.decode();
			if (buffer.length > 0) this.handleLine(buffer);
		} catch (err) {
			logger.debug(`hotspot station events: stream ended: ${err}`);
		}
		await handle.proc.exited.catch(() => undefined);
	}

	#scheduleRestart(): void {
		if (!this.#wanted || this.#restartTimer !== undefined) return;
		const delay = this.#restartDelayMs;
		this.#restartDelayMs = Math.min(delay * 2, RESTART_MAX_MS);
		this.#restartTimer = this.deps.setTimeout(() => {
			this.#restartTimer = undefined;
			this.#start();
		}, delay);
	}
}

let watcher: HotspotStationEvents | undefined;

/**
 * Called from every roster poll tick with whether any hotspot is up. A dev host
 * (mocks) never spawns: the mock roster is the single seam there.
 */
export function syncHotspotStationEvents(anyApUp: boolean): void {
	if (shouldUseMocks()) return;
	if (!anyApUp && watcher === undefined) return;
	watcher ??= new HotspotStationEvents();
	watcher.sync(anyApUp);
}

/** Shutdown hook: kill the child with the backend. */
export function stopHotspotStationEvents(): void {
	watcher?.stop();
	watcher = undefined;
}
