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
  candidate: NetworkManager takes the highest autoconnect priority, then the
  most recently used. After a SIM swap that is usually the profile of the SIM
  that was taken out. It stays up after the SIM is known: NetworkManager
  rechecks availability, not the active connection. Seen on an RM520N-GL
  after a cold-boot SIM swap; reproduced with a stand-in profile on a DW5821e.

  Three parts:

  - TAKEOVER (modem-ready-activation.ts): the first activation activates the
    modem's own profile when the device is up on one that names another SIM.
  - PARK (here): every armed profile bound to the modem's device id for a SIM
    that no present modem with that device id holds gets
    `connection.autoconnect=no`, so the next window cannot pick it. The
    original value is recorded first (gsm-sim-park-store.ts). A profile that
    is up is included: one that passes that check can only be up as the case
    above, and turning autoconnect off does not take it down. A profile
    without `gsm.sim-id` matches any SIM by design and is never touched.
    Parking deletes nothing, and the duplicate cleanup keeps a parked profile
    (gsm-duplicate-reconcile.ts), so parking is never evidence for a deletion.
    A never-activated profile (timestamp 0) that has a sibling for the same
    device id and SIM is left alone: an older build's duplicate cleanup would
    read it, once disarmed, as its own demoted clone and delete it. The
    ordinary two-pass cleanup handles it once that SIM is back.
  - RE-ARM (here): when a modem holds that SIM again, every parked profile for
    that (device id, SIM) gets its recorded value back and its record dropped.
    A record found next to an armed profile is spent (someone re-armed it, or
    the park write never landed) and is dropped without a write.

  Parking is skipped whenever a modem that may share the device id has a SIM
  that cannot be read: one with no SIM object yet, one without a device id,
  or a USB device of the same model that ModemManager has not listed
  (modem-registration.ts, readPresentSimIds). Two identical modems can share a
  device id, and a SIM we cannot see may be the one that profile belongs to.
  Both steps need a complete profile audit: a profile we could not read may
  be a parked one or the sibling that decides a skip. A skipped step, an
  incomplete audit, a store fault or a failed write leaves the settle
  INCOMPLETE: the status poll tries again later in the same registration, and
  nothing blocks the modem.

  Both steps run under the modem's identity lease with an armed journal entry
  (modem-registration.ts, settleModemSimSwap): an autoconnect change decides
  what NetworkManager may bring up next. The entry's pre-state is the modem's
  descriptor capture with no `format`, so replay on any build, including one
  without this change, takes the generic descriptor path and finds nothing to
  restore; the park records describe themselves and the next pass converges
  a crash between record and write.

  Limit: a user's `autoconnect=no` set by hand on a profile that is already
  parked, or between the record and the disarm of an interrupted pass, cannot
  be told apart from the parking and is restored on re-arm. Any change that
  arms the profile in between spends the record.
*/

import { logger } from "../../helpers/logger.ts";
import {
	type ConnectionUUID,
	nmConnSetFields,
} from "../network/network-manager.ts";
import {
	auditGsmProfilesComplete,
	type GsmProfileAudit,
} from "./gsm-duplicate-reconcile.ts";
import {
	newParkedRecord,
	type ParkedRecord,
	parkedProfileKey,
	readParkedRecord,
	writeParkedRecord,
} from "./gsm-sim-park-store.ts";

/** SIM ids in modems with this device id, or undefined when any is unreadable. */
export type PresentSimReader = (
	deviceId: string,
) => Promise<ReadonlySet<string> | undefined>;

