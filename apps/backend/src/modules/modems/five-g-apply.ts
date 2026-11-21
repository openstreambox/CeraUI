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
 * The `five-g-pref` module's WRITE half.
 *
 * Two rules carry it, and both are lessons this repo already paid for:
 *
 * 1. IT ROUTES THROUGH `withCapabilityModuleMutation`, never around it. A 5G
 *    posture change re-registers the radio and can cost the bond link, so the
 *    feature gate, the per-device lease, the reciprocal streaming refusal, the
 *    durable journal and the crash-surviving rollback all have to hold — and
 *    `five-g-pref` is a JOURNALED module, so the type system will not let this
 *    dispatch without a `preState`.
 *
 * 2. A REFUSED WRITE IS NEVER A SUCCESS. `mmSetNetworkTypes` answers `false` when
 *    mmcli did not print its confirmation and `undefined` when the spawn threw,
 *    and both were once dropped on the floor while the configure-echo parroted
 *    the REQUEST back — so a mode the modem rejected reached the operator as a
 *    success toast with the rejected value selected (see `apps/backend/docs/agents/the-radio-mode-an-operator-reads-must-be-a-live-read.md`
 *    → THE RADIO MODE AN OPERATOR READS MUST BE A LIVE READ). Here the echo is a
 *    READBACK: `applied` is the posture the radio was re-read on, and a radio
 *    that clamped the request reports `readback_mismatch` rather than success.
 */

import type {
	FiveGPreference,
	SetFiveGPreferenceOutput,
} from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";
import { IMPLEMENTED_MODEM_CAPABILITY_MODULES } from "./capability-evidence.ts";
import { withCapabilityModuleMutation } from "./capability-mutation.ts";
import {
	buildFiveGPreferenceView,
	fiveGPreferenceToModes,
	offeredFiveGPreferences,
	readFiveGPreference,
	sameModePair,
} from "./five-g-preference.ts";
import { mmGetModem, mmSetNetworkTypes, type NetworkType } from "./mmcli.ts";
import { saveManualModeChoice } from "./mode-choice-saved.ts";
import { deriveRadioModeCatalog } from "./modem-registration.ts";
import { broadcastModems } from "./modem-status.ts";
import { getModem, getModems, type Modem } from "./modems-state.ts";
import { modemStableKeyForId } from "./mutation-identity.ts";
import { registerMutationRollback } from "./mutation-rollback.ts";
import {
	tryClaimNetworkModeWrite,
	withNetworkModeWrite,
} from "./network-mode-slot.ts";

/**
 * `device` is the same selector every other modem procedure takes: a bare
 * ModemManager index ("2") or a full object path. Anything else resolves to
 * `undefined` and is refused, rather than coerced to `NaN` and dispatched.
 */
export function resolveModemIndex(device: string): number | undefined {
	const trailing =
		/^(?:\/org\/freedesktop\/ModemManager1\/Modem\/)?(\d+)$/.exec(
			device.trim(),
		);
	return trailing === null ? undefined : Number(trailing[1]);
}

export type FiveGApplyDeps = {
	readonly setNetworkTypes: (
		id: number,
		allowed: string,
		preferred: string,
	) => Promise<unknown>;
	/** Re-read the radio's live `(allowed, preferred)` catalog straight off mmcli. */
	readonly readRadioModes: (id: number) => Promise<Modem["radio_modes"]>;
	readonly broadcast: (id: number) => void;
};

async function readRadioModesFromDevice(
	id: number,
): Promise<Modem["radio_modes"]> {
	const info = await mmGetModem(id);
	return info === undefined ? undefined : deriveRadioModeCatalog(info);
}

export const defaultFiveGApplyDeps: FiveGApplyDeps = {
	setNetworkTypes: mmSetNetworkTypes,
	readRadioModes: readRadioModesFromDevice,
	broadcast: (id) => broadcastModems({ [id]: true }),
};

let activeDeps: FiveGApplyDeps = defaultFiveGApplyDeps;

export function setFiveGApplyDeps(deps: Partial<FiveGApplyDeps>): void {
	activeDeps = { ...defaultFiveGApplyDeps, ...deps };
}

