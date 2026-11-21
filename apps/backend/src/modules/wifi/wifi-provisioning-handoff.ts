/*
  The handoff half of the image's first-boot setup. Once the operator submits a
  network, the setup joins it as a station on the setup radio with its fixed
  station profile, removes its marker and starts CeraUI again. A saved hotspot
  or hybrid intent for that radio would make CeraUI's restore replace the
  station the setup has just verified, so the setup join wins: the saved intent
  for the setup radio becomes `station` before restore acts.

  CeraUI is normally stopped for the whole marker lifetime and never sees the
  marker disappear, and the station profile also autoconnects on every later
  boot. Neither the marker nor the profile name alone therefore proves that a
  handoff has just happened. The portal deletes and re-adds the station profile
  for each submission, so a setup join is a station profile with that name, on
  the setup interface, whose UUID CeraUI has not accounted for yet. The first
  run of this code records the setup station profiles that already exist as a
  baseline, so an upgrade never mistakes an old setup station for a new join.
*/

import { logger } from "../../helpers/logger.ts";
import { getConfig, saveConfig } from "../config.ts";
import { nmConnsGet, nmcliParseSep } from "../network/network-manager.ts";
import { notifyWifiAdapterModeEdge } from "./wifi-adapter-mode-events.ts";
import type { WifiInterface } from "./wifi-interfaces.ts";
import { normalizeMacAddress } from "./wifi-permanent-mac.ts";
import {
	isProvisioningSetupActive,
	PROVISIONING_AP_IFNAME,
	PROVISIONING_STATION_CONNECTION_ID,
} from "./wifi-provisioning-ap.ts";

/** Bound on the accounted setup station UUIDs kept in the runtime config. */
const ACCOUNTED_STATIONS_LIMIT = 16;

export type ProvisioningHandoffDecision =
	/** Nothing for CeraUI to change; restore proceeds. */
	| "none"
	/** The setup's join was accounted and the setup radio's intent cleared. */
	| "handoff"
	/** The handoff could not be saved; restore waits for the next edge. */
	| "hold";

export interface ProvisioningHandoffDeps {
	/** NetworkManager's profile inventory as `uuid:name` rows. */
	readonly listConnections: () => Promise<string[] | undefined>;
}

export const provisioningHandoffDeps: ProvisioningHandoffDeps = {
	listConnections: () => nmConnsGet("uuid,name"),
};

/*
  The setup creates its station profile only while CeraUI is stopped or while
  its marker exists, so one inventory read per process, repeated after the
  marker disappears, sees every profile a handoff can have left.
*/
let setupStationInventory: Promise<readonly string[] | undefined> | undefined;

function readSetupStations(
	deps: ProvisioningHandoffDeps,
): Promise<readonly string[] | undefined> {
	if (setupStationInventory) return setupStationInventory;
	const inventory = deps.listConnections().then(
		(listed) =>
			listed?.flatMap((line) => {
				const [uuid, name] = nmcliParseSep(line);
				return uuid && name === PROVISIONING_STATION_CONNECTION_ID
					? [uuid]
					: [];
			}),
		() => undefined,
	);
	setupStationInventory = inventory;
	// A failed read proves nothing; the next pass reads again.
	void inventory.then((stations) => {
		if (stations === undefined && setupStationInventory === inventory)
			setupStationInventory = undefined;
	});
	return inventory;
}

function saveHandoff(
	stations: readonly string[],
	clear: ((key: string) => boolean) | undefined,
): Record<string, string> {
	const config = getConfig();
	const previousStations = config.wifi_setup_stations;
	const previousModes = config.wifi_modes;
	const cleared: Record<string, string> = {};
	config.wifi_setup_stations = stations.slice(-ACCOUNTED_STATIONS_LIMIT);
	if (clear) {
		const next = { ...(previousModes ?? {}) };
		for (const [key, mode] of Object.entries(next))
			if ((mode === "hotspot" || mode === "hybrid") && clear(key)) {
				next[key] = "station";
				cleared[key] = mode;
			}
		config.wifi_modes = next;
	}
	try {
		saveConfig();
	} catch (error: unknown) {
		config.wifi_setup_stations = previousStations;
		config.wifi_modes = previousModes;
		throw error;
	}
	return cleared;
}

