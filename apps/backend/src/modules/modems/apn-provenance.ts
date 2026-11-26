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

/**
 * Where an APN that CeraUI wrote into a gsm profile came from.
 *
 * The carrier intent (`automatic-carrier-intent.ts`) says whether a profile is
 * automatic or manual to CeraUI. This record, kept per intent key beside it,
 * says who chose the APN that intent was written with:
 *
 *  - `provider-database`: looked up for one SIM's own network (MCC+MNC in
 *    `network`) when its profile was created (`provider-apn.ts`). The profile
 *    stays automatic to CeraUI, so transport preparation runs as for any other
 *    automatic profile, and the value is never handed to another SIM;
 *  - `carrier-table`: a qualified carrier table row (`subscription-policy.ts`);
 *  - `user`: typed in the modem dialog (a manual save).
 *
 * Profile copying and transport preparation read this record instead of
 * comparing APN values. It lives in its own directory rather than inside the
 * intent record so that a backend that predates it, booted from the other OS
 * slot on the same data partition, still parses every intent it finds.
 *
 * A record counts only while it still describes the intent it was written
 * with (`resolveApnOrigin`); a record left behind by a later intent change,
 * say by an older backend, is ignored rather than trusted.
 */

import {
	type CarrierIntent,
	type CarrierIntentIdentity,
	carrierIntentKey,
} from "./automatic-carrier-intent.ts";
import { accessCellularAuthority } from "./cellular-authority-store.ts";

export type ApnOrigin = "provider-database" | "carrier-table" | "user";

export interface ApnProvenance {
	readonly version: 1;
	readonly key: string;
	readonly origin: ApnOrigin;
	/** The APN written with the intent; binds this record to that intent. */
	readonly apn: string;
	/** MCC+MNC the provider database was read for (`provider-database` only). */
	readonly network?: string;
}

/** What a profile's APN is, as far as CeraUI's own records go. */
export type ResolvedApnOrigin =
	| { readonly origin: "provider-database"; readonly network: string }
	| { readonly origin: "carrier-table" }
	| { readonly origin: "user" };

export interface ApnProvenanceStore {
	readonly dir: string | undefined;
}
const defaultStore: ApnProvenanceStore = {
	get dir() {
		return process.env.CERALIVE_APN_PROVENANCE_STATE_DIR;
	},
};

const APN = /^[a-zA-Z0-9._-]{0,100}$/;
const NETWORK = /^\d{5,6}$/;

export function parseApnProvenanceSlot(
	value: unknown,
	key: string,
): ApnProvenance {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid APN provenance");
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).some(
			(name) => !["version", "key", "origin", "apn", "network"].includes(name),
		) ||
		record.version !== 1 ||
		record.key !== key ||
		(record.origin !== "provider-database" &&
			record.origin !== "carrier-table" &&
			record.origin !== "user") ||
		typeof record.apn !== "string" ||
		!APN.test(record.apn) ||
		(record.origin === "provider-database"
			? typeof record.network !== "string" ||
				!NETWORK.test(record.network) ||
				record.apn === ""
			: record.network !== undefined)
	)
		throw new Error("Invalid APN provenance");
	return {
		version: 1,
		key,
		origin: record.origin,
		apn: record.apn,
		...(typeof record.network === "string" ? { network: record.network } : {}),
	};
}

export function newApnProvenance(
	identity: CarrierIntentIdentity,
	origin: ApnOrigin,
	apn: string,
	network?: string,
): ApnProvenance {
	const key = carrierIntentKey(identity);
	return parseApnProvenanceSlot(
		{
			version: 1,
			key,
			origin,
			apn,
			...(network !== undefined ? { network } : {}),
		},
		key,
	);
}

export async function readApnProvenance(
	identity: CarrierIntentIdentity,
	store: ApnProvenanceStore = defaultStore,
): Promise<ApnProvenance | undefined> {
	return accessCellularAuthority(
		"apn-provenance",
		carrierIntentKey(identity),
		parseApnProvenanceSlot,
		async (value) => value,
		store.dir,
		store === defaultStore,
	);
}

/** Written beside the carrier intent, under the same lease as that write. */
export async function writeApnProvenance(
	identity: CarrierIntentIdentity,
	record: ApnProvenance | undefined,
	store: ApnProvenanceStore = defaultStore,
): Promise<void> {
	const key = carrierIntentKey(identity);
	if (record) parseApnProvenanceSlot(record, key);
	await accessCellularAuthority(
		"apn-provenance",
		key,
		parseApnProvenanceSlot,
		async (_value, write) => write(record),
		store.dir,
		store === defaultStore,
	);
}

/**
 * Who chose the profile's current APN, from the intent and this record.
 * `undefined`: CeraUI wrote no APN (NetworkManager picks it), or NetworkManager
 * now holds an APN no CeraUI record accounts for.
 *
 * An applied automatic intent without a matching record was written by the
 * carrier table before this record existed, which is the only writer that
 * produced one then.
 */
export function resolveApnOrigin(
	intent: CarrierIntent | undefined,
	provenance: ApnProvenance | undefined,
	nmAutomatic: boolean,
	apn: string,
): ResolvedApnOrigin | undefined {
	if (!intent) return undefined;
	if (intent.mode === "manual") return { origin: "user" };
	if (
		intent.phase !== "applied" ||
		intent.appliedApn === undefined ||
		// NetworkManager picks the APN itself, or holds one this intent did not apply.
		nmAutomatic ||
		intent.appliedApn !== apn
	)
		return undefined;
	if (provenance?.apn === intent.appliedApn) {
		if (provenance.origin === "provider-database" && provenance.network)
			return { origin: "provider-database", network: provenance.network };
		if (provenance.origin === "carrier-table")
			return { origin: "carrier-table" };
	}
	return { origin: "carrier-table" };
}

/** Whether `apn` can be recorded in the carrier intent (its APN grammar). */
export function recordableApn(apn: string): boolean {
	return /^[a-zA-Z0-9._-]{1,100}$/.test(apn);
}
