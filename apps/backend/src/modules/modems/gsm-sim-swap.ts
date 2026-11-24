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
  KEEP A PROFILE FOR ANOTHER SIM FROM CARRYING THIS ONE.

  NetworkManager matches a gsm profile to a modem by `gsm.device-id`, and
  compares `gsm.sim-id` / `gsm.sim-operator-id` only once the modem has
  reported its SIM (nm-modem.c, nm_modem_check_connection_compatible: "SIM
  properties may not be available before the SIM is unlocked"). Every new
  ModemManager object, at boot or after a re-probe, starts without that
  answer, so in that window every armed profile bound to the modem is a
  candidate and NetworkManager takes the most recently used one. After a SIM
  swap that is the profile of the SIM that was taken out. It stays up after
  the SIM is known: NetworkManager rechecks availability, not the active
  connection. Seen on an RM520N-GL after a cold-boot SIM swap: the old
  AT&T reseller profile (IPv4 only) came up on a T-Mobile SIM, and the
  profile CeraUI had prepared for that SIM never activated.

  Two parts, both here and in modem-ready-activation.ts:

  - PARK: when a modem registers with a readable SIM, every armed profile bound
    to its device id for a SIM that no present modem with that device id
    holds is disarmed (`connection.autoconnect=no`). The original value is
    recorded first, durably, so a crash between the two leaves something to
    restore. A profile without `gsm.sim-id` matches any SIM by design and is
    never touched. Nothing is deleted. An active profile is included: one
    bound to this device id for a SIM none of its modems hold can only be up
    as the hijack described above, and turning its autoconnect off does not
    take it down (the takeover replaces it). Skipping it would leave it armed
    for the next boot, where it wins the window again.
  - RE-ARM: when that SIM is back and its profile is the one selected for
    the modem, the recorded value is restored and the record dropped. A record
    found next to an armed profile is dropped without a write.

  Parking is skipped whenever a modem with the same device id has a SIM whose
  ICCID cannot be read: two identical modems can share a device id, and a SIM
  we cannot see may be the one that profile belongs to.
*/

import { logger } from "../../helpers/logger.ts";
import {
	type ConnectionUUID,
	nmConnSetFields,
} from "../network/network-manager.ts";
import { accessCellularAuthority } from "./cellular-authority-store.ts";
import {
	type PreparationRecord,
	parsePreparationRecord,
	preparationKey,
} from "./cellular-preparation-state.ts";
import {
	auditGsmProfiles,
	type GsmProfileAudit,
} from "./gsm-duplicate-reconcile.ts";

type ParkedRecord = Extract<PreparationRecord, { kind: "parked" }>;

export const parkedProfileKey = (
	uuid: string,
	deviceId: string,
	simId: string,
): string => preparationKey("parked", uuid, deviceId, simId);

/** SIM ids in modems with this device id, or undefined when any is unreadable. */
export type PresentSimReader = (
	deviceId: string,
) => Promise<ReadonlySet<string> | undefined>;

export interface GsmSimSwapDeps {
	readonly audit: () => Promise<Array<GsmProfileAudit>>;
	readonly presentSims: PresentSimReader;
	readonly setFields: (
		uuid: ConnectionUUID,
		fields: Record<string, string>,
	) => Promise<boolean>;
	readonly readParked: (key: string) => Promise<ParkedRecord | undefined>;
	readonly writeParked: (
		key: string,
		record: ParkedRecord | undefined,
	) => Promise<void>;
}

async function readParkedRecord(
	key: string,
): Promise<ParkedRecord | undefined> {
	const record = await accessCellularAuthority(
		"cellular-preparation",
		key,
		parsePreparationRecord,
		async (value) => value,
		process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR,
	);
	if (record === undefined) return undefined;
	if (record.kind !== "parked")
		throw new Error("Unexpected preparation authority");
	return record;
}

async function writeParkedRecord(
	key: string,
	record: ParkedRecord | undefined,
): Promise<void> {
	await accessCellularAuthority(
		"cellular-preparation",
		key,
		parsePreparationRecord,
		async (_value, write) => write(record),
		process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR,
	);
}

export function defaultGsmSimSwapDeps(
	presentSims: PresentSimReader,
): GsmSimSwapDeps {
	return {
		audit: auditGsmProfiles,
		presentSims,
		setFields: nmConnSetFields,
		readParked: readParkedRecord,
		writeParked: writeParkedRecord,
	};
}

export type GsmSimSwapResult = {
	readonly parked: number;
	readonly rearmed: boolean;
};

/** May this profile carry a modem whose SIM is not its own? */
export function isOtherSimCandidate(
	audit: GsmProfileAudit,
	deviceId: string,
	simId: string,
	keepUuid: string,
): boolean {
	return (
		audit.uuid !== keepUuid &&
		audit.deviceId === deviceId &&
		audit.simId.trim() !== "" &&
		audit.simId !== simId &&
		audit.autoconnect.trim() === "yes"
	);
}

/**
 * Re-arm the selected profile if CeraUI parked it, then park the profiles bound
 * to this modem for SIMs that are not inserted. `isCurrent` guards every write.
 */
export async function settleSimSwapProfiles(
	deviceId: string,
	simId: string,
	keepUuid: string,
	deps: GsmSimSwapDeps,
	isCurrent: () => boolean = () => true,
): Promise<GsmSimSwapResult> {
	if (!deviceId || !simId || !keepUuid) return { parked: 0, rearmed: false };
	const audits = await deps.audit();

	let rearmed = false;
	const selected = audits.find((audit) => audit.uuid === keepUuid);
	if (selected !== undefined) {
		const key = parkedProfileKey(keepUuid, deviceId, simId);
		const record = await deps.readParked(key);
		if (record && isCurrent()) {
			// A record next to an armed profile is spent: someone re-armed it, or
			// the park write never landed. Restoring it later could undo a later
			// owner's choice (preparation disarms automatic profiles on purpose).
			const restore = selected.autoconnect.trim() === "no";
			if (
				!restore ||
				(await deps.setFields(keepUuid, {
					"connection.autoconnect": record.original,
				}))
			) {
				await deps.writeParked(key, undefined);
				rearmed = restore;
				if (restore)
					logger.info(`re-armed gsm profile ${keepUuid}: its SIM is back`, {
						module: "modems",
						deviceId,
					});
			}
		}
	}

	const candidates = audits.filter((audit) =>
		isOtherSimCandidate(audit, deviceId, simId, keepUuid),
	);
	if (candidates.length === 0) return { parked: 0, rearmed };
	const present = await deps.presentSims(deviceId);
	if (present === undefined || !present.has(simId)) {
		// Not a statement about the profiles: we could not see every SIM.
		return { parked: 0, rearmed };
	}

	let parked = 0;
	for (const candidate of candidates) {
		if (present.has(candidate.simId) || !isCurrent()) continue;
		const key = parkedProfileKey(candidate.uuid, deviceId, candidate.simId);
		await deps.writeParked(key, {
			version: 1,
			kind: "parked",
			key,
			original: "yes",
		});
		if (
			isCurrent() &&
			(await deps.setFields(candidate.uuid, { "connection.autoconnect": "no" }))
		)
			parked += 1;
		// A failed write keeps the record: the profile may be disarmed anyway, and
		// a record next to an armed profile is dropped when its SIM is back.
	}
	if (parked > 0)
		logger.warn(
			`disarmed ${parked} gsm profiles bound to this modem for SIMs that are not inserted`,
			{ module: "modems", deviceId },
		);
	return { parked, rearmed };
}