/**
 * Run once per restore pass for the setup radio, under its owner lock and
 * before restore reads the saved intent. `intentKeys` are the radio's logical
 * owner and intent keys; keys sharing the radio's permanent MAC are cleared
 * with them, and no other radio's intent is touched. A setup station profile
 * that exists but is not the radio's active station is left unaccounted: the
 * setup ended without a join this process can see, and the intent is kept.
 */
export async function settleProvisioningHandoff(
	row: WifiInterface,
	registryKey: string,
	intentKeys: readonly string[],
	deps: ProvisioningHandoffDeps = provisioningHandoffDeps,
): Promise<ProvisioningHandoffDecision> {
	if (row.ifname !== PROVISIONING_AP_IFNAME || isProvisioningSetupActive())
		return "none";
	const stations = await readSetupStations(deps);
	// The inventory read may have awaited; the setup may have started meanwhile.
	if (stations === undefined || isProvisioningSetupActive()) return "none";
	const accounted = getConfig().wifi_setup_stations;
	if (accounted === undefined) {
		try {
			saveHandoff(stations, undefined);
		} catch (error: unknown) {
			logger.warn(
				`the device image's setup baseline could not be saved: ${error instanceof Error ? error.name : "unknown"}`,
			);
			return "none";
		}
		logger.info(
			`recorded ${stations.length} existing setup station profile(s) as the setup baseline`,
		);
		return "none";
	}
	const station =
		row.activeMode === "infrastructure" ? row.activeConn : undefined;
	if (!station || accounted.includes(station) || !stations.includes(station))
		return "none";
	const mac = normalizeMacAddress(registryKey.split("@")[0]);
	const keys = new Set(intentKeys);
	let cleared: Record<string, string>;
	try {
		cleared = saveHandoff([...accounted, station], (key) => {
			if (keys.has(key)) return true;
			return (
				mac !== undefined && normalizeMacAddress(key.split("@")[0]) === mac
			);
		});
	} catch (error: unknown) {
		logger.warn(
			`wifi setup handoff: could not save the handoff of ${row.ifname}: ${error instanceof Error ? error.name : "unknown"}; restore waits`,
		);
		return "hold";
	}
	logger.info(
		`the device image's setup handed ${row.ifname} over as a station on ${station}; ${
			Object.keys(cleared).length > 0
				? `its saved ${[...new Set(Object.values(cleared))].join("/")} intent is now station`
				: "no saved hotspot intent to clear"
		}`,
	);
	return "handoff";
}

/**
 * CeraUI normally sleeps through the setup, but when it runs it must notice
 * the marker's edges itself: restore deferred on the marker resumes when it
 * disappears, and the handoff is decided then.
 */
export function startProvisioningMarkerWatch(intervalMs = 2000): () => void {
	let active = isProvisioningSetupActive();
	if (active)
		logger.info(
			`the device image's setup is active; hotspot actions on ${PROVISIONING_AP_IFNAME} wait for it`,
		);
	const timer = setInterval(() => {
		const now = isProvisioningSetupActive();
		if (now === active) return;
		active = now;
		if (!now) setupStationInventory = undefined;
		logger.info(
			now
				? `the device image's setup started; hotspot actions on ${PROVISIONING_AP_IFNAME} wait for it`
				: `the device image's setup ended; resuming hotspot restore on ${PROVISIONING_AP_IFNAME}`,
		);
		void notifyWifiAdapterModeEdge();
	}, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}

export function resetProvisioningHandoffForTest(): void {
	setupStationInventory = undefined;
}
