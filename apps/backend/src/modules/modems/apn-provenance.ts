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
 * The carrier intent (`automatic-carrier-intent.ts`) already says it for two
 * writers: a manual intent holds what someone saved in the modem dialog, and an
 * applied automatic intent holds what a qualified carrier table row applied
 * (`automatic-carrier-profile.ts`). The third writer, the provider database
 * (`provider-apn.ts`), applies an APN when a SIM's profile is created and has
 * no carrier row. Its profile keeps a PENDING automatic intent whose expected
 * APN is the database's, exactly what that intent already means: automatic,
 * nothing applied by the carrier table, NetworkManager holding this APN. Every
 * backend, including one that predates this record, therefore keeps the
 * profile automatic, prepares its transport and lets a carrier row take over.
 *
 * This record, kept per intent key beside the intent, adds who chose that
 * expected APN: the provider database, for one SIM's own network (MCC+MNC in
 * `network`). Profile copying reads it so that value is never handed to
 * another SIM, the dialog says where it came from, and a save with Automatic
 * APN on keeps it. It lives in its own directory so a backend booted from the
 * other OS slot on the same data partition never reads it, and it counts only
 * while it still describes the intent it was written with
 * (`resolveApnOrigin`).
 */

import {
	type CarrierIntent,
	type CarrierIntentIdentity,
	carrierIntentKey,
	newPendingCarrierIntent,
} from "./automatic-carrier-intent.ts";
import { accessCellularAuthority } from "./cellular-authority-store.ts";

/** Who chose a profile's APN; only the provider database needs a record. */
export type ApnOrigin = "provider-database" | "carrier-table" | "user";

export interface ApnProvenance {
	readonly version: 1;
	readonly key: string;
	readonly origin: "provider-database";
	/** The APN written with the intent; binds this record to that intent. */
	readonly apn: string;
	/** MCC+MNC the provider database was read for. */
	readonly network: string;
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

const APN = /^[a-zA-Z0-9._-]{1,100}$/;
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
		record.origin !== "provider-database" ||
		typeof record.apn !== "string" ||
		!APN.test(record.apn) ||
		typeof record.network !== "string" ||
		!NETWORK.test(record.network)
	)
		throw new Error("Invalid APN provenance");
	return {
		version: 1,
		key,
		origin: "provider-database",
		apn: record.apn,
		network: record.network,
	};
}

export function newApnProvenance(
	identity: CarrierIntentIdentity,
	apn: string,
	network: string,
): ApnProvenance {
	const key = carrierIntentKey(identity);
	return parseApnProvenanceSlot(
		{ version: 1, key, origin: "provider-database", apn, network },
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
 */
export function resolveApnOrigin(
	intent: CarrierIntent | undefined,
	provenance: ApnProvenance | undefined,
	nmAutomatic: boolean,
	apn: string,
): ResolvedApnOrigin | undefined {
	if (!intent) return undefined;
	if (intent.mode === "manual") return { origin: "user" };
	// NetworkManager picks the APN itself: nobody's choice is in effect.
	if (nmAutomatic) return undefined;
	if (intent.phase === "applied")
		return intent.appliedApn === apn ? { origin: "carrier-table" } : undefined;
	return intent.pendingApn !== undefined &&
		intent.pendingApn === apn &&
		provenance?.apn === apn
		? { origin: "provider-database", network: provenance.network }
		: undefined;
}

/** The carrier intent a database APN is applied under (see the header). */
export function databaseApnIntent(
	identity: CarrierIntentIdentity,
	apn: string,
): CarrierIntent {
	return newPendingCarrierIntent(identity, apn);
}

/** Whether `apn` can be recorded in the carrier intent (its APN grammar). */
export function recordableApn(apn: string): boolean {
	return /^[a-zA-Z0-9._-]{1,100}$/.test(apn);
}
