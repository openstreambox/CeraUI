/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * When a settled `unsafe` OS stage record stops holding power actions.
 *
 * `unsafe` says the attempt's OUTCOME is unknown, so no new round starts
 * without the operator and the record stays. It also closed the power gate,
 * because a reboot under a live RAUC writer, or into an armed or primary
 * target, would turn an unknown outcome into a booted one. Once the attempt is
 * settled (no active attempt id) and a fresh observation proves the physical
 * side quiet (RAUC idle with no other process or resource, no stage job
 * record, the booted slot healthy and primary, the target neither primary nor
 * armed) a reboot boots the slot that is running now, and holding it
 * protects nothing. The proof belongs to the exact record object it was taken
 * for and expires, so a changed record, a failed read or a stopped tick closes
 * the gate again.
 */

import type { OsStageRecovery } from "@ceraui/rpc/schemas";

/** Two idle ticks: one failed or missed refresh is enough to close the gate. */
export const UNSAFE_POWER_PROOF_TTL_MS = 120_000;

type Proof = { readonly record: OsStageRecovery; readonly provenAt: number };

export type UnsafePowerReleaseInputs = {
	/** The current recovery record, read again after the observation. */
	readonly record: () => OsStageRecovery | undefined;
	/** An OS stage of this process is starting, running or settling. */
	readonly writerActive: () => boolean;
	/** Fresh physical proof; false or a throw is "not proven". */
	readonly proveQuiet: () => Promise<boolean>;
	readonly now: () => number;
	/** Called once per record when its hold is first released. */
	readonly released?: (record: OsStageRecovery) => void;
};

export function settledUnsafe(record: OsStageRecovery | undefined): boolean {
	return record?.mode === "unsafe" && record.activeAttemptId === null;
}

export class UnsafePowerRelease {
	#proof: Proof | undefined;
	#announced: OsStageRecovery | undefined;

	/** True while `record` still holds power and restart actions. */
	holds(record: OsStageRecovery | undefined, now: number): boolean {
		if (!record) return false;
		if (record.activeAttemptId) return true;
		if (record.mode !== "unsafe") return false;
		const proof = this.#proof;
		return !(
			proof &&
			proof.record === record &&
			now >= proof.provenAt &&
			now - proof.provenAt < UNSAFE_POWER_PROOF_TTL_MS
		);
	}

	async refresh(inputs: UnsafePowerReleaseInputs): Promise<void> {
		const record = inputs.record();
		if (!settledUnsafe(record) || inputs.writerActive()) {
			this.#proof = undefined;
			return;
		}
		let quiet = false;
		try {
			quiet = await inputs.proveQuiet();
		} catch {
			quiet = false;
		}
		// The record or a writer may have moved during the observation.
		if (!quiet || inputs.record() !== record || inputs.writerActive()) {
			this.#proof = undefined;
			return;
		}
		if (!record) return;
		this.#proof = { record, provenAt: inputs.now() };
		if (this.#announced !== record) {
			this.#announced = record;
			inputs.released?.(record);
		}
	}

	/** Drop any proof without observing: nothing settled-unsafe is held now. */
	clear(): void {
		this.#proof = undefined;
	}

	reset(): void {
		this.#proof = undefined;
		this.#announced = undefined;
	}
}
