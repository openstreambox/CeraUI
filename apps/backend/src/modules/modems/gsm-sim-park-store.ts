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

/*
  WHICH GSM PROFILES CERAUI DISARMED FOR A SIM THAT WAS NOT INSERTED.

  One private JSON file per parked profile, keyed by a hash of
  (uuid, device id, SIM id), so no ICCID is filed in clear. The store is its
  own directory on purpose: the cellular authority stores are parsed in full
  by the boot inventory of every build, and an older build that met a record
  kind it does not know would hold recovery (and with it every Stream Start)
  forever. Nothing but this module reads this directory, so a rollback to an
  older build ignores it. What such a build does with a parked profile is in
  docs/agents/the-modem-mutation-safety-contract.md ("SIM swap parking").
*/

import { createHash } from "node:crypto";
import { z } from "zod";
import {
	readPrivateJson,
	writePrivateJson,
} from "../../helpers/private-json-state.ts";

const parkedSchema = z
	.object({
		version: z.literal(1),
		key: z.string(),
		original: z.literal("yes"),
	})
	.strict();
export type ParkedRecord = z.infer<typeof parkedSchema>;

function storeDir(): string {
	return process.env.CERALIVE_GSM_SIM_PARK_DIR ?? "/data/ceralive/gsm-sim-park";
}

export function parkedProfileKey(
	uuid: string,
	deviceId: string,
	simId: string,
): string {
	const parts = [uuid, deviceId, simId];
	if (parts.some((part) => !part || part.length > 1024))
		throw new Error("Unresolved parked profile identity");
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function newParkedRecord(key: string): ParkedRecord {
	return { version: 1, key, original: "yes" };
}

export async function readParkedRecord(
	key: string,
): Promise<ParkedRecord | undefined> {
	const value = await readPrivateJson({ dir: storeDir() }, key);
	if (value === undefined) return undefined;
	const record = parkedSchema.parse(value);
	if (record.key !== key)
		throw new Error("Parked profile record belongs to another identity");
	return record;
}

export async function writeParkedRecord(
	key: string,
	record: ParkedRecord | undefined,
): Promise<void> {
	if (record !== undefined && record.key !== key)
		throw new Error("Parked profile record belongs to another identity");
	await writePrivateJson({ dir: storeDir() }, key, record);
}

/**
 * Does CeraUI hold a park record for this profile? An unreadable store answers
 * true: callers use this to RETAIN a profile, and a failed read is not evidence
 * that it may go.
 */
export async function isProfileParked(
	uuid: string,
	deviceId: string,
	simId: string,
): Promise<boolean> {
	if (!uuid || !deviceId || !simId) return false;
	try {
		return (
			(await readParkedRecord(parkedProfileKey(uuid, deviceId, simId))) !==
			undefined
		);
	} catch {
		return true;
	}
}
