/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2026 CeraLive project

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
  Keep bonded Wi-Fi radios on distinct networks.

  WHAT GOES WRONG WITHOUT IT. CeraUI saves one NetworkManager profile per radio
  and network (bound by MAC address). An operator who has ever joined each radio
  to each of two networks ends up with both profiles on both radios. When radio
  A loses network 1, NetworkManager autoconnects A to its saved profile for
  network 2, which radio B already uses. That fallback is right as a last
  resort, but NetworkManager never preempts an active connection, so A stays on
  network 2 after network 1 comes back. The bond then has two links over one
  uplink, and losing that uplink drops the whole stream.

  Interface binding cannot fix this (the fallback profile IS bound to the right
  radio), and autoconnect-priority alone cannot either (NetworkManager only
  consults it when choosing what to activate, not to leave a working link).

  WHAT THIS DOES. A radio's preferred network is the one the operator chose for
  it in CeraUI, stored as `connection.autoconnect-priority =
  WIFI_CHOSEN_NETWORK_PRIORITY` on that radio's own (MAC-bound) profile. A
  periodic check moves a radio back to its preferred network when ALL of these
  hold, because every automated move tears down a link that is carrying traffic:

  - NetworkManager's device table (read at tick time, never the event-patched
    UI state) shows the radio sharing its network with another radio, for
    CONFIRM_TICKS consecutive ticks.
  - No radio's link changed in the last SETTLE_MS (srtla needs time to
    re-register a link, and a fresh change may still be settling).
  - The preferred network is free, its bound profile is not active anywhere,
    and no operator join/connect is in flight on this radio.
  - THIS radio's own completed scans saw the preferred network twice, at least
    SIGHTING_GAP_MS apart, at or above SIGNAL_FLOOR and not much weaker than
    the shared link. The merged scan cache is never used: another radio's
    stale BSS entry can keep an absent network "visible" for minutes.
  - The state is re-read under the adapter lock right before acting, and at most
    one radio moves per tick.

  WHICH RADIO, AND WHICH LOCK. A radio is tracked by its physical identity: the
  permanent MAC plus the sampled radio lifetime of a verified identity row. That
  is never the adapter lock key, which names the radio's current OWNER (possibly
  a composite hotspot owner) and can move. Profiles are matched against the
  permanent MAC; every write takes the lock the current row resolves to and
  re-checks there that the same registry row still owns it. A Limited or
  Unverified radio is not tracked and never written. A replacement radio under
  the same name has a new lifetime, so it starts with no back-off, parking or
  pending choice of its predecessor.

  A move counts only when the radio holds the network for HOLD_MS. A quicker
  revert backs off (60 s doubling to 15 min); after PARK_AFTER_REVERTS reverts
  the radio waits for the operator or a clearly stronger signal. A failed move
  restores the fallback link at once, so the mark never leaves the radio
  chasing a network that is not there. Forced scans are budgeted per episode
  (three fast ones, then one every 10 minutes), because a scan on a connected
  radio can stall its traffic for a few seconds.

  Boxes upgraded from before the marks existed are migrated conservatively:
  only during the first minutes after start, and only when no radio has a mark
  and every connected radio has sat on its own distinct network for a while,
  each radio's active profile is marked. Otherwise an unmarked radio is left
  alone. Single-radio boxes, radios in AP mode or running a concurrent hotspot,
  and radios whose preferred network is the shared one are never touched.
*/

import { logger } from "../../helpers/logger.ts";
import {
	type ConnectionUUID,
	nmConnect,
	nmConnGetFields,
	nmConnSetFields,
	nmcliParseSep,
	nmDevices,
	nmScanDevice,
} from "../network/network-manager.ts";
import {
	admitWifiAdapter,
	physicalWifiAdapterId,
	type WifiAdapterAdmission,
	wifiAdapterAdmissionCurrent,
} from "./wifi-adapter-admission.ts";
import {
	type WifiAdapterLockKey,
	withWifiAdapterLock,
} from "./wifi-adapter-lock.ts";
import {
	getWifiInterfacesByMacAddress,
	wifiScheduleScanRefresh,
} from "./wifi-connections.ts";
import { isApMode, isConcurrentHotspot } from "./wifi-hotspot-types.ts";
import type { SSID, WifiInterface } from "./wifi-interfaces.ts";
import { normalizeMacAddress } from "./wifi-permanent-mac.ts";

