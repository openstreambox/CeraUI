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

  The identity state alone is not current. Discovery invalidates every row's
  publication before its awaited NetworkManager read, while the previous
  verified sample stays in `wifiRadioIdentity.state`. Admission therefore also
  requires the publication guard the wire incarnation uses
  (`projectWifiRadioIncarnation`), and `confirmWifiAdapterLifetime` compares a
  fresh bracketed sysfs sample of the netif with the admitted lifetime right
  before an effect is dispatched.
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
	radioIdentityReaders,
	sameRadioLifetime,
	wifiRadioIdentity,
} from "./wifi-radio-identity.ts";
import { projectWifiRadioIncarnation } from "./wifi-radio-publication.ts";
import { sampleRadio } from "./wifi-radio-read-budget.ts";

/** Bound on the fresh sysfs sample taken before an effect. */
const CONFIRM_TIMEOUT_MS = 2_000;

/** A verified radio and the owner lock its current registry row resolves to. */
export type WifiAdapterAdmission = Readonly<{
	/** Registry key of the admitted row; always the bare permanent MAC. */
	registryKey: MacAddress;
	/** The exact registry object that was admitted. */
	row: WifiInterface;
	permanentMac: MacAddress;
	lifetime: RadioLifetime;
	/** The published incarnation the admission was made under. */
	incarnation: string;
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
	options: {
		/**
		 * Accept a sample whose publication a discovery pass has invalidated.
		 * Only for identifying a radio; never for authorizing an effect.
		 */
		readonly publicationPending?: boolean;
	} = {},
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
	// The identity must be the current publication, not a sample a discovery
	// pass has already invalidated.
	const incarnation = options.publicationPending
		? identity.incarnation
		: projectWifiRadioIncarnation(row, identity);
	if (incarnation === undefined) return undefined;
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
		incarnation,
		owner,
	};
}

/**
 * Is a radio's identity publication in flux? True while a discovery pass has
 * invalidated a sampled row's publication and not yet republished it (or the
 * row is suspended). Rows that never had a sample are not "pending": they are
 * simply never admitted.
 */
export function wifiRadioPublicationPending(): boolean {
	for (const row of Object.values(getWifiInterfacesByMacAddress())) {
		const identity = wifiRadioIdentity.state.rows.get(row.ifname);
		if (
			identity === undefined ||
			identity.row !== row ||
			identity.lifetime === undefined
		)
			continue;
		if (projectWifiRadioIncarnation(row, identity) === undefined) return true;
	}
	return false;
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
		now.incarnation === admission.incarnation &&
		samePhysicalWifiAdapter(now, admission)
	);
}

/**
 * Right before an effect, with the owner lock held: take a fresh bracketed
 * sample of the netif behind the admitted row and require the admitted lifetime
 * and permanent MAC, then re-check the admission after that await. A replug
 * under the same name, a sample that cannot be completed in time, or an
 * invalidated publication refuses.
 */
export async function confirmWifiAdapterLifetime(
	admission: WifiAdapterAdmission,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!wifiAdapterAdmissionCurrent(admission)) return false;
	const controller = new AbortController();
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	const timer = setTimeout(abort, CONFIRM_TIMEOUT_MS);
	try {
		const fresh = await sampleRadio(
			admission.row.ifname,
			radioIdentityReaders,
			controller.signal,
		);
		if (controller.signal.aborted || !fresh) return false;
		if (!sameRadioLifetime(fresh.lifetime, admission.lifetime)) return false;
		if (!fresh.macReadFailed && fresh.permanentMac !== admission.permanentMac)
			return false;
		return wifiAdapterAdmissionCurrent(admission);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}
