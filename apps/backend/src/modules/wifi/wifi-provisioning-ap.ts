/*
  The device image's first-boot setup Wi-Fi is a separate NetworkManager AP
  that CeraUI must never own. The image's setup script creates it as an
  unpinned, ifname-bound, autoconnect-off AP profile, activates it before it
  stops CeraUI, and later brings it down and deletes it by connection name.
  Upstream discovery can find an unpinned AP by its interface name and would
  then repin it, raise its priority and remember its credentials, so every
  adoption, repair, policy, cleanup and user-mutation path asks this module
  first.

  Recognition uses positive evidence from NetworkManager's own profile fields
  only: AP mode and the script's fixed connection name. The setup SSID
  (`CeraLive-Setup-<4 hex>`) is not sufficient on its own, since a CeraUI AP may
  legitimately carry such an SSID after an older build remembered the setup
  credentials.
*/

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

/** NetworkManager fields a reader appends to recognise the setup AP. */
export const PROVISIONING_AP_FIELDS = [
	"connection.id",
	"802-11-wireless.mode",
] as const;

const provisioningConns = new Set<string>();

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
 * evidence; a failed or partial read changes nothing.
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
	return provisioningConns.has(uuid);
}

/** Whether a read of this profile has proven it is the setup AP. */
export function isProvisioningApConn(uuid: string | null | undefined): boolean {
	return uuid ? provisioningConns.has(uuid) : false;
}

/** The setup AP's UUID when the radio currently runs it, on either leg. */
export function activeProvisioningAp(row: WifiInterface): string | undefined {
	for (const uuid of [
		row.activeMode === "ap" ? row.activeConn : undefined,
		row.conn,
		row.concurrentHotspot?.activeConn,
	])
		if (uuid && provisioningConns.has(uuid)) return uuid;
	return undefined;
}

export function resetProvisioningApForTest(): void {
	provisioningConns.clear();
}