/** Marks the operator's chosen network on a radio; a reserved odd value. */
export const WIFI_CHOSEN_NETWORK_PRIORITY = 17;
export const WIFI_DIVERSITY_TICK_MS = 10_000;
export const WIFI_DIVERSITY = {
	confirmTicks: 2,
	settleMs: 30_000,
	sightingGapMs: 20_000,
	sightingMaxAgeMs: 60_000,
	signalFloor: 40,
	signalMargin: 10,
	scanDelaysMs: [30_000, 60_000, 120_000] as readonly number[],
	scanSlowMs: 600_000,
	holdMs: 90_000,
	moveBackoffMs: 60_000,
	moveBackoffMaxMs: 900_000,
	parkAfterReverts: 3,
	parkSignalGain: 15,
	migrationWindowMs: 600_000,
	migrationStableMs: 120_000,
	activateTimeoutS: 20,
	/** Out of the duplicate this long before the scan budget starts over. */
	episodeGapMs: 300_000,
	/** At most one early scan from the merged-list hint per this window. */
	earlyScanGapMs: 300_000,
} as const;

/** A station radio as the registry knows it: identity and saved profiles. */
export type DiversityRadio = {
	/** Physical identity (permanent MAC + radio lifetime); keys all tracking. */
	readonly id: string;
	/** Normalized permanent MAC; a profile is this radio's when bound to it. */
	readonly mac: string;
	/** Lock key the current registry row resolves to. Never an identity. */
	readonly lock: WifiAdapterLockKey;
	readonly ifname: string;
	readonly savedAll: Readonly<Record<SSID, readonly ConnectionUUID[]>>;
	/** The admission this projection came from (live wiring only). */
	readonly admission?: WifiAdapterAdmission;
};

export type DiversityProfile = {
	readonly priority: number;
	/** Normalized MAC the profile is bound to; undefined when unbound. */
	readonly mac: string | undefined;
};

/** ifname -> active connection UUID (null when not connected). */
export type DiversityLinks = ReadonlyMap<string, ConnectionUUID | null>;

export type WifiNetworkDiversityDeps = {
	readonly radios: () => DiversityRadio[];
	readonly readLinks: () => Promise<DiversityLinks | undefined>;
	readonly readProfile: (
		uuid: ConnectionUUID,
	) => Promise<DiversityProfile | undefined>;
	readonly setPriority: (
		uuid: ConnectionUUID,
		priority: number,
	) => Promise<boolean>;
	/** Fresh scan on this radio only: SSID -> signal, undefined on failure. */
	readonly scan: (ifname: string) => Promise<Map<SSID, number> | undefined>;
	readonly activate: (uuid: ConnectionUUID, ifname: string) => Promise<boolean>;
	/** Runs `fn` under the adapter lock; false when the adapter is busy. */
	readonly withLock: (
		key: WifiAdapterLockKey,
		fn: () => Promise<void>,
	) => Promise<boolean>;
	/**
	 * Called with `radio.lock` held: does this projection's registry row still
	 * own that lock with the same physical identity? Defaults to true; the
	 * projection itself is always re-read and compared.
	 */
	readonly current?: (radio: DiversityRadio) => boolean;
	readonly now: () => number;
	/**
	 * SSID -> best signal in the merged scan list. Never evidence for a move
	 * (another radio's cache can be stale); a network newly listed at a usable
	 * signal earns at most one early scan per `earlyScanGapMs`.
	 */
	readonly listed?: () => ReadonlyMap<SSID, number>;
};

type Track = {
	uuid: ConnectionUUID | null;
	since: number;
	dupTicks: number;
	scans: number;
	nextScanAt: number;
	lastScanAt: number | undefined;
	lastCandidateAt: number | undefined;
	listed: boolean;
	lastEarlyScanAt: number | undefined;
	sighting: { at: number; signal: number } | undefined;
	nextMoveAt: number;
	reverts: number;
	parkedSignal: number | undefined;
	moved: { uuid: ConnectionUUID; at: number; signal: number } | undefined;
};

type Seen = {
	radio: DiversityRadio;
	uuid: ConnectionUUID | null;
	ssid: SSID | null;
};

function ssidOf(radio: DiversityRadio, uuid: ConnectionUUID | null) {
	if (uuid === null) return null;
	for (const ssid in radio.savedAll) {
		if (radio.savedAll[ssid]?.includes(uuid)) return ssid;
	}
	return null;
}

export class WifiNetworkDiversity {
	/** Keyed by physical identity (`DiversityRadio.id`), never by lock key. */
	private readonly tracks = new Map<string, Track>();
	private readonly profiles = new Map<ConnectionUUID, DiversityProfile>();
	private readonly busy = new Map<string, number>();
	/** Operator choices whose write found the adapter busy; retried per tick. */
	private readonly pending = new Map<
		string,
		{ radio: DiversityRadio; uuid: ConnectionUUID; seq: number }
	>();
	/** The newest choice per physical radio; an older one is never written. */
	private readonly latestChoice = new Map<string, number>();
	private choiceSeq = 0;
	private running: Promise<void> | undefined;
	private choices: Promise<void> = Promise.resolve();
	private startedAt: number | undefined;
	private migrated = false;

