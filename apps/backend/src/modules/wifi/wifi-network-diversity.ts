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
  network 2, which radio B already uses. That fallback is fine as a last resort,
  but NetworkManager never preempts an active connection, so A stays on network
  2 after network 1 comes back. The bond then has two links over one uplink, and
  losing that uplink drops the whole stream.

  Interface binding cannot fix this (the profile IS bound to the right radio),
  and autoconnect-priority alone cannot either (NetworkManager only consults it
  when choosing what to activate, not to leave a working connection).

  WHAT THIS DOES.
  - The radio's preferred network is the one the operator last chose for it in
    CeraUI (join or connect). That choice is stored in NetworkManager as
    `connection.autoconnect-priority = WIFI_CHOSEN_NETWORK_PRIORITY` on that
    radio's profile, so it survives restarts and also makes NetworkManager pick
    the chosen network first at boot. Without a recorded choice, the preferred
    network is the last one this radio held on its own during this run.
  - A radio that shares its network with a sibling while its preferred network
    is free and saved is moved back: immediately if the network is in the scan
    results, otherwise after a rescan of that radio only. Retries back off.
  - Nothing happens on a single-radio box, for a radio in AP mode, when the
    preferred network is the shared one (the operator put both radios there),
    or when another radio already holds the preferred network.

  Rescanning a connected radio stalls its traffic for a few seconds on some
  drivers. Only the radio that duplicates a sibling's uplink is ever rescanned,
  and only while it does, so the stall lands on the redundant link.
*/

