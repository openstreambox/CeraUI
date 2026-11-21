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
  Admission of a physical radio for callers that hold a permanent MAC (or a
  registry key) and want to mutate that radio under the Wi-Fi adapter lock.

  The lock key is no longer the bare MAC: `wifiAdapterLockKey` resolves the
  current owner, which can be a composite `mac@...` hotspot owner, and a radio
  whose identity is Limited or Unverified is not keyed by its MAC at all. A
  caller that derives a key from a MAC it remembered can therefore take a lock
  nobody else contends for, or the lock of a replacement radio.

  So the physical identity (permanent MAC + the sampled radio lifetime) is kept
  apart from the owner key. Admission accepts only a verified identity row bound
  to the exact registry object, records the owner key that row resolves to, and
  `wifiAdapterAdmissionCurrent` re-checks all of it once that owner lock is held:
  the same registry object under the same key, the same lifetime, and the same
  owner. Anything uncertain is refused rather than guessed.
*/

import type { MacAddress } from "../network/network-manager.ts";
import {
	ownsWifiAdapterLock,
	type WifiAdapterLockKey,
	wifiAdapterLockKey,
} from "./wifi-adapter-lock.ts";
import { getWifiInterfacesByMacAddress } from "./wifi-connections.ts";
import type { WifiInterface } from "./wifi-interfaces.ts";
import { normalizeMacAddress } from "./wifi-permanent-mac.ts";
import {
	type RadioLifetime,
	sameRadioLifetime,
	wifiRadioIdentity,
} from "./wifi-radio-identity.ts";

/** A verified radio and the owner lock its current registry row resolves to. */
export type WifiAdapterAdmission = Readonly<{
	/** Registry key of the admitted row; always the bare permanent MAC. */
	registryKey: MacAddress;
	/** The exact registry object that was admitted. */
	row: WifiInterface;
	permanentMac: MacAddress;
	lifetime: RadioLifetime;
	/** Lock key the row resolved to at admission. Never compared as identity. */
	owner: WifiAdapterLockKey;
}>;

/**
 * Admit the radio behind a registry key. Only a verified, ready identity row
 * that names this exact registry object qualifies; Limited, Unverified and
 * degraded rows, rows without a sampled lifetime and keys that are not a bare
 * MAC are refused.
 */
export function admitWifiAdapter(
	registryKey: string,
): WifiAdapterAdmission | undefined {
	const permanentMac = normalizeMacAddress(registryKey);
	if (!permanentMac || permanentMac !== registryKey) return undefined;
	const row = getWifiInterfacesByMacAddress()[registryKey];
	if (!row || row.removed || row.degradedReason !== undefined) return undefined;
	const identity = wifiRadioIdentity.state.rows.get(row.ifname);
	if (
		identity?.row !== row ||
		identity.classification !== "verified" ||
		identity.degradedReason !== undefined ||
		identity.key !== registryKey ||
		identity.permanentMac !== permanentMac ||
		!identity.lifetime
	)
		return undefined;
	const owner = wifiAdapterLockKey(registryKey);
	// A MAC-keyed row resolves to its own MAC or a `mac@...` owner; anything else
	// would serialize this radio against another one.
	if (normalizeMacAddress(owner.split("@")[0]) !== permanentMac)
		return undefined;
	return {
		registryKey: permanentMac,
		row,
		permanentMac,
		lifetime: identity.lifetime,
		owner,
	};
}

/** Admit the radio a permanent MAC names; refused when no verified row has it. */
export function admitWifiAdapterByMac(
	macAddress: string,
): WifiAdapterAdmission | undefined {
	const permanentMac = normalizeMacAddress(macAddress);
	return permanentMac ? admitWifiAdapter(permanentMac) : undefined;
}

/** Same physical radio: permanent MAC and sampled lifetime, never the lock key. */
export function samePhysicalWifiAdapter(
	a: Pick<WifiAdapterAdmission, "permanentMac" | "lifetime">,
	b: Pick<WifiAdapterAdmission, "permanentMac" | "lifetime">,
): boolean {
	return (
		a.permanentMac === b.permanentMac &&
		sameRadioLifetime(a.lifetime, b.lifetime)
	);
}

/** A stable string for the physical radio, for keying per-radio state. */
export function physicalWifiAdapterId(
	admission: Pick<WifiAdapterAdmission, "permanentMac" | "lifetime">,
): string {
	const { ifindex, wiphy, phyPath } = admission.lifetime;
	return `${admission.permanentMac}/${ifindex}:${wiphy}:${phyPath}`;
}

/**
 * Re-check an admission while its owner lock is held: the registry still maps
 * the key to the very same object, its identity is still verified with the same
 * lifetime, and the row still resolves to the owner whose lock is held.
 */
export function wifiAdapterAdmissionCurrent(
	admission: WifiAdapterAdmission,
): boolean {
	if (!ownsWifiAdapterLock(admission.owner)) return false;
	const now = admitWifiAdapter(admission.registryKey);
	return (
		now !== undefined &&
		now.row === admission.row &&
		now.owner === admission.owner &&
		samePhysicalWifiAdapter(now, admission)
	);
}