export function resetFiveGApplyDeps(): void {
	activeDeps = defaultFiveGApplyDeps;
}

/**
 * Write one `(allowed, preferred)` pair and REPORT WHETHER IT LANDED.
 *
 * Shared by the operator path and the rollback handler, so a restore is proven
 * exactly as strictly as the change that made it necessary.
 */
async function writeModes(
	id: number,
	modes: NetworkType,
	deps: FiveGApplyDeps,
): Promise<{
	readonly wrote: boolean;
	readonly readback: Modem["radio_modes"];
}> {
	const wrote = Boolean(
		await deps.setNetworkTypes(id, modes.allowed, modes.preferred),
	);
	if (!wrote) return { wrote: false, readback: undefined };
	return { wrote: true, readback: await deps.readRadioModes(id) };
}

/**
 * The one writer of a streamer's mode choice.
 *
 * Order matters, and each step is a lesson from review:
 * 1. The global mode-write slot is taken FIRST, before anything is journaled, so
 *    a change already running on another modem (or a modem-settings save) is an
 *    honest `mutation_in_progress` — never a refused write that leaves this
 *    modem's journal `failed` and the modem blocked.
 * 2. The readback is judged by its `(allowed, preferred)` PAIR against the pair
 *    that was written, never by the posture name it reads as.
 * 3. The saved choice is written only after the journal confirmed, and a failure
 *    to save is reported as exactly that (`saved: false`). The radio changed; the
 *    answer must never say it did not.
 */
export async function applyFiveGPreference(
	device: string,
	preference: FiveGPreference,
	deps: FiveGApplyDeps = activeDeps,
): Promise<SetFiveGPreferenceOutput> {
	const release = tryClaimNetworkModeWrite();
	if (release === undefined)
		return { success: false, refusal: "mutation_in_progress" };
	try {
		return await applyFiveGPreferenceLocked(device, preference, deps);
	} finally {
		release();
	}
}
async function applyFiveGPreferenceLocked(
	device: string,
	preference: FiveGPreference,
	deps: FiveGApplyDeps,
): Promise<SetFiveGPreferenceOutput> {
	const id = resolveModemIndex(device);
	const modem = id === undefined ? undefined : getModem(id);
	if (id === undefined || modem === undefined) {
		return { success: false, error: "unknown_modem" };
	}

	// The catalog check runs on a PURE read, before a lease is taken and before
	// anything is journaled — the same ordering the USB-mode catalog check
	// follows. A posture this radio never advertised is doomed whatever the
	// device's lease state, and must not contend for it.
	const target = fiveGPreferenceToModes(preference, modem.radio_modes);
	if (target === undefined) {
		return { success: false, error: "not_offered" };
	}

	const stableKey = modemStableKeyForId(id);
	if (!stableKey) return { success: false, refusal: "identity_unresolved" };

	// The pre-state is the radio's OWN current pair, read live, so a rollback
	// restores what the operator had rather than a posture this model happens to
	// name. It is captured before the write and rides the durable journal entry.
	const liveBefore = await deps.readRadioModes(id);
	if (!liveBefore?.current?.allowed || !liveBefore.current.preferred)
		return { success: false, error: "readback_failed" };
	const preState = { ...liveBefore.current };
	const before = readFiveGPreference(liveBefore);

	// The generic is named rather than inferred: every branch below returns a
	// DIFFERENT literal-narrowed shape, so inference would pin `T` to whichever
	// one it saw first and reject the rest.
	const outcome = await withCapabilityModuleMutation<SetFiveGPreferenceOutput>(
		{
			module: "five-g-pref",
			stableKey,
			preState,
			// Passed EXPLICITLY, exactly as the wire producer does: the framework's
			// own registry default is empty, so leaving it out would refuse a
			// module whose probe and mutation path are both live — and would refuse
			// it differently from how the row reports it.
			implemented: IMPLEMENTED_MODEM_CAPABILITY_MODULES,
		},
		async ({ journal }) => {
			await journal?.markExecuting();
			const { wrote, readback } = await writeModes(id, target, deps);
			if (!wrote) {
				return {
					confirmed: false,
					value: { success: false, error: "write_failed" },
					detail: `mmcli did not confirm ${preference} on modem ${id}`,
				};
			}
			if (readback === undefined) {
				return {
					confirmed: false,
					value: { success: false, error: "readback_failed" },
					detail: `could not re-read modem ${id} after writing ${preference}`,
				};
			}

			// Whatever the verdict, the live read is committed to state — the wire
			// must report where the radio IS, not where it was asked to go.
			modem.radio_modes = readback;

			if (!sameModePair(readback.current, target)) {
				const landed = readFiveGPreference(readback);
				return {
					confirmed: false,
					value: { success: false, error: "readback_mismatch" },
					detail: `modem ${id} landed on ${landed ?? "an unnamed posture"}, not ${preference}`,
				};
			}
			return {
				confirmed: true,
				value: { success: true, applied: preference },
			};
		},
	);

	if (!outcome.ok) {
		deps.broadcast(id);
		return { success: false, refusal: outcome.refusal };
	}
	if (!outcome.value.success) {
		deps.broadcast(id);
		logger.error(`five-g-pref: ${preference} did not land on modem ${id}`, {
			module: "modems",
			error: outcome.value.error,
		});
		return outcome.value;
	}

	// The radio change is confirmed and its journal entry retired. Saving the
	// choice is bookkeeping on top: if it fails, say so, and say nothing else.
	const saved = saveManualModeChoice(id, {
		current: before,
		target: preference,
		estimatedLinkOutSeconds: modem.model?.startsWith("RM520") ? 55 : null,
	});
	deps.broadcast(id);
	return { ...outcome.value, saved };
}

