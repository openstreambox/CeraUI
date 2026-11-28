/*
  The device image's first-boot setup Wi-Fi is a separate NetworkManager AP
  that CeraUI must never own. The image's setup script creates it as an
  unpinned, ifname-bound, autoconnect-off AP profile, activates it before it
  stops CeraUI, and later brings it down and deletes it by connection name.
  Upstream discovery can find an unpinned AP by its interface name and would
  then repin it, raise its priority and remember its credentials, so every
  adoption, repair, policy, cleanup and user-mutation path asks this module
  first.

  Recognition uses positive evidence only. NetworkManager's own profile fields
  (AP mode and the script's fixed connection name) identify the legacy setup
  AP whenever it is seen. The image's marker is the second witness: while it
  exists, the AP active on the setup interface is the image's AP whatever its
  name, and its UUID stays the setup AP for the marker's lifetime. The setup
  SSID (`CeraLive-Setup-<4 hex>`) is not sufficient on its own, since a CeraUI
  AP may legitimately carry such an SSID after an older build remembered the
  setup credentials.

  The same marker is the interlock: while it exists, CeraUI's Start, mode
  switch, restore and arming leave the setup radio to the image.
*/

import fs from "node:fs";
import { logger } from "../../helpers/logger.ts";
import type { WifiInterface } from "./wifi-interfaces.ts";

/**
 * The interface the image's first-boot setup AP binds to. This mirrors the
 * interface name in the image's setup script; keep the two in step. CeraUI
 * never arms NetworkManager autoconnect on an owned hotspot profile while its
 * radio carries this name, so the setup AP never competes with an autonomous
 * CeraUI AP for the radio at boot. CeraUI's own restore still brings a saved
 * hotspot back once it is running.
 */
export const PROVISIONING_AP_IFNAME = "wlan0";

/** The setup AP's connection name, as the image's setup script fixes it. */
export const PROVISIONING_AP_CONNECTION_ID = "ceralive-ap";

/**
 * The station profile the image's setup portal writes for the network the
 * operator chose, and that the setup joins before it hands the radio back. The
 * script fixes this name; the portal deletes and re-adds the profile for every
 * submission, so each setup join leaves a profile with a new UUID.
 */
export const PROVISIONING_STATION_CONNECTION_ID = "ceralive-wifi";

/**
 * The image's setup marker. This mirrors the setup script's `ACTIVE_FLAG`
 * (`${STATE_DIR}/portal-active`, with `STATE_DIR` defaulting to
 * `/data/ceralive/provision`): the script writes it once its AP is up, keeps it
 * through the station handoff and any retry, and removes it at teardown, just
 * before it starts CeraUI again. Keep the two in step. The environment
 * override uses the script's own variable name and exists for tests and
 * development only.
 */
export const PROVISIONING_ACTIVE_MARKER =
	"/data/ceralive/provision/portal-active";

export function provisioningActiveMarkerPath(): string {
	return (
		process.env.CERALIVE_PROVISION_ACTIVE_FLAG ?? PROVISIONING_ACTIVE_MARKER
	);
}

/** NetworkManager fields a reader appends to recognise the setup AP. */
export const PROVISIONING_AP_FIELDS = [
	"connection.id",
	"802-11-wireless.mode",
] as const;

const provisioningConns = new Set<string>();
/** APs witnessed on the setup interface under the marker; cleared with it. */
const markerConns = new Set<string>();
let unreadableMarkerLogged = false;

/**
 * Whether the image's setup currently holds the setup radio. Only a missing
 * marker proves the setup is over; a marker that cannot be checked counts as
 * present, so an unreadable state never lets CeraUI displace the setup AP.
 */
export function isProvisioningSetupActive(): boolean {
	try {
		fs.statSync(provisioningActiveMarkerPath());
		return true;
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			markerConns.clear();
			return false;
		}
		if (!unreadableMarkerLogged)
			logger.warn(
				`the device image's setup marker could not be checked (${code ?? "unknown"}); treating the setup as active`,
			);
		unreadableMarkerLogged = true;
		return true;
	}
}

/** The setup radio, while the image's setup holds it. */
export function isProvisioningSetupHeld(ifname: string): boolean {
	return ifname === PROVISIONING_AP_IFNAME && isProvisioningSetupActive();
}

/** Pure recognition from one profile read; empty fields are never evidence. */
export function isProvisioningApProfile(profile: {
	readonly id?: string | undefined;
	readonly mode?: string | undefined;
}): boolean {
	return profile.mode === "ap" && profile.id === PROVISIONING_AP_CONNECTION_ID;
}

/**
 * Record what one profile read proved about `uuid` and return whether it is the
 * setup AP. A read that names a different connection and mode retires earlier
 * name evidence; a failed or partial read changes nothing. A UUID witnessed
 * under the marker stays the setup AP until the marker is gone.
 */
export function observeProvisioningApProfile(
	uuid: string,
	profile: {
		readonly id?: string | undefined;
		readonly mode?: string | undefined;
	},
): boolean {
	if (isProvisioningApProfile(profile)) {
		if (!provisioningConns.has(uuid))
			logger.info(
				`Wi-Fi profile ${uuid} is the device image's setup AP; CeraUI leaves it alone`,
			);
		provisioningConns.add(uuid);
		return true;
	}
	if (profile.id && profile.mode) provisioningConns.delete(uuid);
	return isProvisioningApConn(uuid);
}

/**
 * Under the marker, the AP active on the setup interface is the image's setup
 * AP whatever its connection name. `owned` excludes a profile CeraUI already
 * owns: the image creates its AP fresh, so an owned profile is never it.
 */
export function witnessProvisioningAp(
	rows: Iterable<WifiInterface>,
	uuid: string,
	owned: (uuid: string) => boolean,
): boolean {
	if (markerConns.has(uuid)) return isProvisioningApConn(uuid);
	let active = false;
	for (const row of rows)
		if (
			row.ifname === PROVISIONING_AP_IFNAME &&
			row.activeMode === "ap" &&
			row.activeConn === uuid
		)
			active = true;
	if (!active || owned(uuid) || !isProvisioningSetupActive()) return false;
	logger.info(
		`Wi-Fi profile ${uuid} is the AP the device image's setup runs on ${PROVISIONING_AP_IFNAME}; CeraUI leaves it alone`,
	);
	markerConns.add(uuid);
	return true;
}

/** Whether a profile read or the marker has proven it is the setup AP. */
export function isProvisioningApConn(uuid: string | null | undefined): boolean {
	if (!uuid) return false;
	if (provisioningConns.has(uuid)) return true;
	return markerConns.has(uuid) && isProvisioningSetupActive();
}

/** The setup AP's UUID when the radio currently runs it, on either leg. */
export function activeProvisioningAp(row: WifiInterface): string | undefined {
	for (const uuid of [
		row.activeMode === "ap" ? row.activeConn : undefined,
		row.conn,
		row.concurrentHotspot?.activeConn,
	])
		if (isProvisioningApConn(uuid)) return uuid ?? undefined;
	return undefined;
}

export function resetProvisioningApForTest(): void {
	provisioningConns.clear();
	markerConns.clear();
	unreadableMarkerLogged = false;
}
