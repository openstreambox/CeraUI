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
  A Wi-Fi radio that loses its access point leaves the bond at once, not at the
  next netif poll.

  WHY THE POLL WAS LATE. When an access point goes away, mac80211 drops the
  station's carrier the moment it handles the deauthentication or gives up on
  the beacon, and the kernel clears the netdev's RUNNING flag. NetworkManager
  does NOT leave `activated` for that: it keeps the device connected while the
  supplicant looks for the network again, so `nmcli monitor` prints nothing.
  The only reader of RUNNING was the 5 s `ifconfig` backstop poll, so the link
  stayed in the bond for 0–5 s after its radio had lost the AP, and the sender
  kept assigning packets to a socket bound to a radio that could not send them.
  On a two-radio box that cost frames even though the other radio was carrying.

  WHAT THIS DOES. It follows the kernel's link notifications (`ip -o monitor
  link`, RTM_NEWLINK) for Wi-Fi station interfaces and, on an operational state
  that stays down for {@link CARRIER_LOSS_HOLD_MS}, runs the same netif refresh
  the poll runs. That refresh reads RUNNING itself and withdraws the row; bond
  toggles, radio admission and identity, hotspot and modem gates all apply
  exactly as on a poll, because nothing here decides membership. When the
  carrier comes back on a radio that has no row, it refreshes again after
  {@link READMIT_SETTLE_MS}, and the radio is readmitted by that same path.

  A TRIGGER, NOT DATA. The monitor line says only that a link changed. Whether
  it may carry the stream stays the refresh's answer. The 5 s poll remains the
  backstop whenever this watcher is down, so a missing `ip`, a dead child or a
  dropped line cost the old latency, never a wrong bond.

  NOT A ROAM, NOT A BLIP. A roam within one network takes the carrier down for
  the authentication and association with the next AP (and, with WPA, until
  the handshake lets the supplicant mark the link up). That gap is short, and
  the hold outlasts it: a carrier that returns within the hold cancels it and
  nothing is refreshed. Each withdrawal therefore needs the carrier to stay
  down for the whole hold, which bounds the bond changes one radio can cause.

  ONLY WI-FI STATIONS. Cellular modems, Ethernet, tunnels, a hotspot's own AP
  interface and the concurrent-AP netdev are ignored, and their membership
  keeps following the NetworkManager events and the poll as before.
*/

import { logger } from "../../helpers/logger.ts";
import {
	spawnWatcher,
	type WatcherHandle,
} from "../../helpers/spawn-policy.ts";

/** How long a station's carrier must stay down before its link is withdrawn. */
export const CARRIER_LOSS_HOLD_MS = 400;
/** How long a returned carrier settles before the radio's link is readmitted. */
export const READMIT_SETTLE_MS = 250;

export const RESTART_MIN_MS = 1_000;
export const RESTART_MAX_MS = 60_000;

export type LinkStateEvent = {
	readonly ifname: string;
	/** The kernel's own RUNNING: operational state UP (or UNKNOWN on an up link). */
	readonly running: boolean;
};

/*
  `ip -o monitor link` prints one line per RTM_NEWLINK / RTM_DELLINK:

    3: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DORMANT group default \    link/ether …
    3: wlan0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc noqueue state DORMANT mode DORMANT group default \    link/ether …
    Deleted 3: wlan0: <BROADCAST,MULTICAST> mtu 1500 …

  iproute2 hides IFF_RUNNING from the flag list and prints the operational
  state instead. The kernel sets RUNNING for operstate UP and UNKNOWN
  (`netif_oper_up`), which is what `ifconfig` shows, so the same rule is read
  here: UP is running, UNKNOWN is running only with the carrier (LOWER_UP),
  anything else (DORMANT, DOWN, LOWERLAYERDOWN, NOTPRESENT) is not.
*/
const LINK_LINE_RE =
	/^(?:\[[^\]]*\]\s*)?(Deleted\s+)?\d+:\s+([A-Za-z0-9._-]{1,15})(?:@[^:\s]+)?:\s+<([A-Z0-9_,-]*)>.*?\sstate\s+([A-Z]+)\b/;

export function parseLinkStateLine(line: string): LinkStateEvent | undefined {
	const match = LINK_LINE_RE.exec(line.trim());
	if (!match?.[2] || match[3] === undefined || !match[4]) return undefined;
	const ifname = match[2];
	if (match[1]) return { ifname, running: false };
	const flags = match[3].split(",");
	const state = match[4];
	const running =
		flags.includes("UP") &&
		(state === "UP" || (state === "UNKNOWN" && flags.includes("LOWER_UP")));
	return { ifname, running };
}

type Timer = ReturnType<typeof setTimeout> | number;

export type WifiCarrierWatchDeps = {
	readonly spawn: (argv: string[]) => WatcherHandle;
	/** A Wi-Fi station interface (not a hotspot AP, not the concurrent AP). */
	readonly isWifiStation: (ifname: string) => boolean;
	/** The interface has a row in the published netif map. */
	readonly isPublished: (ifname: string) => boolean;
	/** Run the netif refresh the backstop poll runs. */
	readonly refresh: () => Promise<void> | void;
	readonly now: () => number;
	readonly setTimeout: (callback: () => void, ms: number) => Timer;
	readonly clearTimeout: (timer: Timer) => void;
};

type LinkTrack = {
	running: boolean | undefined;
	downSince: number | undefined;
	hold: Timer | undefined;
	readmit: Timer | undefined;
};

export class WifiCarrierWatch {
	#wanted = false;
	#handle: WatcherHandle | undefined;
	#restartTimer: Timer | undefined;
	#restartDelayMs = RESTART_MIN_MS;
	readonly #links = new Map<string, LinkTrack>();

	constructor(private readonly deps: WifiCarrierWatchDeps) {}

	get running(): boolean {
		return this.#handle !== undefined;
	}

	start(): void {
		if (this.#wanted) return;
		this.#wanted = true;
		this.#restartDelayMs = RESTART_MIN_MS;
		this.#start();
	}

	stop(): void {
		this.#wanted = false;
		if (this.#restartTimer !== undefined) {
			this.deps.clearTimeout(this.#restartTimer);
			this.#restartTimer = undefined;
		}
		for (const track of this.#links.values()) this.#clearTimers(track);
		this.#links.clear();
		const handle = this.#handle;
		this.#handle = undefined;
		handle?.abort();
	}

	/** Act on one line of `ip -o monitor link`. Exported for the tests. */
	handleLine(line: string): void {
		const event = parseLinkStateLine(line);
		if (event === undefined) return;
		const { ifname, running } = event;
		if (!this.deps.isWifiStation(ifname)) {
			// A name that stopped being a station (it became a hotspot) keeps no
			// pending work from its station days.
			const stale = this.#links.get(ifname);
			if (stale) {
				this.#clearTimers(stale);
				this.#links.delete(ifname);
			}
			return;
		}
		let track = this.#links.get(ifname);
		if (!track) {
			track = {
				running: undefined,
				downSince: undefined,
				hold: undefined,
				readmit: undefined,
			};
			this.#links.set(ifname, track);
		}
		// Wireless events, statistics and flag changes that keep the state
		// repeat the same line: only an edge does anything.
		if (track.running === running) return;
		track.running = running;
		if (running) this.#onCarrierUp(ifname, track);
		else this.#onCarrierDown(ifname, track);
	}

	#onCarrierDown(ifname: string, track: LinkTrack): void {
		if (track.readmit !== undefined) {
			this.deps.clearTimeout(track.readmit);
			track.readmit = undefined;
		}
		track.downSince = this.deps.now();
		// A link the bond does not hold has nothing to withdraw.
		if (!this.deps.isPublished(ifname) || track.hold !== undefined) return;
		track.hold = this.deps.setTimeout(() => {
			track.hold = undefined;
			if (!this.#wanted || track.running !== false) return;
			// The backstop poll may have withdrawn it during the hold already.
			if (!this.deps.isPublished(ifname)) return;
			logger.info("Wi-Fi station lost its carrier; refreshing the bond", {
				ifname,
				down_ms: this.deps.now() - (track.downSince ?? this.deps.now()),
			});
			this.#refresh();
		}, CARRIER_LOSS_HOLD_MS);
	}

	#onCarrierUp(ifname: string, track: LinkTrack): void {
		if (track.hold !== undefined) {
			this.deps.clearTimeout(track.hold);
			track.hold = undefined;
			logger.debug("Wi-Fi station carrier returned within the hold", {
				ifname,
				down_ms: this.deps.now() - (track.downSince ?? this.deps.now()),
			});
		}
		track.downSince = undefined;
		if (this.deps.isPublished(ifname) || track.readmit !== undefined) return;
		track.readmit = this.deps.setTimeout(() => {
			track.readmit = undefined;
			if (!this.#wanted || track.running !== true) return;
			if (this.deps.isPublished(ifname)) return;
			logger.info("Wi-Fi station carrier is back; refreshing the bond", {
				ifname,
			});
			this.#refresh();
		}, READMIT_SETTLE_MS);
	}

	#refresh(): void {
		try {
			void Promise.resolve(this.deps.refresh()).catch((err: unknown) => {
				logger.debug(`wifi carrier watch: refresh failed: ${err}`);
			});
		} catch (err) {
			logger.debug(`wifi carrier watch: refresh failed: ${err}`);
		}
	}

	#clearTimers(track: LinkTrack): void {
		if (track.hold !== undefined) this.deps.clearTimeout(track.hold);
		if (track.readmit !== undefined) this.deps.clearTimeout(track.readmit);
		track.hold = undefined;
		track.readmit = undefined;
	}

	#start(): void {
		if (!this.#wanted || this.#handle !== undefined) return;
		let handle: WatcherHandle;
		try {
			handle = this.deps.spawn(["ip", "-o", "monitor", "link"]);
		} catch (err) {
			logger.debug(`wifi carrier watch: spawn failed: ${err}`);
			this.#scheduleRestart();
			return;
		}
		this.#handle = handle;
		void this.#read(handle).finally(() => {
			if (this.#handle !== handle) return;
			this.#handle = undefined;
			// A new child reports only later edges: the states it missed are
			// learned again, and the backstop poll covers the gap meanwhile.
			for (const track of this.#links.values()) this.#clearTimers(track);
			this.#links.clear();
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
				this.#restartDelayMs = RESTART_MIN_MS;
				buffer += decoder.decode(chunk, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					this.handleLine(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
				}
				// One link line is a few hundred bytes; a longer tail is drift.
				if (buffer.length > 8_192) buffer = "";
			}
			buffer += decoder.decode();
			if (buffer.length > 0) this.handleLine(buffer);
		} catch (err) {
			logger.debug(`wifi carrier watch: stream ended: ${err}`);
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

let watcher: WifiCarrierWatch | undefined;

/** Start the watcher on a device (main.ts calls it only without mocks). */
export function startWifiCarrierWatch(
	deps: Omit<
		WifiCarrierWatchDeps,
		"spawn" | "now" | "setTimeout" | "clearTimeout"
	>,
): void {
	if (watcher) return;
	watcher = new WifiCarrierWatch({
		spawn: (argv) => spawnWatcher(argv),
		now: () => Date.now(),
		setTimeout: (callback, ms) => setTimeout(callback, ms),
		clearTimeout: (timer) => clearTimeout(timer),
		...deps,
	});
	watcher.start();
}

/** Shutdown hook: kill the child with the backend. */
export function stopWifiCarrierWatch(): void {
	watcher?.stop();
	watcher = undefined;
}