/**
 * Put the radio back on its journaled pre-state.
 *
 * Registered against the `five-g-pref` journal kind, so a crash between arming
 * and confirming is replayed into a real restore rather than into an
 * `unavailable` verdict that leaves the device blocked for a mutation that CAN
 * be undone.
 *
 * A pre-state that names no allowed set answers `failed`, never `restored`: the
 * device was journaled without a readable posture, so nothing here can prove it
 * was put back, and claiming otherwise is the one thing a fail-closed rollback
 * must not do.
 */
export function createFiveGRollbackHandler(deps: FiveGApplyDeps = activeDeps) {
	return {
		async rollback(
			stableKey: string,
			preState: Readonly<Record<string, unknown>>,
		): Promise<"restored" | "failed"> {
			const allowed = preState.allowed;
			const preferred = preState.preferred;
			if (typeof allowed !== "string" || allowed === "") return "failed";

			const id = findModemIdForStableKey(stableKey);
			if (id === undefined) return "failed";

			const modes: NetworkType = {
				allowed,
				preferred:
					typeof preferred === "string" && preferred !== ""
						? preferred
						: "none",
			};
			// A restore WAITS for a running mode write rather than being refused:
			// refusing it would leave the device blocked for a change it can undo.
			const { wrote, readback } = await withNetworkModeWrite(() =>
				writeModes(id, modes, deps),
			);
			if (!wrote || readback === undefined) return "failed";

			// The restore is proven exactly as the change was: by comparing the
			// radio's re-read pair against what was asked for. Both fields are
			// compared, because `prefer-5g` and `prefer-4g` share an allowed set and
			// an allowed-only check would call either one a successful restore of
			// the other.
			return sameModePair(readback.current, modes) ? "restored" : "failed";
		},
	};
}

function findModemIdForStableKey(stableKey: string): number | undefined {
	for (const key of Object.keys(getModems())) {
		const id = Number(key);
		if (modemStableKeyForId(id) === stableKey) return id;
	}
	return undefined;
}

// Registered at MODULE SCOPE, the `usb-mode-rollback.ts` / `band-rollback.ts`
// precedent: a rollback handler that has to be remembered at a boot call site is
// one a refactor can drop, and dropping it silently downgrades a recoverable
// mutation to the `unavailable` verdict that leaves a device blocked.
registerMutationRollback("five-g-pref", createFiveGRollbackHandler());

export { buildFiveGPreferenceView, offeredFiveGPreferences };