export interface GsmSimSwapDeps {
	/** Every gsm profile, or undefined when any of them could not be read. */
	readonly audit: () => Promise<Array<GsmProfileAudit> | undefined>;
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

export function defaultGsmSimSwapDeps(
	presentSims: PresentSimReader,
): GsmSimSwapDeps {
	return {
		audit: auditGsmProfilesComplete,
		presentSims,
		setFields: nmConnSetFields,
		readParked: readParkedRecord,
		writeParked: writeParkedRecord,
	};
}

export type GsmSimSwapResult = {
	readonly parked: number;
	readonly rearmed: number;
	/** False when a step was skipped or a write failed: try again later. */
	readonly complete: boolean;
};

type StepResult = { readonly count: number; readonly complete: boolean };

/** May this profile carry a modem of this device id whose SIM is not its own? */
export function isOtherSimCandidate(
	audit: GsmProfileAudit,
	deviceId: string,
	simId: string,
): boolean {
	return (
		audit.deviceId === deviceId &&
		audit.simId.trim() !== "" &&
		audit.simId !== simId &&
		audit.autoconnect.trim() === "yes"
	);
}

function storeFault(step: string, deviceId: string, error: unknown): void {
	logger.warn(`gsm profile ${step} skipped: its record store failed`, {
		module: "modems",
		deviceId,
		error: error instanceof Error ? error.message : String(error),
	});
}

async function rearmReturningSim(
	audits: readonly GsmProfileAudit[],
	deviceId: string,
	simId: string,
	deps: GsmSimSwapDeps,
	isCurrent: () => boolean,
): Promise<StepResult> {
	let rearmed = 0;
	let complete = true;
	for (const audit of audits) {
		if (audit.deviceId !== deviceId || audit.simId !== simId) continue;
		if (!isCurrent()) break;
		const key = parkedProfileKey(audit.uuid, deviceId, simId);
		try {
			const record = await deps.readParked(key);
			if (!record || !isCurrent()) continue;
			if (audit.autoconnect.trim() !== "no") {
				await deps.writeParked(key, undefined);
				continue;
			}
			if (
				await deps.setFields(audit.uuid, {
					"connection.autoconnect": record.original,
				})
			) {
				rearmed += 1;
				await deps.writeParked(key, undefined);
			} else complete = false;
		} catch (error) {
			complete = false;
			storeFault("re-arm", deviceId, error);
		}
	}
	if (rearmed > 0)
		logger.info(`re-armed ${rearmed} gsm profiles: their SIM is back`, {
			module: "modems",
			deviceId,
		});
	return { count: rearmed, complete };
}

/**
 * Would an older build's duplicate cleanup delete this profile once it is
 * disarmed? Its classifier prunes an idle, disarmed, never-activated profile
 * that is not the one it keeps for that (device id, SIM).
 */
function prunableOnceDisarmed(
	candidate: GsmProfileAudit,
	audits: readonly GsmProfileAudit[],
): boolean {
	return (
		Number.parseInt(candidate.timestamp, 10) === 0 &&
		audits.some(
			(other) =>
				other.uuid !== candidate.uuid &&
				other.deviceId === candidate.deviceId &&
				other.simId === candidate.simId,
		)
	);
}

async function parkOtherSims(
	audits: readonly GsmProfileAudit[],
	deviceId: string,
	simId: string,
	deps: GsmSimSwapDeps,
	isCurrent: () => boolean,
): Promise<StepResult> {
	const candidates = audits.filter(
		(audit) =>
			isOtherSimCandidate(audit, deviceId, simId) &&
			!prunableOnceDisarmed(audit, audits),
	);
	if (candidates.length === 0) return { count: 0, complete: true };
	const present = await deps.presentSims(deviceId);
	// Not a statement about the profiles: we could not see every SIM.
	if (present === undefined || !present.has(simId))
		return { count: 0, complete: false };

	let parked = 0;
	let complete = true;
	for (const candidate of candidates) {
		if (present.has(candidate.simId)) continue;
		if (!isCurrent()) break;
		const key = parkedProfileKey(candidate.uuid, deviceId, candidate.simId);
		try {
			await deps.writeParked(key, newParkedRecord(key));
		} catch (error) {
			storeFault("parking", deviceId, error);
			complete = false;
			break;
		}
		// A failed write keeps the record: the profile may be disarmed anyway,
		// and a record next to an armed profile is spent when its SIM is back.
		if (
			isCurrent() &&
			(await deps.setFields(candidate.uuid, {
				"connection.autoconnect": "no",
			}))
		)
			parked += 1;
		else complete = false;
	}
	if (parked > 0)
		logger.warn(
			`disarmed ${parked} gsm profiles bound to this modem for SIMs it does not hold`,
			{ module: "modems", deviceId },
		);
	return { count: parked, complete };
}

/**
 * Re-arm the parked profiles of the SIM this modem holds, then park the
 * profiles bound to it for SIMs no modem with its device id holds.
 * `isCurrent` guards every write; the caller holds the identity lease.
 */
export async function settleSimSwapProfiles(
	deviceId: string,
	simId: string,
	deps: GsmSimSwapDeps,
	isCurrent: () => boolean = () => true,
): Promise<GsmSimSwapResult> {
	if (!deviceId || !simId) return { parked: 0, rearmed: 0, complete: false };
	const audits = await deps.audit();
	// A profile we could not read may be a parked one or a sibling: try later.
	if (audits === undefined) return { parked: 0, rearmed: 0, complete: false };
	const rearmed = await rearmReturningSim(
		audits,
		deviceId,
		simId,
		deps,
		isCurrent,
	);
	const parked = await parkOtherSims(audits, deviceId, simId, deps, isCurrent);
	return {
		parked: parked.count,
		rearmed: rearmed.count,
		complete: rearmed.complete && parked.complete && isCurrent(),
	};
}