import { logger } from "../../helpers/logger.ts";
import {
	type ConnectionUUID,
	nmConnect,
	nmConnGetFields,
	nmConnSetFields,
} from "../network/network-manager.ts";
import {
	type WifiAdapterLockKey,
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "./wifi-adapter-lock.ts";
import {
	getWifiInterfacesByMacAddress,
	wifiRescan,
	wifiScheduleScanRefresh,
} from "./wifi-connections.ts";
import { isApMode } from "./wifi-hotspot-types.ts";
import type {
	SSID,
	WifiInterface,
	WifiInterfaceId,
} from "./wifi-interfaces.ts";

/** Marks the operator's chosen network on a radio; below the hotspot's 999. */
export const WIFI_CHOSEN_NETWORK_PRIORITY = 10;
export const WIFI_DIVERSITY_TICK_MS = 10_000;
export const WIFI_DIVERSITY_FIRST_RETRY_MS = 15_000;
export const WIFI_DIVERSITY_MAX_RETRY_MS = 120_000;

export type DiversityRadio = {
	readonly key: WifiAdapterLockKey;
	readonly device: WifiInterfaceId;
	/** The station network this radio is connected to, or null. */
	readonly ssid: SSID | null;
	/** Every profile this radio holds per network. */
	readonly savedAll: Readonly<Record<SSID, readonly ConnectionUUID[]>>;
	/** One profile per network, the one CeraUI acts on. */
	readonly saved: Readonly<Record<SSID, ConnectionUUID>>;
	readonly visible: ReadonlySet<SSID>;
};

/** Move `key` back to `ssid`; rescan that radio first when it is not visible. */
export type DiversityAction = {
	readonly key: WifiAdapterLockKey;
	readonly device: WifiInterfaceId;
	readonly ssid: SSID;
	readonly uuid: ConnectionUUID;
	readonly visible: boolean;
};

function occupancy(radios: readonly DiversityRadio[]): Map<SSID, number> {
	const count = new Map<SSID, number>();
	for (const radio of radios) {
		if (radio.ssid !== null) {
			count.set(radio.ssid, (count.get(radio.ssid) ?? 0) + 1);
		}
	}
	return count;
}

/**
 * Decide which radios to move back to their own network. Pure: the caller
 * supplies each radio's preferred network.
 */
export function planWifiNetworkDiversity(
	radios: readonly DiversityRadio[],
	preferredFor: (key: WifiAdapterLockKey) => SSID | undefined,
): DiversityAction[] {
	const used = occupancy(radios);
	const claimed = new Set<SSID>();
	const actions: DiversityAction[] = [];
	for (const radio of radios) {
		if (radio.ssid === null || (used.get(radio.ssid) ?? 0) < 2) continue;
		const preferred = preferredFor(radio.key);
		if (preferred === undefined || preferred === radio.ssid) continue;
		// Moving onto a network another radio holds gains nothing; two radios
		// wanting the same free network: the first one gets it.
		if ((used.get(preferred) ?? 0) > 0 || claimed.has(preferred)) continue;
		const uuid = radio.saved[preferred];
		if (uuid === undefined) continue;
		claimed.add(preferred);
		actions.push({
			key: radio.key,
			device: radio.device,
			ssid: preferred,
			uuid,
			visible: radio.visible.has(preferred),
		});
	}
	return actions;
}

export type WifiNetworkDiversityDeps = {
	readonly radios: () => DiversityRadio[];
	readonly readPriority: (uuid: ConnectionUUID) => Promise<number | undefined>;
	readonly setPriority: (
		uuid: ConnectionUUID,
		priority: number,
	) => Promise<boolean>;
	readonly connect: (uuid: ConnectionUUID) => Promise<boolean>;
	readonly rescan: (device: WifiInterfaceId) => Promise<void>;
	/** Runs `fn` under the adapter lock; false when the adapter is busy. */
	readonly withLock: (
		key: WifiAdapterLockKey,
		fn: () => Promise<void>,
	) => Promise<boolean>;
	readonly now: () => number;
};

type Retry = { readonly at: number; readonly delay: number };

function savedSignature(radio: DiversityRadio): string {
	return Object.keys(radio.savedAll)
		.sort()
		.map((ssid) => `${ssid}=${[...(radio.savedAll[ssid] ?? [])].sort()}`)
		.join(";");
}

function ssidOfUuid(
	radio: DiversityRadio,
	uuid: ConnectionUUID,
): SSID | undefined {
	for (const ssid in radio.savedAll) {
		if (radio.savedAll[ssid]?.includes(uuid)) return ssid;
	}
	for (const ssid in radio.saved) {
		if (radio.saved[ssid] === uuid) return ssid;
	}
	return undefined;
}

export class WifiNetworkDiversity {
	/** Last network each radio held without a sibling on it, this run. */
	private readonly alone = new Map<WifiAdapterLockKey, SSID>();
	/** Chosen network read from NetworkManager, per saved-profile set. */
	private readonly chosen = new Map<
		WifiAdapterLockKey,
		{ readonly signature: string; readonly ssid: SSID | undefined }
	>();
	private readonly retries = new Map<WifiAdapterLockKey, Retry>();
	private running: Promise<void> | undefined;

	constructor(private readonly deps: WifiNetworkDiversityDeps) {}

	/** One evaluation; concurrent calls join the one in flight. */
	tick(): Promise<void> {
		this.running ??= this.evaluate().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}

	/**
	 * Record an operator's explicit choice of `uuid` on the radio `key`: it
	 * becomes that radio's preferred network, in memory and in NetworkManager.
	 */
	async recordChoice(
		key: WifiAdapterLockKey,
		uuid: ConnectionUUID,
	): Promise<void> {
		const radio = this.deps.radios().find((r) => r.key === key);
		if (!radio) return;
		const ssid = ssidOfUuid(radio, uuid);
		if (ssid === undefined) return;
		this.alone.set(key, ssid);
		this.chosen.set(key, { signature: savedSignature(radio), ssid });
		this.retries.delete(key);

		for (const other in radio.savedAll) {
			for (const profile of radio.savedAll[other] ?? []) {
				const priority = await this.deps.readPriority(profile);
				if (other === ssid) {
					if (priority !== WIFI_CHOSEN_NETWORK_PRIORITY) {
						await this.deps.setPriority(profile, WIFI_CHOSEN_NETWORK_PRIORITY);
					}
				} else if (priority === WIFI_CHOSEN_NETWORK_PRIORITY) {
					await this.deps.setPriority(profile, 0);
				}
			}
		}
	}

	private async loadChosen(radio: DiversityRadio): Promise<SSID | undefined> {
		const signature = savedSignature(radio);
		const cached = this.chosen.get(radio.key);
		if (cached && cached.signature === signature) return cached.ssid;

		const marked = new Set<SSID>();
		for (const ssid in radio.savedAll) {
			for (const profile of radio.savedAll[ssid] ?? []) {
				if (
					(await this.deps.readPriority(profile)) ===
					WIFI_CHOSEN_NETWORK_PRIORITY
				) {
					marked.add(ssid);
				}
			}
		}
		// Two marked networks is not a choice CeraUI made; ignore it.
		const ssid = marked.size === 1 ? [...marked][0] : undefined;
		this.chosen.set(radio.key, { signature, ssid });
		return ssid;
	}

	private async evaluate(): Promise<void> {
		const radios = this.deps.radios();
		const used = occupancy(radios);
		const present = new Set(radios.map((radio) => radio.key));
		for (const key of [...this.retries.keys()]) {
			if (!present.has(key)) this.retries.delete(key);
		}

		const preferred = new Map<WifiAdapterLockKey, SSID>();
		for (const radio of radios) {
			if (radio.ssid === null) continue;
			if ((used.get(radio.ssid) ?? 0) < 2) {
				this.alone.set(radio.key, radio.ssid);
				this.retries.delete(radio.key);
				continue;
			}
			const pick = (await this.loadChosen(radio)) ?? this.alone.get(radio.key);
			if (pick !== undefined) preferred.set(radio.key, pick);
		}

		const actions = planWifiNetworkDiversity(radios, (key) =>
			preferred.get(key),
		);
		const acting = new Set(actions.map((action) => action.key));
		for (const key of [...this.retries.keys()]) {
			if (!acting.has(key)) this.retries.delete(key);
		}

		for (const action of actions) {
			const retry = this.retries.get(action.key);
			const now = this.deps.now();
			if (retry && now < retry.at) continue;

			let moved = false;
			let attempted = false;
			const ran = await this.deps.withLock(action.key, async () => {
				let visible = action.visible;
				if (!visible) {
					await this.deps.rescan(action.device);
					visible =
						this.deps
							.radios()
							.find((radio) => radio.key === action.key)
							?.visible.has(action.ssid) ?? false;
				}
				if (!visible) return;
				logger.info(
					`Wi-Fi diversity: moving ${action.key} back to its own network ${JSON.stringify(action.ssid)}`,
				);
				attempted = true;
				moved = await this.deps.connect(action.uuid);
			});
			if (!ran) continue;
			if (moved) {
				this.retries.delete(action.key);
				continue;
			}
			if (attempted) {
				logger.warn(
					`Wi-Fi diversity: could not move ${action.key} to ${JSON.stringify(action.ssid)}`,
				);
			}
			const delay = retry
				? Math.min(retry.delay * 2, WIFI_DIVERSITY_MAX_RETRY_MS)
				: WIFI_DIVERSITY_FIRST_RETRY_MS;
			this.retries.set(action.key, { at: now + delay, delay });
		}
	}
}

// ─── runtime wiring ──────────────────────────────────────────────────────────

/** Project the live adapter table onto the planner's view. */
export function diversityRadioOf(
	macAddress: string,
	wifiInterface: WifiInterface,
): DiversityRadio | undefined {
	if (isApMode(wifiInterface) || wifiInterface.removed) return undefined;
	let ssid: SSID | null = null;
	if (wifiInterface.conn) {
		for (const candidate in wifiInterface.savedAll) {
			if (wifiInterface.savedAll[candidate]?.includes(wifiInterface.conn)) {
				ssid = candidate;
				break;
			}
		}
		if (ssid === null) {
			for (const candidate in wifiInterface.saved) {
				if (wifiInterface.saved[candidate] === wifiInterface.conn) {
					ssid = candidate;
					break;
				}
			}
		}
	}
	return {
		key: wifiAdapterLockKey(macAddress),
		device: wifiInterface.id,
		ssid,
		savedAll: wifiInterface.savedAll ?? {},
		saved: wifiInterface.saved,
		visible: new Set(wifiInterface.available.keys()),
	};
}

function liveRadios(): DiversityRadio[] {
	const radios: DiversityRadio[] = [];
	const interfaces = getWifiInterfacesByMacAddress();
	for (const macAddress in interfaces) {
		const wifiInterface = interfaces[macAddress];
		if (!wifiInterface) continue;
		const radio = diversityRadioOf(macAddress, wifiInterface);
		if (radio) radios.push(radio);
	}
	return radios;
}

export function createLiveWifiNetworkDiversity(): WifiNetworkDiversity {
	return new WifiNetworkDiversity({
		radios: liveRadios,
		readPriority: async (uuid) => {
			const fields = await nmConnGetFields(uuid, [
				"connection.autoconnect-priority",
			] as const);
			const value = Number.parseInt(fields?.[0] ?? "", 10);
			return Number.isNaN(value) ? undefined : value;
		},
		setPriority: (uuid, priority) =>
			nmConnSetFields(uuid, {
				"connection.autoconnect-priority": String(priority),
			}),
		connect: async (uuid) => {
			const ok = await nmConnect(uuid, 30);
			wifiScheduleScanRefresh();
			return ok;
		},
		rescan: (device) => wifiRescan(device),
		withLock: async (key, fn) => (await withWifiAdapterLock(key, fn)).success,
		now: () => Date.now(),
	});
}

let live: WifiNetworkDiversity | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

/** Start the periodic check. Idempotent. */
export function startWifiNetworkDiversity(): void {
	if (timer !== undefined) return;
	live ??= createLiveWifiNetworkDiversity();
	const instance = live;
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

/**
 * The operator chose `uuid` on the radio `macAddress` (a join or a connect).
 * Never throws: recording the choice must not change the join's answer.
 */
export function recordWifiNetworkChoice(
	macAddress: string,
	uuid: ConnectionUUID,
): void {
	live ??= createLiveWifiNetworkDiversity();
	void live.recordChoice(wifiAdapterLockKey(macAddress), uuid).catch((err) => {
		logger.warn(`Recording the Wi-Fi network choice failed: ${err}`);
	});
}
