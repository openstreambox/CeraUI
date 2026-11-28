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

import {
	getNetworkInterfaceIncarnation,
	refreshWifiApClientZones,
} from "../network/network-interfaces.ts";
import { hotspotSteeringPending } from "../network/uplink-steering/readiness.ts";

/* NetworkManager / nmcli based Wifi Manager */

import {
	canReuseWifiStationProfile,
	classifyWifiStationSecurity,
	wifiStationAllowsBlankPassword,
} from "@ceraui/rpc";
import type {
	WifiAdapterCapabilities,
	WifiInterface as WifiInterfaceWire,
	WifiMessage as WifiMessageWire,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { pollWithBackoff } from "../../helpers/retry.ts";
import { DEFAULT_SPAWN_TIMEOUT_MS } from "../../helpers/spawn-policy.ts";
import { extractMessage } from "../../helpers/types.ts";
import {
	getMockState,
	getScenarioConfig,
	getWifiSignal,
	mockWifiNetworks,
	mockWifiRadios,
	mockWifiUuidForSsid,
	shouldUseMocks,
} from "../../mocks/mock-service.ts";
import {
	getMockHotspotClients,
	getMockHotspotConfig,
	isMockWifiLimited,
} from "../../mocks/providers/wifi.ts";
import { getMockWifiIncarnation } from "../../mocks/providers/wifi-incarnation.ts";
import {
	type ConnectionUUID,
	type MacAddress,
	nmConnDelete,
	nmConnect,
	nmConnGetFields,
	nmConnSetWifiMacAddress,
	nmConnsGet,
	nmcliParseSep,
	parseNmConnActivated,
	parseNmConnAddUuid,
	readNmDeviceActivation,
} from "../network/network-manager.ts";
import type { ProfileWriteAdmission } from "../network/profile-write-permit.ts";
import { describePrivateCliError } from "../system/cli-parse.ts";
import type { MessageSocket } from "../ui/message-socket.ts";
import {
	broadcastMsg,
	broadcastMsgLocal,
	buildMsg,
	getSocketSenderId,
} from "../ui/websocket-server.ts";
import {
	afterWifiAdapterLockRelease,
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "./wifi-adapter-lock.ts";
import { displayObservedWifiAdapterMode } from "./wifi-adapter-mode.ts";
import {
	getWifiCapabilitiesForInterface,
	getWifiLinkTelemetryForInterface,
	refreshWifiLinkTelemetry,
	type WifiLinkTelemetry,
} from "./wifi-capabilities.ts";
import { getWifiChannelMap } from "./wifi-channels.ts";
import {
	getWifiInterfaceByMacAddress,
	getWifiInterfacesByMacAddress,
	getWifiScanStampForDevice,
	wifiRescan,
	wifiScheduleScanRefresh,
	wifiUpdateScanResult,
} from "./wifi-connections.ts";
import { wifiHotspotStart } from "./wifi-hotspot-activation.ts";
import {
	nmDisconnectActivation,
	observeHotspotActivation,
} from "./wifi-hotspot-activity.ts";
import {
	buildHotspotClients,
	type HotspotClients,
	hotspotClientsForMessage,
	recordHotspotClientsBroadcast,
} from "./wifi-hotspot-clients.ts";
import { bindingForRow } from "./wifi-operation-binding.ts";
import { normalizeMacAddress } from "./wifi-permanent-mac.ts";

export { currentHotspotApIfnames } from "./wifi-hotspot-clients.ts";

import { isQualifiedNmManagedHybrid } from "./wifi-concurrent-interface.ts";
import { captureWifiFrameIncarnation } from "./wifi-frame-binding.ts";
import { wifiHotspotConfig, wifiHotspotStop } from "./wifi-hotspot-config.ts";
import { handleHotspotConn } from "./wifi-hotspot-discovery.ts";
import { publishHotspotOutcome } from "./wifi-hotspot-outcome.ts";
import { hotspotAwaitingSteering } from "./wifi-hotspot-readiness.ts";
import {
	getHotspotSecurityMap,
	type HotspotBandMaxWidth,
	offeredHotspotMaxWidth,
	offeredHotspotSecurity,
} from "./wifi-hotspot-security.ts";
import { projectHotspotTransition } from "./wifi-hotspot-transition.ts";
import {
	canHotspot,
	isApMode,
	isConcurrentHotspot,
	type WifiHotspot,
	type WifiHotspotMessage,
} from "./wifi-hotspot-types.ts";
import {
	type BaseWifiInterface,
	getMacAddressForWifiInterface,
	getWifiIdToMacAddress,
	type SSID,
	type WifiInterface,
	type WifiInterfaceId,
} from "./wifi-interfaces.ts";
import { projectWifiModeWitness } from "./wifi-mode-witness.ts";
import {
	beginWifiOperatorChoice,
	type WifiOperatorChoice,
} from "./wifi-network-diversity.ts";
import {
	type ReadRadioInventory,
	wifiRadioIdentity,
} from "./wifi-radio-identity.ts";
import {
	projectWifiRadioIncarnation,
	setWifiRadioPublicationListener,
} from "./wifi-radio-publication.ts";
import {
	type AdmittedWifiStationJoinPlan,
	planOpenWifiJoin,
	planWifiStationJoin,
	saeActivateArgs,
} from "./wifi-station-security.ts";

const errorText = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

type WifiConnectMessage = {
	connect: ConnectionUUID;
};

type WifiDisconnectMessage = {
	disconnect: ConnectionUUID;
};

type WifiNewMessage = {
	new: {
		device: WifiInterfaceId;
		ssid: SSID;
		password?: string;
		security?: string;
		bssid?: string;
	};
};

type WifiForgetMessage = {
	forget: ConnectionUUID;
};

type WifiScanMessage = {
	scan: WifiInterfaceId;
};

export type WifiMessage = {
	wifi:
		| WifiConnectMessage
		| WifiDisconnectMessage
		| WifiNewMessage
		| WifiForgetMessage
		| WifiScanMessage
		| WifiHotspotMessage;
};

// 1 - 100
type WifiSignalStrength = number;

export type WifiNetwork = {
	active: boolean; // is it currently connected?
	ssid: SSID;
	bssid?: string;
	signal: WifiSignalStrength;
	security: string;
	freq: number;
};

/* Builds the WiFi status structure sent over the network from the <wd> structures */
export type WifiInterfaceResponseMessage = Pick<
	BaseWifiInterface,
	"ifname" | "hw" | "saved"
> & {
	// Empty string = no active connection (the wire convention every build path
	// uses); the real path coerces BaseWifiInterface.conn's null to "" to match.
	conn: string;
	incarnation?: WifiInterfaceWire["incarnation"];
	available?: Array<WifiNetwork>;
	saved_key_mgmt?: WifiInterfaceWire["saved_key_mgmt"];
	hotspot?: Pick<WifiHotspot, "name" | "password" | "channel" | "security"> & {
		available_channels: Record<string, { name: string }>;
		available_security: Record<string, { name: string }>;
		// DISPLAY ONLY — there is no configurable width in this contract.
		max_width_mhz?: HotspotBandMaxWidth;
		// Absent until the AP's own station dump has been read once; a read that
		// found nobody publishes an explicit `count: 0`.
		clients?: HotspotClients;
		warnings?: string[];
	};
	supports_hotspot?: true;
	supports_ap_sta_concurrency?: true;
	mode?: "station" | "hotspot";
	observed_mode?: WifiInterfaceWire["observed_mode"];
	leaving?: WifiInterfaceWire["leaving"];
	transition?: "activating" | "deactivating";
	degraded_reason?: BaseWifiInterface["degradedReason"];
	// Absent means NOT COMPUTED (no `iw`, an unresolvable wiphy, or a dump that
	// failed its named parser); once computed it rides EVERY tick.
	capabilities?: WifiAdapterCapabilities;
	// The STATION leg's live negotiated rate. Absent on an AP-mode radio, on a
	// station holding no connection, and until the first read has landed.
	link?: WifiLinkTelemetry;
	// This adapter's completed-scan counter and the moment it last advanced.
	// Absent until the adapter has completed one scan cycle — a consumer confirms
	// its own scan by the generation ADVANCING, never by the list changing.
	scanGeneration?: number;
	scanAt?: number;
};

/*
  Stamp the adapter's last completed scan cycle onto its wire row.

  It rides EVERY tick rather than only the tick that advanced it, so a consumer
  never has to decide whether a missing generation means "unchanged" or
  "withdrawn" — the same rule `capabilities` states directly above.
*/
function applyScanStamp(
	entry: WifiInterfaceResponseMessage,
	device: WifiInterfaceId,
): void {
	const stamp = getWifiScanStampForDevice(device);
	if (stamp === undefined) return;
	entry.scanGeneration = stamp.generation;
	entry.scanAt = stamp.at;
}

export function wifiBuildMsg() {
	return buildWifiSnapshot(true);
}

export function wifiBuildLegacyRemoteMsg() {
	return buildWifiSnapshot(true, { legacyTransitions: true });
}

type WifiStatusRows = Record<string, WifiInterfaceResponseMessage>;

const hybridStatusEvidence = new WeakMap<
	WifiInterface,
	{ readonly incarnation: string | undefined; readonly qualified: boolean }
>();

function buildWifiSnapshot(
	refreshTelemetry: boolean,
	{
		legacyTransitions,
		legacyOverrides,
	}: {
		readonly legacyTransitions?: boolean;
		readonly legacyOverrides?: WifiStatusRows;
	} = {},
): WifiStatusRows {
	// Return mock WiFi data in development mode
	if (shouldUseMocks()) {
		const config = getScenarioConfig();
		if (!config.wifi) return {};

		const state = getMockState();
		const ifs: Record<string, WifiInterfaceResponseMessage> = {};

		mockWifiRadios.forEach((radio, index) => {
			if (state.wifiModes[radio.device] === "hotspot") {
				const hotspot = getMockHotspotConfig(radio.device);
				ifs[index] = {
					ifname: radio.ifname,
					incarnation: getMockWifiIncarnation(radio.device),
					...(isMockWifiLimited(radio.device)
						? { degraded_reason: "permanent-mac-unresolved" as const }
						: {}),
					conn: hotspot.uuid,
					hw: radio.macAddress,
					saved: {},
					hotspot: {
						name: hotspot.name,
						password: hotspot.password,
						channel: hotspot.channel,
						available_channels: getWifiChannelMap([
							"auto",
							"auto_24",
							"auto_50",
						]),
						// A dev host proves no SAE, so the mock offers exactly what
						// the real derivation would offer for an unprovable radio.
						available_security: getHotspotSecurityMap(
							offeredHotspotSecurity(undefined),
						),
						clients: buildHotspotClients(getMockHotspotClients(radio.device)),
					},
				} satisfies WifiInterfaceResponseMessage;
				return;
			}

			const wlanState = state.wifiConnections.get(radio.device);
			const activeSsid = wlanState?.activeNetwork;
			const savedNetworks = wlanState?.savedNetworks ?? [];

			const available: WifiNetwork[] = mockWifiNetworks
				.map((network) => {
					const bssid = wifiStationAllowsBlankPassword(network.security)
						? normalizeMacAddress(network.bssid)
						: undefined;
					return {
						active: network.ssid === activeSsid,
						ssid: network.ssid,
						...(bssid ? { bssid } : {}),
						signal: Math.round(getWifiSignal(network.ssid)),
						security: network.security,
						freq: network.frequency,
					};
				})
				.sort((a, b) => b.signal - a.signal);

			const saved: Record<string, string> = {};
			const savedKeyMgmt: Record<string, string> = {};
			for (const ssid of savedNetworks) {
				const uuid = mockWifiUuidForSsid(ssid);
				saved[ssid] = uuid;
				const security = classifyWifiStationSecurity(
					mockWifiNetworks.find((network) => network.ssid === ssid)?.security,
				);
				const keyMgmt = ["", "wpa-psk", "sae", "wpa-eap"].find((value) =>
					canReuseWifiStationProfile(security, value),
				);
				if (keyMgmt !== undefined) savedKeyMgmt[uuid] = keyMgmt;
			}

			const entry: WifiInterfaceResponseMessage = {
				ifname: radio.ifname,
				incarnation: getMockWifiIncarnation(radio.device),
				...(isMockWifiLimited(radio.device)
					? { degraded_reason: "permanent-mac-unresolved" as const }
					: {}),
				conn: activeSsid ? mockWifiUuidForSsid(activeSsid) : "",
				hw: radio.macAddress,
				saved,
				...(Object.keys(savedKeyMgmt).length
					? { saved_key_mgmt: savedKeyMgmt }
					: {}),
				available,
				...(radio.supports_hotspot ? { supports_hotspot: true } : {}),
			};
			applyScanStamp(entry, index);
			ifs[index] = entry;
		});

		return ifs;
	}

	const ifs: WifiStatusRows = {};
	const hotspotClients = hotspotClientsForMessage(refreshTelemetry);
	// The interfaces eligible for a link read, collected as the rows are built
	// so the refresh below is driven by exactly what this build decided is a
	// connected station — never by a guess made inside the reader.
	const stationIfnames: string[] = [];
	const wifiInterfacesByMacAddress = getWifiInterfacesByMacAddress();
	for (const macAddress in wifiInterfacesByMacAddress) {
		const wifiInterface = wifiInterfacesByMacAddress[macAddress];
		if (!wifiInterface) continue;

		const id = wifiInterface.id;

		const entry: WifiInterfaceResponseMessage = {
			ifname: wifiInterface.ifname,
			conn: wifiInterface.conn ?? "",
			hw: wifiInterface.hw,
			saved: {},
		};
		const identity = wifiRadioIdentity.state.rows.get(wifiInterface.ifname);
		const incarnation = projectWifiRadioIncarnation(wifiInterface, identity);
		if (incarnation !== undefined) entry.incarnation = incarnation;
		if (wifiInterface.degradedReason !== undefined) {
			entry.degraded_reason = wifiInterface.degradedReason;
		}
		if (wifiInterface.supportsApStaConcurrency === true) {
			const lifetime =
				identity?.row === wifiInterface ? identity.incarnation : undefined;
			if (refreshTelemetry) {
				hybridStatusEvidence.set(wifiInterface, {
					incarnation: lifetime,
					qualified: isQualifiedNmManagedHybrid(wifiInterface.ifname),
				});
			}
			const evidence = hybridStatusEvidence.get(wifiInterface);
			if (evidence?.qualified && evidence.incarnation === lifetime)
				entry.supports_ap_sta_concurrency = true;
		}
		ifs[id] = entry;

		if (isApMode(wifiInterface) || isConcurrentHotspot(wifiInterface)) {
			// One capability read backs both derivations, so the security the
			// device OFFERS and the width it REPORTS can never describe different
			// radios.
			const hotspotCaps = getWifiCapabilitiesForInterface(
				wifiInterface.ifname,
				refreshTelemetry,
			);
			const maxWidthMhz = offeredHotspotMaxWidth(hotspotCaps);
			// In Hybrid mode, the AP leg is the concurrent virtual
			// `clap-<parent>` netdev, not the parent station interface.
			const clients = hotspotClients.get(id);

			const hotspot: NonNullable<WifiInterfaceResponseMessage["hotspot"]> = {
				...(wifiInterface.hotspot.name !== undefined
					? { name: wifiInterface.hotspot.name }
					: {}),
				...(wifiInterface.hotspot.password !== undefined
					? { password: wifiInterface.hotspot.password }
					: {}),
				available_channels: getWifiChannelMap(
					wifiInterface.hotspot.availableChannels,
					wifiInterface.hotspot.derivedChannels ?? [],
				),
				available_security: getHotspotSecurityMap(
					offeredHotspotSecurity(hotspotCaps),
				),
				...(wifiInterface.hotspot.channel !== undefined
					? { channel: wifiInterface.hotspot.channel }
					: {}),
				...(wifiInterface.hotspot.security !== undefined
					? { security: wifiInterface.hotspot.security }
					: {}),
				...(Object.keys(maxWidthMhz).length > 0
					? { max_width_mhz: maxWidthMhz }
					: {}),
				...(clients !== undefined ? { clients } : {}),
			};

			const warnings = Object.keys(wifiInterface.hotspot.warnings);
			if (warnings.length > 0) {
				hotspot.warnings = warnings;
			}
			entry.hotspot = hotspot;
		}
		if (!isApMode(wifiInterface)) {
			entry.available = Array.from(wifiInterface.available.values());
			entry.saved = wifiInterface.saved;
			if (
				wifiInterface.savedKeyMgmt &&
				Object.keys(wifiInterface.savedKeyMgmt).length > 0
			)
				entry.saved_key_mgmt = wifiInterface.savedKeyMgmt;
			if (canHotspot(wifiInterface)) {
				entry.supports_hotspot = true;
			}
			// Only a station leg that HOLDS a connection has a negotiated rate to
			// report, and the AP branch above never reaches here — so `iw link` is
			// structurally unreachable for a hotspot radio rather than filtered
			// out of one, which is what keeps a shared-wiphy board honest.
			if (wifiInterface.conn !== null) {
				stationIfnames.push(wifiInterface.ifname);
				const link = getWifiLinkTelemetryForInterface(wifiInterface.ifname);
				if (link !== undefined) {
					entry.link = link;
				}
			}
		}

		entry.mode = isApMode(wifiInterface) ? "hotspot" : "station";
		entry.observed_mode = displayObservedWifiAdapterMode(wifiInterface);
		// The same evidence as the Start terminal: a Start still awaiting its
		// verified client zone, or (at boot, or after a `pending` Start) no zone
		// verified for this AP's current lifetime.
		let steering: "activating" | undefined;
		if (isApMode(wifiInterface) || isConcurrentHotspot(wifiInterface)) {
			const apIfname = wifiInterface.concurrentHotspot?.activeConn
				? wifiInterface.concurrentHotspot.ifname
				: wifiInterface.ifname;
			if (
				hotspotAwaitingSteering(wifiInterface) ||
				hotspotSteeringPending(
					apIfname,
					getNetworkInterfaceIncarnation(apIfname),
				)
			)
				steering = "activating";
		}
		if (steering !== undefined) entry.transition = steering;
		let needsLocalOverride = false;
		let localRowTransition: typeof entry.transition;
		if (canHotspot(wifiInterface)) {
			const localTransition =
				projectHotspotTransition(wifiInterface) ?? steering;
			const rawTransition = wifiInterface.hotspot.transition ?? steering;
			const transition =
				legacyTransitions || legacyOverrides ? rawTransition : localTransition;
			if (transition !== undefined) entry.transition = transition;
			const leaving = projectWifiModeWitness(wifiInterface, incarnation);
			if (leaving !== undefined) entry.leaving = leaving;
			needsLocalOverride = transition !== localTransition;
			localRowTransition = localTransition;
		}

		const capabilities = getWifiCapabilitiesForInterface(
			wifiInterface.ifname,
			refreshTelemetry,
		);
		if (capabilities !== undefined) {
			entry.capabilities = capabilities;
		}

		applyScanStamp(entry, id);
		if (legacyOverrides && needsLocalOverride) {
			// Keep the raw flag in its original wire order without rebuilding telemetry.
			legacyOverrides[id] = entry;
			const { transition: _rawTransition, ...local } = entry;
			// A Start awaiting its client zone stays activating on the local wire.
			ifs[id] =
				localRowTransition === undefined
					? local
					: { ...local, transition: localRowTransition };
		}
	}

	// Fire-and-forget, after the snapshot is assembled: the read is bounded by
	// its own TTL and never throws, so a broadcast is never blocked on a spawn
	// and the next build serves whatever this one produced.
	if (refreshTelemetry) void refreshWifiLinkTelemetry(stationIfnames);

	return ifs;
}

export function broadcastWifiState() {
	refreshWifiApClientZones();
	const legacyOverrides: WifiStatusRows = {};
	const wifi = buildWifiSnapshot(true, { legacyOverrides });
	if (Object.keys(legacyOverrides).length > 0) {
		broadcastMsg("status", { wifi }, 0, true, {
			wifi: { ...wifi, ...legacyOverrides },
		});
	} else {
		broadcastMsg("status", { wifi });
	}
	recordHotspotClientsBroadcast();
}

export function broadcastWifiModeSettlement() {
	// Settlement is display-only, not another discovery or telemetry poll.
	broadcastMsgLocal("status", { wifi: buildWifiSnapshot(false) });
}

setWifiRadioPublicationListener(() => {
	broadcastMsgLocal("status", { wifi: wifiBuildMsg() });
});

/*
  Record one saved infrastructure connection on the interface(s) it can be used
  from. A profile bound to a MAC that a present adapter reports is attributed to
  that adapter only. Any other profile — no bound MAC (created outside CeraUI:
  nmtui, `nmcli device wifi connect`, a baked image profile) or a bound MAC that
  matches no present adapter (MAC randomization / swapped adapter) — is registered
  on every adapter, mirroring the scan path where all interfaces see all networks.
  Without this fallback an active-but-unbound connection resolves no UUID and the
  UI shows "Connect" on the network the device is already connected to.

  The fallback registers only where the SSID is not already claimed (`??=`), so a
  precise MAC binding always wins over a same-SSID fallback profile regardless of
  nmcli enumeration order — a fallback profile listed after a MAC-bound one for the
  same SSID must not silently overwrite the precise adapter attribution.
*/
export function registerSavedWifiConnection(
	interfaces: Record<MacAddress, WifiInterface>,
	macAddress: MacAddress,
	ssid: SSID,
	uuid: ConnectionUUID,
): void {
	const boundInterface = macAddress ? interfaces[macAddress] : undefined;
	if (boundInterface) {
		boundInterface.saved[ssid] = uuid;
		rememberSavedUuid(boundInterface, ssid, uuid);
		return;
	}
	for (const wifiInterface of Object.values(interfaces)) {
		wifiInterface.saved[ssid] ??= uuid;
		rememberSavedUuid(wifiInterface, ssid, uuid);
	}
}

/* `saved` keeps ONE uuid per SSID; `savedAll` keeps every one, for Forget. */
function rememberSavedUuid(
	wifiInterface: WifiInterface,
	ssid: SSID,
	uuid: ConnectionUUID,
): void {
	wifiInterface.savedAll[ssid] ??= [];
	const all = wifiInterface.savedAll[ssid];
	if (!all.includes(uuid)) all.push(uuid);
}

let savedConnectionsRefresh: symbol | undefined;

export async function wifiUpdateSavedConns(
	signal?: AbortSignal,
	onCommitted?: () => void,
	permitHotspotWrite?: (uuid: string) => Promise<ProfileWriteAdmission>,
	readInventory?: ReadRadioInventory,
): Promise<void> {
	if (signal?.aborted) return;
	const refresh = Symbol();
	savedConnectionsRefresh = refresh;
	const snapshots = Object.entries(getWifiInterfacesByMacAddress()).map(
		([macAddress, original]) => {
			const shadow: WifiInterface = { ...original, saved: {}, savedAll: {} };
			return { macAddress, original, shadow };
		},
	);
	const savedInterfaces: Record<MacAddress, WifiInterface> = Object.fromEntries(
		snapshots.map(({ macAddress, shadow }) => [macAddress, shadow]),
	);
	const isCurrent = () => {
		const current = getWifiInterfacesByMacAddress();
		return (
			!signal?.aborted &&
			savedConnectionsRefresh === refresh &&
			Object.keys(current).length === snapshots.length &&
			snapshots.every(
				({ macAddress, original }) => current[macAddress] === original,
			)
		);
	};

	// Retry transient nmcli connection-list failures with exponential backoff (T7).
	const connections = await pollWithBackoff(() => nmConnsGet("uuid,type"), {
		...(signal ? { signal } : {}),
		maxAttempts: 3,
		baseDelayMs: 200,
		maxDelayMs: 1000,
		emptyResultError: () =>
			new Error("nmcli connection list returned no results"),
		onExhausted: (err) =>
			logger.debug(`wifiUpdateSavedConns: list failed after retries: ${err}`),
	});
	if (
		signal?.aborted ||
		connections === undefined ||
		savedConnectionsRefresh !== refresh
	)
		return;
	let incomplete = false;
	const savedKeyMgmt = new Map<ConnectionUUID, string>();

	for (const connection of connections) {
		try {
			const [uuid, type] = nmcliParseSep(connection) as [
				ConnectionUUID,
				string,
			];

			if (type !== "802-11-wireless") continue;

			// Key management is public metadata; never request the profile secrets.
			const fields = await nmConnGetFields(
				uuid,
				[
					"802-11-wireless.mode",
					"802-11-wireless.ssid",
					"802-11-wireless.mac-address",
					"802-11-wireless-security.key-mgmt",
				] as const,
				undefined,
				false,
			);
			if (signal?.aborted || savedConnectionsRefresh !== refresh) return;

			if (fields === undefined) {
				throw new Error("Failed to get connection fields");
			}

			const [mode, ssid, macTmp, keyMgmt] = fields;
			if (!ssid) {
				logger.warn("Wifi connection does not have an SSID!", { mode, uuid });
				incomplete = true;
				continue;
			}

			const macAddress = macTmp.toLowerCase();
			if (mode === "ap") {
				if (permitHotspotWrite || readInventory)
					await handleHotspotConn(macAddress, uuid, {
						...(permitHotspotWrite ? { permitWrite: permitHotspotWrite } : {}),
						...(readInventory ? { readInventory } : {}),
					});
				else await handleHotspotConn(macAddress, uuid);
			} else if (mode === "infrastructure") {
				registerSavedWifiConnection(savedInterfaces, macAddress, ssid, uuid);
				if (keyMgmt !== undefined) savedKeyMgmt.set(uuid, keyMgmt);
			}
		} catch (err) {
			if (err instanceof Error) {
				logger.error(
					`Error getting the nmcli connection information: ${err.message}`,
				);
			}
			incomplete = true;
		}
	}

	if (incomplete || !isCurrent()) return;
	// Keep the previous snapshot visible until every profile read has settled.
	for (const { original, shadow } of snapshots) {
		original.saved = shadow.saved;
		original.savedAll = shadow.savedAll;
		original.savedKeyMgmt = Object.fromEntries(
			Object.values(shadow.saved).flatMap((uuid) => {
				const keyMgmt = savedKeyMgmt.get(uuid);
				return keyMgmt === undefined ? [] : [[uuid, keyMgmt]];
			}),
		);
	}
	onCommitted?.();
}

/*
  The one radio a saved Connect of `uuid` activates on: the radio it is already
  active on, else the first radio (by published id) that lists it. A profile
  with no bound MAC is listed on every radio, so the procedure's lock and the
  handler's activation must both use this one answer.
*/
export function wifiConnectRadio(
	uuid: string,
): { deviceId: string; macAddress: MacAddress; ifname: string } | undefined {
	const wifiInterfacesByMacAddress = getWifiInterfacesByMacAddress();
	let first:
		| { deviceId: string; macAddress: MacAddress; ifname: string }
		| undefined;
	for (const id in getWifiIdToMacAddress()) {
		const macAddress = getMacAddressForWifiInterface(Number.parseInt(id, 10));
		if (!macAddress) continue;
		const wifiInterface = wifiInterfacesByMacAddress[macAddress];
		if (!wifiInterface) continue;
		const radio = { deviceId: id, macAddress, ifname: wifiInterface.ifname };
		if (
			wifiInterface.conn === uuid &&
			Object.values(wifiInterface.saved).includes(uuid)
		)
			return radio;
		if (!first && Object.values(wifiInterface.saved).includes(uuid))
			first = radio;
	}
	return first;
}

/**
 * Every radio Forget of `uuid` can touch: any that lists one of the profiles it
 * deletes (the same-SSID siblings too, also those behind another profile in
 * `savedAll`) or has one of them active.
 */
export function wifiForgetRadios(uuid: ConnectionUUID): MacAddress[] {
	const targets = new Set(wifiSiblingConnections(uuid));
	return Object.entries(getWifiInterfacesByMacAddress())
		.filter(
			([, row]) =>
				(row.conn !== null && targets.has(row.conn)) ||
				Object.values(row.savedAll ?? {}).some((uuids) =>
					uuids.some((saved) => targets.has(saved)),
				) ||
				Object.values(row.saved).some((saved) => targets.has(saved)),
		)
		.map(([macAddress]) => macAddress);
}

export async function wifiDisconnect(uuid: ConnectionUUID) {
	const candidates = Object.entries(getWifiInterfacesByMacAddress()).filter(
		([, row]) => row.conn === uuid && Object.values(row.saved).includes(uuid),
	);
	const selected = candidates.length === 1 ? candidates[0] : undefined;
	if (!selected) return { success: false, error: "generic" } as const;
	const [key, row] = selected;
	const locked = await withWifiAdapterLock(
		wifiAdapterLockKey(key),
		async () => {
			if (getWifiInterfaceByMacAddress(key) !== row || row.conn !== uuid)
				return false;
			const receipt = await observeHotspotActivation(uuid, row.ifname);
			return nmDisconnectActivation(
				uuid,
				receipt,
				undefined,
				async () =>
					getWifiInterfaceByMacAddress(key) === row && row.conn === uuid,
			);
		},
	);
	if (!locked.success) return { success: false, error: "DEVICE_BUSY" } as const;
	if (!locked.result) return { success: false, error: "generic" } as const;
	await wifiUpdateScanResult();
	wifiScheduleScanRefresh();
	return { success: true } as const;
}

/*
  Every profile the adapters hold for the SSID `uuid` belongs to — because
  "Forget" means "remove this NETWORK", and the operator's row IS the SSID.
  Deleting only `uuid` leaves a same-SSID sibling behind, which keeps the row
  reading "Saved" and is indistinguishable from a Forget that did nothing.
*/
export function wifiSiblingConnections(uuid: ConnectionUUID): ConnectionUUID[] {
	const uuids = new Set<ConnectionUUID>([uuid]);
	for (const wifiInterface of Object.values(getWifiInterfacesByMacAddress())) {
		for (const ssid in wifiInterface.saved) {
			if (wifiInterface.saved[ssid] !== uuid) continue;
			for (const sibling of wifiInterface.savedAll[ssid] ?? []) {
				uuids.add(sibling);
			}
		}
	}
	return [...uuids];
}

/*
  Resolves when the profiles are deleted, which is the part the caller holds
  every listing radio's adapter lock for (`wifiForgetRadios`). Forget sends no
  terminal frame; the refreshed saved list that follows outside the lock is
  its result.
*/
async function wifiForget(uuid: ConnectionUUID) {
	// Read in the same tick the caller took its locks, so a profile published
	// by a refresh while the mode is read cannot be deleted without its radio's
	// lock.
	const listed = wifiConnectRadio(uuid) !== undefined;
	const targets = wifiSiblingConnections(uuid);
	// AP profiles are managed only through the owned hotspot lifecycle, never the station sibling sweep.
	const mode = await nmConnGetFields(uuid, ["802-11-wireless.mode"] as const);
	if (mode?.[0] === "ap") return;

	if (!listed) return;

	let deleted = false;
	for (const target of targets) {
		if (await nmConnDelete(target)) deleted = true;
	}

	if (deleted)
		afterWifiAdapterLockRelease(() => {
			void (async () => {
				await wifiUpdateSavedConns();
				await wifiUpdateScanResult();
				wifiScheduleScanRefresh();
			})().catch((err) =>
				logger.warn(`Wi-Fi refresh after Forget failed: ${errorText(err)}`),
			);
		});
}

/*
  A failed join can leave profile effects unresolved. Neither timestamp zero
  nor a returned UUID proves exclusive ownership, so this legacy cleanup
  entrypoint retains profiles. Explicit Forget remains the deletion owner.
*/
export type WifiFailedConnsDeps = {
	listConns: (fields: string) => Promise<string[] | undefined>;
	deleteConn: (uuid: ConnectionUUID) => Promise<boolean>;
};

const defaultFailedConnsDeps: WifiFailedConnsDeps = {
	listConns: nmConnsGet,
	deleteConn: nmConnDelete,
};

export async function wifiDeleteFailedConns(
	_deps: WifiFailedConnsDeps = defaultFailedConnsDeps,
) {
	logger.warn("Wi-Fi join cleanup withheld: profile ownership is unconfirmed");
}

export type NmcliRun = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	/** The process deadline killed nmcli before it answered. */
	readonly timedOut?: boolean;
};

/*
  nmcli exits 3 when its own `-w` deadline expires. Neither that nor the
  process deadline cancels the request: NetworkManager keeps activating.
*/
const NMCLI_TIMEOUT_EXIT = 3;
const nmcliGaveUp = (run: NmcliRun) =>
	run.timedOut === true || run.exitCode === NMCLI_TIMEOUT_EXIT;

export type WifiJoinNmcliRunner = (args: string[]) => Promise<NmcliRun>;

async function spawnJoinNmcli(args: string[]): Promise<NmcliRun> {
	try {
		const proc = Bun.spawn(["nmcli", ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		// bounded-command (spawn-policy): cap a hung nmcli connect at the
		// wall-clock budget so a stuck join never leaves the request pending
		// forever.
		let timedOut = false;
		const killTimer = setTimeout(() => {
			timedOut = true;
			try {
				proc.kill();
			} catch {
				// best-effort: the process may have already exited
			}
		}, DEFAULT_SPAWN_TIMEOUT_MS);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;
		clearTimeout(killTimer);
		return timedOut
			? { stdout, stderr, exitCode, timedOut }
			: { stdout, stderr, exitCode };
	} catch (err) {
		// A missing/unspawnable nmcli must reach the operator as a failed join
		// rather than an unhandled rejection on this `void`-dispatched path.
		return {
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
			exitCode: 1,
		};
	}
}

let joinNmcliRunner: WifiJoinNmcliRunner = spawnJoinNmcli;

/** Test seam, mirroring `setRegdomainRunner` / `setSshServiceRunner`. */
export function setWifiJoinNmcliRunner(
	runner: WifiJoinNmcliRunner | null,
): void {
	joinNmcliRunner = runner ?? spawnJoinNmcli;
}

type WifiJoinOutcome = {
	readonly ok: boolean;
	readonly uuid?: string;
	readonly authFailed: boolean;
	/** nmcli gave up on the activation; NetworkManager may still complete it. */
	readonly abandoned?: boolean;
	/** The saved list was refreshed after the join, so the choice can be recorded. */
	readonly listed?: boolean;
};

const wantedSecrets = (output: string) =>
	output.includes("Secrets were required, but not provided");

async function joinViaNmAuto(args: string[]): Promise<WifiJoinOutcome> {
	const result = await joinNmcliRunner(args);
	const { stdout, stderr, exitCode } = result;
	if (exitCode !== 0 || /^Error:/.test(stdout)) {
		return {
			ok: false,
			authFailed: wantedSecrets(`${stdout}\n${stderr}`),
			...(nmcliGaveUp(result) ? { abandoned: true } : {}),
		};
	}
	const success = stdout.match(/successfully activated with '(.+)'/);
	const uuid = success?.[1];
	return uuid === undefined
		? { ok: true, authFailed: false }
		: { ok: true, uuid, authFailed: false };
}

async function retrySavedJoin(
	uuid: ConnectionUUID,
	password: string,
	connectArgs: string[],
): Promise<WifiJoinOutcome> {
	const changed = await joinNmcliRunner([
		"connection",
		"modify",
		"uuid",
		uuid,
		"802-11-wireless-security.psk",
		password,
	]);
	if (changed.exitCode !== 0)
		return {
			ok: false,
			authFailed: wantedSecrets(`${changed.stdout}\n${changed.stderr}`),
		};
	const ifname = connectArgs[connectArgs.indexOf("ifname") + 1];
	const activated = await joinViaNmAuto([
		"-w",
		"15",
		"connection",
		"up",
		"uuid",
		uuid,
		...(ifname ? ["ifname", ifname] : []),
	]);
	return { ...activated, uuid };
}

/**
 * An add or activation reply can fail after profile effects have occurred.
 * Retain uncertain profiles rather than inferring deletion authority from a
 * returned UUID, activation failure or timestamp.
 */
async function joinViaNewProfile(
	plan: Extract<AdmittedWifiStationJoinPlan, { mode: "sae" | "open" }>,
): Promise<WifiJoinOutcome> {
	const added = await joinNmcliRunner(plan.addArgs);
	if (added.exitCode !== 0) {
		return {
			ok: false,
			authFailed: false,
		};
	}

	const parsed = parseNmConnAddUuid(added.stdout);
	if (!parsed.ok) {
		logger.warn(
			"wifiNew: NetworkManager returned no confirmed new profile UUID",
		);
		return {
			ok: false,
			authFailed: false,
		};
	}

	const uuid = parsed.value;
	const args = saeActivateArgs(uuid);
	if (plan.mode === "open") args.push("ifname", plan.ifname, "ap", plan.bssid);
	const activated = await joinNmcliRunner(args);
	if (activated.exitCode !== 0 || !parseNmConnActivated(activated.stdout)) {
		return {
			ok: false,
			uuid,
			authFailed: wantedSecrets(`${activated.stdout}${activated.stderr}`),
			...(nmcliGaveUp(activated) ? { abandoned: true } : {}),
		};
	}
	return {
		ok: true,
		uuid,
		authFailed: false,
	};
}

/*
  A join or connect whose nmcli gave up has not been cancelled: NetworkManager
  can still complete it after the operator was told it failed, and after the
  adapter lock was released, so it would undo whatever took the radio next.
  Called while the request still holds the adapter lock. Only the radio's
  current activation of the requested network is touched; a request that
  reached NetworkManager ended any activation already pending on the device,
  so a pending one is this request's (the residual case is a request nmcli
  never got to NetworkManager within the process deadline). Still pending, it
  is taken down by the exact active path observed, and the teardown refuses an
  activation that has completed by then; one that completed is returned when
  `reportCompleted` says the request named that profile, and otherwise left as
  it is. Deactivating it blocks that profile's
  autoconnect until it is activated again, which is what keeps the refused
  join from coming back. This is best effort: when the radio cannot be read,
  the activation changed between reads, or the teardown is refused, the
  activation is left as it is and a warning is logged.
*/
const SETTLE_READ_ATTEMPTS = 3;
const SETTLE_READ_RETRY_MS = 250;

async function readStationActivation(ifname: string) {
	for (let attempt = 1; ; attempt++) {
		const active = await readNmDeviceActivation(ifname);
		if (active || attempt >= SETTLE_READ_ATTEMPTS) return active;
		await new Promise((resolve) => setTimeout(resolve, SETTLE_READ_RETRY_MS));
	}
}

async function settleAbandonedStationActivation(
	ifname: string,
	requested: (uuid: ConnectionUUID) => Promise<boolean> | boolean,
	reportCompleted: boolean,
): Promise<ConnectionUUID | undefined> {
	try {
		const active = await readStationActivation(ifname);
		if (!active) {
			logger.warn(
				`Wi-Fi: the abandoned activation on ${ifname} could not be read; leaving it`,
			);
			return undefined;
		}
		const { uuid, path } = active;
		if (!uuid || !path || !(await requested(uuid))) return undefined;
		const receipt = await observeHotspotActivation(uuid, ifname);
		if (!receipt || receipt.path !== path) return undefined;
		if (receipt.connected) return reportCompleted ? uuid : undefined;
		if (
			await nmDisconnectActivation(
				uuid,
				receipt,
				undefined,
				undefined,
				undefined,
				{
					pendingOnly: true,
				},
			)
		)
			return undefined;
		// Refused: it may have completed since it was observed, by the same
		// daemon (a restarted one can reuse the path for another profile).
		const now = await observeHotspotActivation(uuid, ifname);
		if (now?.path === path && now.runId === receipt.runId && now.connected)
			return reportCompleted ? uuid : undefined;
		logger.warn(
			`Wi-Fi: the abandoned activation on ${ifname} could not be cancelled`,
		);
	} catch (err) {
		logger.warn(
			`Wi-Fi: settling the abandoned activation on ${ifname} failed: ${describePrivateCliError(err)}`,
		);
	}
	return undefined;
}

/** The station profile `uuid` names the requested network on this radio. */
const requestedStationSsid =
	(ssid: string) =>
	async (uuid: ConnectionUUID): Promise<boolean> => {
		const fields = await nmConnGetFields(
			uuid,
			["802-11-wireless.mode", "802-11-wireless.ssid"] as const,
			undefined,
			false,
		);
		return fields?.[0] === "infrastructure" && fields[1] === ssid;
	};

/*
  The join holds the adapter lock while its returned promise is pending: the
  open AP's verification scan, the nmcli join, a timed-out activation's
  settlement, the new profile's MAC binding and the saved-list refresh the
  operator's choice depends on. Recording that choice, refreshing the scan
  results and the terminal frame follow after the lock is released. Every path
  ends in one terminal frame.
*/
function wifiNew(conn: MessageSocket, msg: WifiNewMessage["new"]) {
	// NOT `!msg.device`: `wifiIfId` starts at 0, so the first adapter on every
	// single-radio board is id 0 and a truthiness guard drops it — no nmcli ran,
	// while the procedure's mock branch still fabricated success, so dev/e2e
	// stayed green while hardware could not join a new network at all.
	if (msg.device === undefined || !msg.ssid) return;

	const senderId = getSocketSenderId(conn);
	// An unresolvable adapter is still a terminal answer the caller is owed; the
	// retired silent returns left the keyed join op pending until its TTL.
	const refuse = (
		error: NonNullable<WifiMessageWire["new"]>["error"] = "generic",
	) => {
		conn.send(
			buildMsg("wifi", { new: { error, device: msg.device } }, senderId),
		);
	};

	const macAddress = getMacAddressForWifiInterface(msg.device);
	if (!macAddress) return refuse();

	const wifiInterface = getWifiInterfaceByMacAddress(macAddress);
	if (!wifiInterface) return refuse();

	const plan = planWifiStationJoin({
		ssid: msg.ssid,
		ifname: wifiInterface.ifname,
		password: msg.password,
		security: msg.security,
	});
	if (plan.mode === "refused") return refuse();
	if (plan.mode === "verify-open") {
		const ifname = wifiInterface.ifname;
		// The diversity check leaves this radio alone from the open AP's
		// verification scan until the join has settled.
		const choice = beginWifiOperatorChoice(macAddress);
		return (async () => {
			let handedOff = false;
			try {
				const open = await planOpenWifiJoin(msg.ssid, ifname, msg.bssid);
				if (
					!open ||
					getWifiInterfaceByMacAddress(macAddress) !== wifiInterface ||
					wifiInterface.ifname !== ifname
				)
					return afterWifiAdapterLockRelease(() =>
						refuse("open-target-unverified"),
					);
				handedOff = true;
				await runWifiNew(
					conn,
					msg,
					macAddress,
					open,
					senderId,
					choice,
					wifiInterface.saved[msg.ssid],
				);
			} catch (err) {
				logger.error(
					`wifiNew: open join verification failed: ${describePrivateCliError(err)}`,
				);
				afterWifiAdapterLockRelease(() => refuse());
			} finally {
				if (!handedOff) choice.release();
			}
		})();
	}

	// The diversity check leaves this radio alone until the join has settled
	// and the operator's choice is recorded.
	const choice = beginWifiOperatorChoice(macAddress);
	return runWifiNew(
		conn,
		msg,
		macAddress,
		plan,
		senderId,
		choice,
		wifiInterface.saved[msg.ssid],
	);
}

// Reconcile retained profiles for explicit Forget without delaying a join's
// terminal reply on profile-list transport availability.
function refreshRetainedJoinProfiles(): void {
	void wifiUpdateSavedConns(undefined, broadcastWifiState).catch((err) =>
		logger.warn(`Retained Wi-Fi profile refresh failed: ${errorText(err)}`),
	);
}

/** Resolves when the radio no longer needs the adapter lock; owns `choice`. */
async function runWifiNew(
	conn: MessageSocket,
	msg: WifiNewMessage["new"],
	macAddress: string,
	plan: AdmittedWifiStationJoinPlan,
	senderId: ReturnType<typeof getSocketSenderId>,
	choice: WifiOperatorChoice,
	savedUuid?: ConnectionUUID,
): Promise<void> {
	let outcome: WifiJoinOutcome | undefined;
	try {
		outcome = await joinStationUnderLock(msg, macAddress, plan, savedUuid);
	} catch (err) {
		logger.error(`wifiNew: join failed: ${describePrivateCliError(err)}`);
	}
	const joined = outcome;
	afterWifiAdapterLockRelease(() => {
		// Recorded at release, before any later request can take this radio, so
		// an older join that is slow to refresh cannot outrank a newer choice.
		const recorded =
			joined?.ok && joined.uuid !== undefined && joined.listed
				? choice.record(joined.uuid)
				: undefined;
		void (async () => {
			if (!joined?.ok) {
				conn.send(
					buildMsg(
						"wifi",
						{
							new: {
								error: joined?.authFailed ? "auth" : "generic",
								device: msg.device,
							},
						},
						senderId,
					),
				);
				refreshRetainedJoinProfiles();
				return;
			}
			if (joined.uuid === undefined) {
				logger.warn(
					"wifiNew: NetworkManager returned no confirmed connection UUID",
				);
				/*
			  nmcli reported no error and named no connection, so nothing here can say
			  whether the network was joined — but a bare `return` is the one answer
			  that is certainly wrong: it leaves the dialog's keyed op to expire on its
			  TTL with no explanation. `ambiguous` says exactly that much, and nothing
			  is cleaned up. Failed activation replies also leave effects uncertain;
			  automatic cleanup retains profiles without exclusive ownership proof.
			*/
				conn.send(
					buildMsg(
						"wifi",
						{ new: { error: "ambiguous", device: msg.device } },
						senderId,
					),
				);
				refreshRetainedJoinProfiles();
				return;
			}
			try {
				await wifiUpdateScanResult();
			} catch (err) {
				logger.warn(
					`wifiNew: refresh after the join failed: ${errorText(err)}`,
				);
			}
			conn.send(
				buildMsg(
					"wifi",
					{ new: { success: true, device: msg.device } },
					senderId,
				),
			);
			await recorded;
		})()
			.catch((err) =>
				logger.warn(`wifiNew: completing the join failed: ${errorText(err)}`),
			)
			.finally(choice.release);
	});
}

async function joinStationUnderLock(
	msg: WifiNewMessage["new"],
	macAddress: string,
	plan: AdmittedWifiStationJoinPlan,
	savedUuid?: ConnectionUUID,
): Promise<WifiJoinOutcome> {
	const ifname = getWifiInterfaceByMacAddress(macAddress)?.ifname;
	// Both the requested network and the stored profile must support PSK
	// before a same-SSID UUID grants authority to replace its secret.
	let outcome: WifiJoinOutcome;
	if (plan.mode !== "nm-auto") {
		outcome = await joinViaNewProfile(plan);
	} else {
		const keyMgmt =
			savedUuid &&
			msg.password &&
			canReuseWifiStationProfile(plan.security, "wpa-psk")
				? (
						await nmConnGetFields(
							savedUuid,
							["802-11-wireless-security.key-mgmt"] as const,
							undefined,
							false,
						)
					)?.[0]
				: undefined;
		outcome =
			savedUuid && msg.password && keyMgmt === "wpa-psk"
				? await retrySavedJoin(savedUuid, msg.password, plan.connectArgs)
				: await joinViaNmAuto(plan.connectArgs);
	}

	if (!outcome.ok && outcome.abandoned && ifname) {
		// A uuid names this request's profile; an SSID alone could also match a
		// station profile that was already there, which is never reported as
		// this join.
		const requestedUuid = outcome.uuid;
		const joined = await settleAbandonedStationActivation(
			ifname,
			requestedUuid !== undefined
				? (active) => active === requestedUuid
				: requestedStationSsid(msg.ssid),
			requestedUuid !== undefined,
		);
		if (joined) outcome = { ok: true, uuid: joined, authFailed: false };
	}
	if (!outcome.ok || outcome.uuid === undefined) return outcome;

	const currentRow = getWifiInterfaceByMacAddress(macAddress);
	const hardwareMac =
		(currentRow && bindingForRow(macAddress, currentRow)?.mac) ??
		normalizeMacAddress(macAddress);
	if (
		hardwareMac &&
		!(await nmConnSetWifiMacAddress(
			outcome.uuid,
			hardwareMac,
			...(plan.mode === "open" ? ([true] as const) : []),
		))
	) {
		logger.warn(
			"Failed to set the MAC address for the newly created connection",
		);
	}
	// The choice recorded at release reads this radio's saved profiles, which
	// the join just changed: they are refreshed first, under the lock (as the
	// open join always did). A refresh that does not commit a complete list
	// does not undo the join, but the choice is then not recorded against a
	// stale one.
	try {
		let listed = false;
		await wifiUpdateSavedConns(undefined, () => {
			listed = true;
		});
		return listed ? { ...outcome, listed } : outcome;
	} catch (err) {
		logger.warn(
			`wifiNew: saved-list refresh after the join failed: ${errorText(err)}`,
		);
	}
	return outcome;
}

/*
  Resolves when the radio no longer needs the adapter lock: after nmcli has
  answered and a timed-out activation is settled. The scan refresh, the
  terminal frame and recording the operator's choice follow outside the lock.
  The activation is pinned to the radio the caller locked
  (`wifiConnectRadio`), so NetworkManager cannot pick another adapter for a
  profile that several radios list.
*/
async function wifiConnect(conn: MessageSocket, uuid: ConnectionUUID) {
	const radio = wifiConnectRadio(uuid);
	if (radio === undefined) return;
	const { deviceId, macAddress, ifname } = radio;

	const senderId = getSocketSenderId(conn);
	// The diversity check leaves this radio alone until the connect has settled
	// and the operator's choice is recorded.
	const choice = beginWifiOperatorChoice(macAddress);
	let success = false;
	try {
		let abandoned = false;
		success = await nmConnect(
			uuid,
			undefined,
			undefined,
			() => {
				abandoned = true;
			},
			ifname,
		);
		if (!success && abandoned)
			success =
				(await settleAbandonedStationActivation(
					ifname,
					(active) => active === uuid,
					true,
				)) === uuid;
	} catch (err) {
		logger.error(`wifiConnect failed: ${describePrivateCliError(err)}`);
	}
	const connected = success;
	afterWifiAdapterLockRelease(() => {
		// Recorded at release, before any later request can take this radio.
		const recorded = connected ? choice.record(uuid) : undefined;
		void (async () => {
			try {
				await wifiUpdateScanResult();
			} catch (err) {
				logger.warn(`wifiConnect: scan refresh failed: ${errorText(err)}`);
			}
			conn.send(
				buildMsg("wifi", { connect: connected, device: deviceId }, senderId),
			);
			await recorded;
		})()
			.catch((err) =>
				logger.warn(`wifiConnect: completing failed: ${errorText(err)}`),
			)
			.finally(choice.release);
	});
}

// `conn` is a MessageSocket, never the `ws` package's WebSocket: the only caller
// is the oRPC wifi procedure, whose `context.ws` is a Bun ServerWebSocket, and
// declaring the unrelated `ws` type here is what forced every call site to
// launder it through `as unknown as WebSocket`.
export function handleWifi(
	conn: MessageSocket,
	msg: WifiMessage["wifi"],
): Promise<void> | undefined {
	// The station work a caller holds the adapter lock for, and hotspot
	// configuration's completion (see the `hotspot` arm).
	let configuration: Promise<void> | undefined;
	for (const type in msg) {
		switch (type) {
			case "connect":
				configuration = wifiConnect(
					conn,
					extractMessage<WifiConnectMessage, typeof type>(msg, type),
				);
				break;

			case "disconnect":
				void wifiDisconnect(
					extractMessage<WifiDisconnectMessage, typeof type>(msg, type),
				);
				break;

			/*
			  The requested adapter is FORWARDED, not discarded. Dropping it made
			  every scan a device-wide one: the rescan went out with no `ifname`, so
			  a two-radio board rescanned whichever radio NetworkManager felt like,
			  and the process-wide coalescing guard then served the second adapter's
			  caller from the first one's run.
			*/
			case "scan":
				void wifiRescan(
					extractMessage<WifiScanMessage, typeof type>(msg, type),
				);
				break;

			case "new":
				configuration =
					wifiNew(
						conn,
						extractMessage<WifiNewMessage, typeof type>(msg, type),
					) ?? configuration;
				break;

			case "forget":
				configuration = wifiForget(
					extractMessage<WifiForgetMessage, typeof type>(msg, type),
				);
				break;

			case "hotspot": {
				const hotspotMessage = extractMessage<WifiHotspotMessage, typeof type>(
					msg,
					type,
				);
				/*
				  Each transaction publishes a terminal `wifi` frame
				  on every outcome it can reach, and the `catch` arms cover the one
				  outcome it cannot (an unexpected throw), so no path on this branch
				  can leave an operator's keyed op to expire on its TTL. Configuration
				  also returns its completion so RPC cannot acknowledge it before
				  the transaction has entered and finished its adapter lock.
				*/
				if ("start" in hotspotMessage && hotspotMessage.start) {
					const { device } = hotspotMessage.start;
					void wifiHotspotStart(hotspotMessage.start).catch((err) => {
						logger.error(`hotspot start threw: ${errorText(err)}`);
						publishHotspotOutcome("start", device, {
							success: false,
							error: "activation-failed",
						});
					});
				} else if ("stop" in hotspotMessage && hotspotMessage.stop) {
					const { device } = hotspotMessage.stop;
					void wifiHotspotStop(hotspotMessage.stop).catch((err) => {
						logger.error(`hotspot stop threw: ${errorText(err)}`);
						publishHotspotOutcome("stop", device, {
							success: false,
							error: "deactivation-failed",
						});
					});
				} else if ("config" in hotspotMessage && hotspotMessage.config) {
					const { device } = hotspotMessage.config;
					const binding = captureWifiFrameIncarnation(device, "config");
					configuration = wifiHotspotConfig(conn, hotspotMessage.config).catch(
						(err) => {
							logger.error(`hotspot configure threw: ${errorText(err)}`);
							conn.send(
								buildMsg(
									"wifi",
									{
										hotspot: {
											config: { device, error: "unavailable", ...binding },
										},
									},
									getSocketSenderId(conn),
								),
							);
						},
					);
				}
				break;
			}
		}
	}
	return configuration;
}
