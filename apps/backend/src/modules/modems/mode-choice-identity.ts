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
 * Which modem a saved mode choice belongs to.
 *
 * Keyed by the modem itself, not by the USB port it sits in: swapping two modems
 * between ports must not hand one modem's saved choice to the other. The key is
 * an HMAC of the equipment identifier (IMEI) under the device-local key, so the
 * IMEI itself is never stored, never sent and never logged by this module, and
 * the tag means nothing on another device. Only the tag is kept, in memory, per
 * ModemManager index.
 *
 * No equipment identifier, or no usable key: no tag, and no choice is saved.
 */

import { createHmac } from "node:crypto";

import { loadModeChoiceKey } from "./mode-choice-key.ts";

const TAG_RE = /^[a-f0-9]{64}$/;
const MMCLI_EMPTY = "--";

export function isModemIdentityTag(value: string): boolean {
	return TAG_RE.test(value);
}

/** Pure: the tag for one equipment identifier under one key. */
export function modemIdentityTag(
	key: Uint8Array,
	equipmentId: string,
): string | undefined {
	const id = equipmentId.trim();
	if (id === "" || id === MMCLI_EMPTY || key.length !== 32) return undefined;
	return createHmac("sha256", key)
		.update("ceraui-modem-identity\0")
		.update(id)
		.digest("hex");
}

const tags = new Map<number, string>();

/** Called when a modem registers; the identifier is used once and dropped. */
export function rememberModemIdentity(
	id: number,
	equipmentId: string | undefined,
): void {
	const key =
		equipmentId === undefined ? undefined : loadModeChoiceKey({ create: true });
	const tag =
		key === undefined || equipmentId === undefined
			? undefined
			: modemIdentityTag(key, equipmentId);
	if (tag === undefined) tags.delete(id);
	else tags.set(id, tag);
}

export function modemIdentityTagForId(id: number): string | undefined {
	return tags.get(id);
}

export function forgetModemIdentity(id: number): void {
	tags.delete(id);
}

/** Tests only. */
export function resetModemIdentities(): void {
	tags.clear();
}
