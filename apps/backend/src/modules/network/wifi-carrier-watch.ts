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
  A Wi-Fi radio that loses its access point stops carrying the stream at once,
  not at the next netif poll.

  WHY THE POLL WAS LATE. When an access point goes away, mac80211 drops the
  station's carrier the moment it handles the deauthentication or gives up on
  the beacon, and the kernel clears the netdev's RUNNING flag. NetworkManager
  does NOT leave `activated` for that: it keeps the device connected while the
  supplicant looks for the network again, so `nmcli monitor` prints nothing.
  The only reader of RUNNING was the 5 s `ifconfig` backstop poll, so the link
  stayed in the bond for 0-5 s after its radio had lost the AP, and the sender
  kept assigning packets to a socket bound to a radio that could not send them.
  On a two-radio box that cost frames even though the other radio was carrying.

  WHAT THIS DOES. It follows the kernel's link notifications (`ip -o monitor
  link`, RTM_NEWLINK) for Wi-Fi station interfaces. A carrier that stays down
  for {@link CARRIER_LOSS_HOLD_MS} marks the link (`wifi-carrier-lost.ts`), and
  a live bond refresh leaves a marked link out of the sender's list, unless no
  other entry in that list can carry. When the carrier comes back and has
  settled for {@link READMIT_SETTLE_MS}, the mark goes and the bond is
  republished with the link. A row the backstop poll withdrew meanwhile comes
  back through the existing readmission path (the poll and NetworkManager's
  events); this watch never samples the netif rows itself.

  A MARK, NOT A DECISION. Nothing here decides membership: bond toggles, radio
  admission and identity, hotspot, shared-LAN and modem gates, and the netif
  rows themselves are untouched. A mark is set only after sysfs confirms the
  link is not operational, it binds the netdev's ifindex, a deleted netdev
  drops it, and a 5 s check clears any mark whose link sysfs reports
  operational again, so a dropped monitor line cannot strand a link outside
  the bond. A dead child clears every mark it set; the poll covers the gap.

  NOT A BLIP. A carrier that returns within the hold cancels it, so a
  short blip changes nothing. A roam within one network also takes the
  carrier down, for the authentication and association with the next AP; the
  hold is sized from measured roams on the radios this runs on.

  ONLY WI-FI STATIONS. Cellular modems, Ethernet, tunnels, a hotspot's own AP
  interface and the concurrent-AP netdev are ignored.
*/

import { readFileSync } from "node:fs";

import { logger } from "../../helpers/logger.ts";
import {
	type ManagedProcess,
	spawnWatcher,
	type WatcherHandle,
} from "../../helpers/spawn-policy.ts";

/** How long a station's carrier must stay down before its link is marked. */
export const CARRIER_LOSS_HOLD_MS = 1200;
/** How long a returned carrier settles before the mark goes. */
export const READMIT_SETTLE_MS = 250;
/** How often marked links are checked against sysfs. */
export const MARK_CHECK_MS = 5_000;

export const RESTART_MIN_MS = 1_000;
export const RESTART_MAX_MS = 60_000;
/** A child that lived this long resets the restart delay. */
export const HEALTHY_CHILD_MS = 30_000;

export type LinkStateEvent = {
	readonly ifname: string;
	readonly ifindex: number;
	/** The kernel's own RUNNING: operational state UP (or UNKNOWN on an up link). */
	readonly running: boolean;
	/** RTM_DELLINK: the netdev is gone. */
	readonly deleted: boolean;
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
	/^(?:\[[^\]]*\]\s*)?(Deleted\s+)?(\d+):\s+([A-Za-z0-9._-]{1,15})(?:@[^:\s]+)?:\s+<([A-Z0-9_,-]*)>.*?\sstate\s+([A-Z]+)\b/;

export function parseLinkStateLine(line: string): LinkStateEvent | undefined {
	const match = LINK_LINE_RE.exec(line.trim());
	if (!match?.[2] || !match[3] || match[4] === undefined || !match[5])
		return undefined;
	const ifname = match[3];
	const ifindex = Number(match[2]);
	if (match[1]) return { ifname, ifindex, running: false, deleted: true };
	const flags = match[4].split(",");
	const running = isRunningState(flags.includes("UP"), match[5], () =>
		flags.includes("LOWER_UP"),
	);
	return { ifname, ifindex, running, deleted: false };
}

/** One rule for the monitor line and sysfs: UP, or UNKNOWN with a carrier. */
function isRunningState(
	adminUp: boolean,
	operstate: string,
	carrier: () => boolean,
): boolean {
	const state = operstate.toUpperCase();
	return adminUp && (state === "UP" || (state === "UNKNOWN" && carrier()));
}

function readSysfs(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return undefined;
	}
}

/**
 * sysfs, read with the monitor's rule. Unreadable counts as operational, so a
 * read failure never sets or keeps a mark.
 */
export function sysfsOperational(ifname: string): boolean {
	const operstate = readSysfs(`/sys/class/net/${ifname}/operstate`);
	if (operstate === undefined) return true;
	return isRunningState(
		true,
		operstate,
		() => readSysfs(`/sys/class/net/${ifname}/carrier`) === "1",
	);
}

type Timer = ReturnType<typeof setTimeout> | number;

export type WifiCarrierWatchDeps = {
	readonly spawn: (argv: string[]) => WatcherHandle;
	/** A Wi-Fi station interface (not a hotspot AP, not the concurrent AP). */
	readonly isWifiStation: (ifname: string) => boolean;
	/** sysfs says the link is operational ({@link sysfsOperational}). */
	readonly isOperational: (ifname: string) => boolean;
	readonly setLost: (ifname: string, lost: boolean, ifindex?: number) => void;
	readonly setDown: (ifname: string, down: boolean) => void;
	readonly now: () => number;
	readonly setTimeout: (callback: () => void, ms: number) => Timer;
	readonly clearTimeout: (timer: Timer) => void;
};

type LinkTrack = {
	ifindex: number;
	running: boolean | undefined;
	downSince: number | undefined;
	hold: Timer | undefined;
	settle: Timer | undefined;
	marked: boolean;
};

export class WifiCarrierWatch {
	#wanted = false;
	#handle: WatcherHandle | undefined;
	#restartTimer: Timer | undefined;
	#markCheck: Timer | undefined;
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
		this.#forgetAll();
		const handle = this.#handle;
		this.#handle = undefined;
		handle?.abort();
	}

	/** Act on one line of `ip -o monitor link`. Exported for the tests. */
	handleLine(line: string): void {
		if (!this.#wanted) return;
		const event = parseLinkStateLine(line);
		if (event === undefined) return;
		const { ifname, ifindex, running } = event;
		let track = this.#links.get(ifname);
		// A deleted netdev, another netdev under the name, or a name that is no
		// longer a station keeps no pending work or mark from before.
		if (
			track &&
			(event.deleted ||
				track.ifindex !== ifindex ||
				!this.deps.isWifiStation(ifname))
		) {
			this.#forget(ifname, track);
			track = undefined;
		}
		if (event.deleted || !this.deps.isWifiStation(ifname)) return;
		if (!track) {
			track = {
				ifindex,
				running: undefined,
				downSince: undefined,
				hold: undefined,
				settle: undefined,
				marked: false,
			};
			this.#links.set(ifname, track);
		}
		// Wireless events, statistics and flag changes that keep the state
		// repeat the same line: only an edge does anything.
		if (track.running === running) return;
		track.running = running;
		this.deps.setDown(ifname, !running);
		if (running) this.#onCarrierUp(ifname, track);
		else this.#onCarrierDown(ifname, track);
	}

	#onCarrierDown(ifname: string, track: LinkTrack): void {
		if (track.settle !== undefined) {
			this.deps.clearTimeout(track.settle);
			track.settle = undefined;
		}
		track.downSince = this.deps.now();
		if (track.marked || track.hold !== undefined) return;
		track.hold = this.deps.setTimeout(() => {
			track.hold = undefined;
			if (!this.#wanted || track.running !== false) return;
			if (!this.deps.isWifiStation(ifname)) return;
			// The monitor said down; the kernel must still agree. If it does
			// not, a line was lost: take the kernel's word for the state.
			if (this.deps.isOperational(ifname)) {
				this.#markRunning(ifname, track);
				return;
			}
			track.marked = true;
			logger.info(
				"Wi-Fi station lost its carrier; leaving it out of the bond",
				{
					ifname,
					down_ms: this.deps.now() - (track.downSince ?? this.deps.now()),
				},
			);
			this.deps.setLost(ifname, true, track.ifindex);
			this.#armMarkCheck();
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
		if (!track.marked || track.settle !== undefined) return;
		track.settle = this.deps.setTimeout(() => {
			track.settle = undefined;
			if (!this.#wanted || track.running !== true) return;
			logger.info("Wi-Fi station carrier is back; returning it to the bond", {
				ifname,
			});
			this.#unmark(ifname, track);
		}, READMIT_SETTLE_MS);
	}

	/** The kernel reports the link operational although no up line came. */
	#markRunning(ifname: string, track: LinkTrack): void {
		track.running = true;
		track.downSince = undefined;
		this.deps.setDown(ifname, false);
	}

	#unmark(ifname: string, track: LinkTrack): void {
		if (!track.marked) return;
		track.marked = false;
		this.deps.setLost(ifname, false);
	}

	/** Every mark is checked against sysfs, so no lost line can strand one. */
	#armMarkCheck(): void {
		if (this.#markCheck !== undefined) return;
		this.#markCheck = this.deps.setTimeout(() => {
			this.#markCheck = undefined;
			if (!this.#wanted) return;
			let anyMarked = false;
			for (const [ifname, track] of this.#links) {
				if (!track.marked) continue;
				if (
					!this.deps.isWifiStation(ifname) ||
					this.deps.isOperational(ifname)
				) {
					logger.info("Wi-Fi carrier mark cleared by the sysfs check", {
						ifname,
					});
					this.#unmark(ifname, track);
					// The up line was lost: the next down line is a real edge.
					this.#markRunning(ifname, track);
					continue;
				}
				anyMarked = true;
			}
			if (anyMarked) this.#armMarkCheck();
		}, MARK_CHECK_MS);
	}

	#forget(ifname: string, track: LinkTrack): void {
		if (track.hold !== undefined) this.deps.clearTimeout(track.hold);
		if (track.settle !== undefined) this.deps.clearTimeout(track.settle);
		track.hold = undefined;
		track.settle = undefined;
		this.#unmark(ifname, track);
		this.deps.setDown(ifname, false);
		this.#links.delete(ifname);
	}

	#forgetAll(): void {
		for (const [ifname, track] of [...this.#links]) this.#forget(ifname, track);
		if (this.#markCheck !== undefined) {
			this.deps.clearTimeout(this.#markCheck);
			this.#markCheck = undefined;
		}
	}

	#start(): void {
		if (!this.#wanted || this.#handle !== undefined) return;
		let handle: WatcherHandle;
		try {
			handle = this.deps.spawn(["ip", "-o", "monitor", "link"]);
		} catch (err) {
			logger.debug(`wifi carrier watch: spawn failed: ${err}`);
			this.#scheduleRestart(false);
			return;
		}
		this.#handle = handle;
		const startedAt = this.deps.now();
		void this.#read(handle).finally(() => {
			if (this.#handle !== handle) return;
			this.#handle = undefined;
			// A new child reports only later edges: the states it missed are
			// learned again, and the backstop poll covers the gap meanwhile.
			this.#forgetAll();
			this.#scheduleRestart(this.deps.now() - startedAt >= HEALTHY_CHILD_MS);
		});
	}

	async #read(handle: WatcherHandle): Promise<void> {
		const stdout = handle.proc.stdout;
		if (stdout) {
			const decoder = new TextDecoder();
			let buffer = "";
			try {
				for await (const chunk of stdout) {
					// Lines a stopped or replaced child still had buffered are not ours.
					if (this.#handle !== handle) break;
					buffer += decoder.decode(chunk, { stream: true });
					let newline = buffer.indexOf("\n");
					while (newline !== -1 && this.#handle === handle) {
						this.handleLine(buffer.slice(0, newline));
						buffer = buffer.slice(newline + 1);
						newline = buffer.indexOf("\n");
					}
					// One link line is a few hundred bytes; a longer tail is drift.
					if (buffer.length > 8_192) buffer = "";
				}
				buffer += decoder.decode();
				if (buffer.length > 0 && this.#handle === handle)
					this.handleLine(buffer);
			} catch (err) {
				logger.debug(`wifi carrier watch: stream ended: ${err}`);
			}
		}
		// A reader that stopped while the child lives would leave the watch
		// deaf with no restart: end the child so the supervisor sees an exit.
		handle.abort();
		await handle.proc.exited.catch(() => undefined);
	}

	#scheduleRestart(healthy: boolean): void {
		if (!this.#wanted || this.#restartTimer !== undefined) return;
		if (healthy) this.#restartDelayMs = RESTART_MIN_MS;
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
		// stdout only: an unread stderr pipe (ENOBUFS notices under netlink
		// overrun) would be buffered for the child's whole life.
		spawn: (argv) =>
			spawnWatcher(argv, {
				spawn: (cmd) =>
					Bun.spawn(cmd, {
						stdin: "ignore",
						stdout: "pipe",
						stderr: "ignore",
					}) as unknown as ManagedProcess,
			}),
		now: () => Date.now(),
		setTimeout: (callback, ms) => setTimeout(callback, ms),
		clearTimeout: (timer) => clearTimeout(timer),
		...deps,
	});
	watcher.start();
}

/** Shutdown hook: kill the child with the backend and clear its marks. */
export function stopWifiCarrierWatch(): void {
	watcher?.stop();
	watcher = undefined;
}