	constructor(private readonly deps: WifiNetworkDiversityDeps) {}

	/** One evaluation; concurrent calls join the one in flight. */
	tick(): Promise<void> {
		this.running ??= this.retryChoices()
			.then(() => this.evaluate())
			.finally(() => {
				this.running = undefined;
			});
		return this.running;
	}

	/**
	 * Mark an operator join/connect on the physical radio `id` as in flight. The
	 * check leaves the radio alone until the returned release runs.
	 */
	beginOperatorChoice(id: string): () => void {
		this.busy.set(id, (this.busy.get(id) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const left = (this.busy.get(id) ?? 1) - 1;
			if (left > 0) this.busy.set(id, left);
			else this.busy.delete(id);
		};
	}

	/**
	 * Record an operator's explicit choice of `uuid` on a radio: the projection
	 * admitted for the choice, or the current one for a physical id. Only a
	 * profile bound to this radio's permanent MAC is marked: an unbound profile
	 * is shared by every radio, so marking it would mark it for all of them.
	 * Serialized, so two quick choices cannot interleave their writes. A busy
	 * adapter defers the write to the next tick; a replaced radio drops it.
	 */
	recordChoice(
		radio: DiversityRadio | string,
		uuid: ConnectionUUID,
	): Promise<void> {
		const seq = ++this.choiceSeq;
		this.latestChoice.set(typeof radio === "string" ? radio : radio.id, seq);
		return this.enqueueChoice(radio, uuid, seq);
	}

	private enqueueChoice(
		radio: DiversityRadio | string,
		uuid: ConnectionUUID,
		seq: number,
	): Promise<void> {
		const next = this.choices.then(() => {
			const target =
				typeof radio === "string"
					? this.deps.radios().find((r) => r.id === radio)
					: radio;
			return target ? this.writeChoice(target, uuid, seq) : undefined;
		});
		this.choices = next.catch(() => {
			// The caller sees the failure; the chain only keeps the order.
		});
		return next;
	}

	/** The radio's current projection, if `radio` still names it under its lock. */
	private held(radio: DiversityRadio): DiversityRadio | undefined {
		const now = this.deps.radios().find((r) => r.id === radio.id);
		if (
			!now ||
			now.lock !== radio.lock ||
			now.ifname !== radio.ifname ||
			now.mac !== radio.mac ||
			now.admission?.row !== radio.admission?.row
		)
			return undefined;
		return (this.deps.current?.(now) ?? true) ? now : undefined;
	}

	private async retryChoices(): Promise<void> {
		const due = [...this.pending.values()];
		this.pending.clear();
		for (const { radio, uuid, seq } of due) {
			await this.enqueueChoice(radio, uuid, seq).catch((err) => {
				logger.warn(`Wi-Fi diversity: deferred choice failed: ${err}`);
			});
		}
	}

	private async writeChoice(
		radio: DiversityRadio,
		uuid: ConnectionUUID,
		seq: number,
	): Promise<void> {
		// A newer choice for this radio was made after this one: it wins.
		if (this.latestChoice.get(radio.id) !== seq) return;
		this.pending.delete(radio.id);
		let outcome = "done" as "done" | "replaced" | "moved";
		const locked = await this.deps.withLock(radio.lock, async () => {
			const held = this.held(radio);
			if (!held) {
				outcome = this.sameRow(radio) ? "moved" : "replaced";
				return;
			}
			// Re-read this radio's profiles: a choice must act on NetworkManager's
			// current marks, not on what an earlier tick cached.
			await this.loadProfiles(this.deps.radios(), held);
			if (!this.held(radio)) {
				outcome = "replaced";
				return;
			}
			await this.markChoice(held, uuid);
		});
		if (!locked || outcome === "moved") {
			// Busy, or the same row now resolves to another owner: try again under
			// whatever lock the row resolves to on the next tick.
			const now = this.sameRow(radio);
			if (now) this.pending.set(radio.id, { radio: now, uuid, seq });
			else this.settleChoice(radio.id, seq);
			return;
		}
		this.settleChoice(radio.id, seq);
		if (outcome === "replaced") {
			logger.warn(
				`Wi-Fi diversity: ${radio.ifname} was replaced before its choice was recorded; nothing written`,
			);
		}
	}

	private settleChoice(id: string, seq: number) {
		if (this.latestChoice.get(id) === seq) this.latestChoice.delete(id);
	}

	/** The current projection of the same physical radio and registry row. */
	private sameRow(radio: DiversityRadio): DiversityRadio | undefined {
		return this.deps
			.radios()
			.find(
				(r) =>
					r.id === radio.id &&
					r.mac === radio.mac &&
					r.admission?.row === radio.admission?.row,
			);
	}

	/** Under the radio's lock: the operator's choice becomes its only mark. */
	private async markChoice(radio: DiversityRadio, uuid: ConnectionUUID) {
		const ssid = ssidOf(radio, uuid);
		this.resetTrack(radio.id, true);
		if (ssid === null || this.profiles.get(uuid)?.mac !== radio.mac) {
			// The operator chose something we cannot mark. An old mark would make
			// the check undo that choice, so the radio is left without one.
			logger.info(
				`Wi-Fi diversity: ${radio.mac} chose a profile not bound to it; clearing its preference`,
			);
			for (const profile of this.bound(radio)) {
				if (
					this.profiles.get(profile.uuid)?.priority ===
					WIFI_CHOSEN_NETWORK_PRIORITY
				) {
					if (!this.held(radio)) return;
					await this.writePriority(profile.uuid, 0);
				}
			}
			return;
		}
		for (const profile of this.bound(radio)) {
			const priority = this.profiles.get(profile.uuid)?.priority;
			const want =
				profile.ssid === ssid
					? WIFI_CHOSEN_NETWORK_PRIORITY
					: priority === WIFI_CHOSEN_NETWORK_PRIORITY
						? 0
						: undefined;
			if (want === undefined || want === priority) continue;
			if (!this.held(radio)) return;
			await this.writePriority(profile.uuid, want);
		}
		const marks = new Set(
			this.bound(radio)
				.filter(
					(p) =>
						this.profiles.get(p.uuid)?.priority ===
						WIFI_CHOSEN_NETWORK_PRIORITY,
				)
				.map((p) => p.ssid),
		);
		if (marks.size !== 1) {
			logger.warn(
				`Wi-Fi diversity: ${radio.mac} has ${marks.size} marked networks after a choice; its preference is ignored`,
			);
		}
	}

	private async writePriority(uuid: ConnectionUUID, priority: number) {
		const ok = await this.deps.setPriority(uuid, priority);
		const old = this.profiles.get(uuid);
		if (ok && old) this.profiles.set(uuid, { ...old, priority });
		return ok;
	}

	/** The radio's own profiles: bound to its MAC. */
	private bound(radio: DiversityRadio) {
		const out: Array<{ ssid: SSID; uuid: ConnectionUUID }> = [];
		for (const ssid in radio.savedAll) {
			for (const uuid of radio.savedAll[ssid] ?? []) {
				if (this.profiles.get(uuid)?.mac === radio.mac)
					out.push({ ssid, uuid });
			}
		}
		return out;
	}

	/** The radio's preferred network and the bound profile to reach it. */
	private preferred(radio: DiversityRadio) {
		const marked = this.bound(radio).filter(
			(p) =>
				this.profiles.get(p.uuid)?.priority === WIFI_CHOSEN_NETWORK_PRIORITY,
		);
		const ssids = new Set(marked.map((p) => p.ssid));
		// Two marked networks is not a choice CeraUI made; ignore it.
		return ssids.size === 1 ? marked[0] : undefined;
	}

	private async loadProfiles(
		radios: readonly DiversityRadio[],
		fresh?: DiversityRadio,
	) {
		if (fresh) {
			for (const ssid in fresh.savedAll) {
				for (const uuid of fresh.savedAll[ssid] ?? []) {
					this.profiles.delete(uuid);
				}
			}
		}
		const present = new Set<ConnectionUUID>();
		for (const radio of radios) {
			for (const ssid in radio.savedAll) {
				for (const uuid of radio.savedAll[ssid] ?? []) present.add(uuid);
			}
		}
		for (const uuid of present) {
			if (this.profiles.has(uuid)) continue;
			const profile = await this.deps.readProfile(uuid);
			if (profile) this.profiles.set(uuid, profile);
		}
		for (const uuid of [...this.profiles.keys()]) {
			if (!present.has(uuid)) this.profiles.delete(uuid);
		}
	}

	private track(id: string, now: number): Track {
		let t = this.tracks.get(id);
		if (!t) {
			t = {
				uuid: null,
				since: now,
				dupTicks: 0,
				scans: 0,
				nextScanAt: 0,
				lastScanAt: undefined,
				lastCandidateAt: undefined,
				listed: false,
				lastEarlyScanAt: undefined,
				sighting: undefined,
				nextMoveAt: 0,
				reverts: 0,
				parkedSignal: undefined,
				moved: undefined,
			};
			this.tracks.set(id, t);
		}
		return t;
	}

	/** Forget an episode; `all` also forgets reverts and parking. */
	private resetTrack(id: string, all = false) {
		const t = this.tracks.get(id);
		if (!t) return;
		t.dupTicks = 0;
		t.sighting = undefined;
		if (all) {
			t.scans = 0;
			t.nextScanAt = 0;
			t.lastCandidateAt = undefined;
			t.listed = false;
			t.nextMoveAt = 0;
			t.reverts = 0;
			t.parkedSignal = undefined;
			t.moved = undefined;
		}
	}

	private backoff(t: Track, now: number) {
		t.reverts += 1;
		t.nextMoveAt =
			now +
			Math.min(
				WIFI_DIVERSITY.moveBackoffMs * 2 ** (t.reverts - 1),
				WIFI_DIVERSITY.moveBackoffMaxMs,
			);
	}

	private view(radios: readonly DiversityRadio[], links: DiversityLinks) {
		return radios.map((radio): Seen => {
			const uuid = links.get(radio.ifname) ?? null;
			return { radio, uuid, ssid: ssidOf(radio, uuid) };
		});
	}

	private async evaluate(): Promise<void> {
		const now = this.deps.now();
		this.startedAt ??= now;
		const radios = this.deps.radios();
		const links = await this.deps.readLinks();
		if (!links) return;
		await this.loadProfiles(radios);
		const seen = this.view(radios, links);

		// A radio that left (or came back with a new lifetime) keeps nothing.
		const present = new Set(radios.map((r) => r.id));
		for (const id of [...this.tracks.keys()]) {
			if (!present.has(id)) this.tracks.delete(id);
		}
		for (const { radio, uuid } of seen) {
			const t = this.track(radio.id, now);
			if (t.uuid !== uuid) {
				if (
					t.moved &&
					t.uuid === t.moved.uuid &&
					now - t.moved.at < WIFI_DIVERSITY.holdMs
				) {
					// The network we moved to did not hold: escalate, maybe park.
					this.backoff(t, now);
					if (t.reverts >= WIFI_DIVERSITY.parkAfterReverts) {
						t.parkedSignal = t.moved.signal;
						t.nextMoveAt = now + WIFI_DIVERSITY.moveBackoffMaxMs;
						logger.warn(
							`Wi-Fi diversity: ${radio.mac} keeps dropping its own network; waiting for a stronger signal or the operator`,
						);
					}
					t.moved = undefined;
				}
				t.uuid = uuid;
				t.since = now;
			} else if (
				t.moved &&
				uuid === t.moved.uuid &&
				now - t.moved.at >= WIFI_DIVERSITY.holdMs
			) {
				t.moved = undefined;
				t.reverts = 0;
				t.parkedSignal = undefined;
			}
		}

		for (const s of seen) {
			const t = this.track(s.radio.id, now);
			if (
				(t.reverts > 0 || t.parkedSignal !== undefined) &&
				s.uuid !== null &&
				s.uuid === this.preferred(s.radio)?.uuid &&
				now - t.since >= WIFI_DIVERSITY.holdMs
			) {
				// The preferred network held without us: it is usable again.
				t.reverts = 0;
				t.parkedSignal = undefined;
				t.nextMoveAt = 0;
			}
		}

		await this.migrate(seen, now);
		const listed = this.deps.listed?.() ?? new Map<SSID, number>();

		const used = new Map<SSID, number>();
		const active = new Set<ConnectionUUID>();
		for (const s of seen) {
			if (s.uuid !== null) active.add(s.uuid);
			if (s.ssid !== null) used.set(s.ssid, (used.get(s.ssid) ?? 0) + 1);
		}
		const settled = seen.every(
			(s) => now - this.track(s.radio.id, now).since >= WIFI_DIVERSITY.settleMs,
		);

		let pick:
			| { seen: Seen; target: { ssid: SSID; uuid: ConnectionUUID } }
			| undefined;
		for (const s of seen) {
			const t = this.track(s.radio.id, now);
			const target = this.preferred(s.radio);
			const candidate =
				s.ssid !== null &&
				(used.get(s.ssid) ?? 0) >= 2 &&
				!this.busy.has(s.radio.id) &&
				!this.pending.has(s.radio.id) &&
				target !== undefined &&
				target.ssid !== s.ssid &&
				!used.has(target.ssid) &&
				!active.has(target.uuid);
			if (!candidate) {
				this.resetTrack(s.radio.id);
				// A short blip keeps the episode's scan budget; a real gap resets it.
				if (
					t.lastCandidateAt === undefined ||
					now - t.lastCandidateAt >= WIFI_DIVERSITY.episodeGapMs
				) {
					t.scans = 0;
					t.nextScanAt = 0;
					t.lastCandidateAt = undefined;
				}
				t.listed = false;
				continue;
			}
			t.dupTicks += 1;
			t.lastCandidateAt = now;
			// Listed only counts at a usable signal, so a marginal AP flickering
			// in and out of the merged list cannot keep pulling scans forward.
			const nowListed =
				(listed.get(target.ssid) ?? 0) >= WIFI_DIVERSITY.signalFloor;
			if (
				nowListed &&
				!t.listed &&
				t.lastScanAt !== undefined &&
				(t.lastEarlyScanAt === undefined ||
					now - t.lastEarlyScanAt >= WIFI_DIVERSITY.earlyScanGapMs)
			) {
				// Newly listed in the merged scan: one early scan, never a move.
				const early = t.lastScanAt + WIFI_DIVERSITY.sightingGapMs;
				if (early < t.nextScanAt) {
					t.nextScanAt = early;
					t.lastEarlyScanAt = now;
				}
			}
			t.listed = nowListed;
			if (
				!pick &&
				settled &&
				t.dupTicks >= WIFI_DIVERSITY.confirmTicks &&
				now >= t.nextMoveAt &&
				now >= t.nextScanAt
			) {
				pick = { seen: s, target };
			}
		}
		if (pick) await this.act(pick.seen, pick.target);
	}

	/** Mark each radio's own network on an upgraded box, once, conservatively. */
	private async migrate(seen: readonly Seen[], now: number) {
		if (this.migrated) return;
		if (now - (this.startedAt ?? now) > WIFI_DIVERSITY.migrationWindowMs) {
			this.migrated = true;
			return;
		}
		if (
			seen.some((s) =>
				this.bound(s.radio).some(
					(p) =>
						this.profiles.get(p.uuid)?.priority ===
						WIFI_CHOSEN_NETWORK_PRIORITY,
				),
			)
		) {
			this.migrated = true;
			return;
		}
		const connected = seen.filter((s) => s.uuid !== null);
		if (connected.length < 2) return;
		const ssids = new Set(connected.map((s) => s.ssid));
		const ready =
			ssids.size === connected.length &&
			connected.every(
				(s) =>
					s.ssid !== null &&
					this.profiles.get(s.uuid as ConnectionUUID)?.mac === s.radio.mac &&
					now - this.track(s.radio.id, now).since >=
						WIFI_DIVERSITY.migrationStableMs,
			) &&
			seen.every(
				(s) =>
					now - this.track(s.radio.id, now).since >=
					WIFI_DIVERSITY.migrationStableMs,
			);
		if (!ready) return;
		// All marks or none, each written under its radio's current owner lock;
		// a busy or replaced radio leaves the migration for a later tick.
		const locks = [...new Set(connected.map((s) => s.radio.lock))].sort();
		await this.withLocks(locks, async () => {
			if (
				connected.some(
					(s) =>
						!this.held(s.radio) ||
						this.busy.has(s.radio.id) ||
						this.pending.has(s.radio.id),
				)
			)
				return;
			const links = await this.deps.readLinks();
			if (
				!links ||
				connected.some((s) => (links.get(s.radio.ifname) ?? null) !== s.uuid)
			)
				return;
			this.migrated = true;
			for (const s of connected) {
				if (!this.held(s.radio)) return;
				logger.info(
					`Wi-Fi diversity: marking ${JSON.stringify(s.ssid)} as the network of ${s.radio.mac}`,
				);
				await this.writePriority(
					s.uuid as ConnectionUUID,
					WIFI_CHOSEN_NETWORK_PRIORITY,
				);
			}
		});
	}

	/** Run `fn` holding every lock in `locks` (sorted), or not at all. */
	private async withLocks(
		locks: readonly WifiAdapterLockKey[],
		fn: () => Promise<void>,
	): Promise<boolean> {
		const [first, ...rest] = locks;
		if (first === undefined) {
			await fn();
			return true;
		}
		let inner = false;
		const outer = await this.deps.withLock(first, async () => {
			inner = await this.withLocks(rest, fn);
		});
		return outer && inner;
	}

	private async act(
		s: Seen,
		target: { ssid: SSID; uuid: ConnectionUUID },
	): Promise<void> {
		const radio = s.radio;
		const t = this.track(radio.id, this.deps.now());
		// An operator choice in flight or waiting for this lock wins.
		const yields = () =>
			this.busy.has(radio.id) ||
			this.pending.has(radio.id) ||
			!this.held(radio);
		await this.deps.withLock(radio.lock, async () => {
			if (yields()) return;
			// Re-read: the plan must still hold right before we touch the link.
			if (!(await this.stillShared(s, target))) return;

			const now = this.deps.now();
			if (now < t.nextScanAt) return;
			const scan = await this.deps.scan(s.radio.ifname);
			t.scans += 1;
			t.lastScanAt = now;
			const delays = WIFI_DIVERSITY.scanDelaysMs;
			t.nextScanAt =
				now +
				(t.scans <= delays.length
					? (delays[t.scans - 1] as number)
					: WIFI_DIVERSITY.scanSlowMs);
			if (!scan) return;

			const signal = scan.get(target.ssid);
			const current = s.ssid === null ? 0 : (scan.get(s.ssid) ?? 0);
			const good =
				signal !== undefined &&
				signal >= WIFI_DIVERSITY.signalFloor &&
				signal >= current - WIFI_DIVERSITY.signalMargin &&
				(t.parkedSignal === undefined ||
					signal >= t.parkedSignal + WIFI_DIVERSITY.parkSignalGain);
			if (!good) {
				t.sighting = undefined;
				return;
			}
			if (
				!t.sighting ||
				now - t.sighting.at > WIFI_DIVERSITY.sightingMaxAgeMs
			) {
				// First sighting: confirm with a second scan after the gap.
				t.sighting = { at: now, signal };
				t.nextScanAt = now + WIFI_DIVERSITY.sightingGapMs;
				return;
			}
			if (now - t.sighting.at < WIFI_DIVERSITY.sightingGapMs) return;
			t.sighting = undefined;
			if (!(await this.stillShared(s, target)) || yields()) return;

			logger.info(
				`Wi-Fi diversity: moving ${radio.mac} back to its own network ${JSON.stringify(target.ssid)} (signal ${signal})`,
			);
			const ok = await this.deps.activate(target.uuid, s.radio.ifname);
			const after = this.deps.now();
			if (ok) {
				t.moved = { uuid: target.uuid, at: after, signal };
				// The episode ended; a later fallback starts with a full scan budget.
				t.scans = 0;
				t.nextScanAt = 0;
				t.lastCandidateAt = undefined;
				// We know the link changed; a revert before the next tick still counts.
				t.uuid = target.uuid;
				t.since = after;
				return;
			}
			logger.warn(
				`Wi-Fi diversity: could not move ${radio.mac} to ${JSON.stringify(target.ssid)}; restoring its previous link`,
			);
			this.backoff(t, after);
			if (!this.held(radio)) return;
			if (
				s.uuid !== null &&
				!(await this.deps.activate(s.uuid, s.radio.ifname))
			) {
				logger.warn(
					`Wi-Fi diversity: could not restore ${radio.mac}'s previous link; NetworkManager's autoconnect has to recover it`,
				);
			}
		});
	}

	private async stillShared(
		s: Seen,
		target: { ssid: SSID; uuid: ConnectionUUID },
	): Promise<boolean> {
		const links = await this.deps.readLinks();
		if (!links) return false;
		if ((links.get(s.radio.ifname) ?? null) !== s.uuid || s.ssid === null) {
			return false;
		}
		const seen = this.view(this.deps.radios(), links);
		let sharing = 0;
		for (const other of seen) {
			if (other.uuid === target.uuid || other.ssid === target.ssid)
				return false;
			if (other.ssid === s.ssid) sharing += 1;
		}
		return sharing >= 2;
	}
}

// ─── runtime wiring ──────────────────────────────────────────────────────────

/**
 * Project a registry row onto the check's view; undefined when exempt or when
 * the row is not a verified radio (Limited, Unverified, degraded, or not the
 * exact registry object its identity names).
 */
export function diversityRadioOf(
	registryKey: string,
	wifiInterface: WifiInterface,
): DiversityRadio | undefined {
	if (
		wifiInterface.removed ||
		isApMode(wifiInterface) ||
		isConcurrentHotspot(wifiInterface)
	) {
		return undefined;
	}
	const admission = admitWifiAdapter(registryKey);
	if (admission?.row !== wifiInterface) return undefined;
	return {
		id: physicalWifiAdapterId(admission),
		mac: admission.permanentMac,
		lock: admission.owner,
		ifname: wifiInterface.ifname,
		savedAll: wifiInterface.savedAll ?? {},
		admission,
	};
}

function liveRadios(): DiversityRadio[] {
	const radios: DiversityRadio[] = [];
	const interfaces = getWifiInterfacesByMacAddress();
	for (const registryKey in interfaces) {
		const wifiInterface = interfaces[registryKey];
		if (!wifiInterface) continue;
		const radio = diversityRadioOf(registryKey, wifiInterface);
		if (radio) radios.push(radio);
	}
	return radios;
}

/** Parse `nmcli -t -f DEVICE,TYPE,STATE,CON-UUID device status` rows. */
export function parseDiversityLinks(rows: readonly string[]): DiversityLinks {
	const links = new Map<string, ConnectionUUID | null>();
	for (const row of rows) {
		if (!row) continue;
		const [device, type, state, uuid] = nmcliParseSep(row);
		if (!device || type !== "wifi") continue;
		const connected = state?.startsWith("connected") && uuid && uuid !== "--";
		links.set(device, connected ? uuid : null);
	}
	return links;
}

/**
 * The live check. `overrides` replaces NetworkManager access in tests; the
 * registry projection, the adapter lock and its re-check stay live unless
 * overridden too.
 */
export function createLiveWifiNetworkDiversity(
	overrides: Partial<WifiNetworkDiversityDeps> = {},
): WifiNetworkDiversity {
	return new WifiNetworkDiversity({
		radios: liveRadios,
		current: (radio) =>
			radio.admission !== undefined &&
			wifiAdapterAdmissionCurrent(radio.admission),
		readLinks: async () => {
			const rows = await nmDevices("DEVICE,TYPE,STATE,CON-UUID");
			return rows ? parseDiversityLinks(rows) : undefined;
		},
		readProfile: async (uuid) => {
			const fields = await nmConnGetFields(uuid, [
				"connection.autoconnect-priority",
				"802-11-wireless.mac-address",
			] as const);
			if (!fields) return undefined;
			const priority = Number.parseInt(fields[0] ?? "", 10);
			return {
				priority: Number.isNaN(priority) ? 0 : priority,
				mac: normalizeMacAddress(fields[1]),
			};
		},
		setPriority: (uuid, priority) =>
			nmConnSetFields(uuid, {
				"connection.autoconnect-priority": String(priority),
			}),
		scan: (ifname) => nmScanDevice(ifname),
		activate: async (uuid, ifname) => {
			const ok = await nmConnect(
				uuid,
				WIFI_DIVERSITY.activateTimeoutS,
				undefined,
				ifname,
			);
			wifiScheduleScanRefresh();
			return ok;
		},
		withLock: async (key, fn) => (await withWifiAdapterLock(key, fn)).success,
		listed: () => {
			const ssids = new Map<SSID, number>();
			for (const wifiInterface of Object.values(
				getWifiInterfacesByMacAddress(),
			)) {
				for (const [ssid, network] of wifiInterface?.available ?? []) {
					ssids.set(ssid, Math.max(ssids.get(ssid) ?? 0, network.signal));
				}
			}
			return ssids;
		},
		now: () => Date.now(),
		...overrides,
	});
}

let live: WifiNetworkDiversity | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

function liveInstance(): WifiNetworkDiversity {
	live ??= createLiveWifiNetworkDiversity();
	return live;
}

/** Start the periodic check. Idempotent. */
export function startWifiNetworkDiversity(): void {
	if (timer !== undefined) return;
	const instance = liveInstance();
	timer = setInterval(() => {
		void instance.tick().catch((err) => {
			logger.warn(`Wi-Fi diversity check failed: ${err}`);
		});
	}, WIFI_DIVERSITY_TICK_MS);
	timer.unref?.();
}

export function stopWifiNetworkDiversity(): void {
	if (timer !== undefined) clearInterval(timer);
	timer = undefined;
}

/** An operator join/connect in flight on one physical radio. */
export type WifiOperatorChoice = {
	/** The join/connect settled; the check may consider the radio again. */
	readonly release: () => void;
	/**
	 * The operator chose `uuid` on the radio admitted when the choice began.
	 * Never rejects: recording the choice must not change the join's answer.
	 * Nothing is written when that radio was not verified or has since been
	 * replaced, even by a radio with the same name and MAC.
	 */
	readonly record: (uuid: ConnectionUUID) => Promise<void>;
};

/**
 * An operator join/connect is starting on the registry row `registryKey`. The
 * physical radio is admitted now, so the choice can never land on a radio that
 * replaced it while the join ran.
 */
export function beginWifiOperatorChoice(
	registryKey: string,
	instance: WifiNetworkDiversity = liveInstance(),
): WifiOperatorChoice {
	const admission = admitWifiAdapter(registryKey);
	if (!admission) {
		return {
			release: () => {
				// Nothing was flagged for a radio that was not admitted.
			},
			record: async () => {
				logger.info(
					`Wi-Fi diversity: ${registryKey} is not a verified radio; its choice is not recorded`,
				);
			},
		};
	}
	const id = physicalWifiAdapterId(admission);
	return {
		release: instance.beginOperatorChoice(id),
		record: async (uuid) => {
			const radio = liveRadios().find(
				(r) => r.id === id && r.admission?.row === admission.row,
			);
			if (!radio) {
				logger.info(
					`Wi-Fi diversity: ${admission.row.ifname} changed during the operator's choice; nothing recorded`,
				);
				return;
			}
			try {
				await instance.recordChoice(radio, uuid);
			} catch (err) {
				logger.warn(`Recording the Wi-Fi network choice failed: ${err}`);
			}
		},
	};
}
