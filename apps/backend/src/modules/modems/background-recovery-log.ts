/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Why an automatic modem recovery did not act, said once per change.
 *
 * The status poll runs the dead-bearer reconnect, the ready redial and the
 * first ready activation every few seconds. All three stayed silent when they
 * were held back: a refused lease or a dead path the reconnect would not touch
 * left no trace, so a modem that never came back could not be told apart from one
 * whose recovery was blocked. Each modem and recovery kind logs its reason when
 * it changes, and once when the recovery may act again, so a poll that keeps
 * hitting the same reason costs one line, not one per poll.
 */
import type { ModemMutationRefusal } from "@ceraui/rpc/schemas";

import { logger as defaultLogger } from "../../helpers/logger.ts";
import { currentLifecycleHolder } from "../streaming/lifecycle-admission.ts";
import { isRecoveryPending } from "../streaming/recovery-barrier.ts";

export type BackgroundRecovery =
	| "dead-bearer reconnect"
	| "ready redial"
	| "ready activation";

export interface BackgroundRecoveryLogger {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
}

let log: BackgroundRecoveryLogger = defaultLogger;
const last = new Map<string, string>();

const slot = (recovery: BackgroundRecovery, stableKey: string) =>
	`${recovery}\u0000${stableKey}`;

/**
 * The modem's lease refused this recovery (the background lease for the
 * reconnect and the redial, the journaled mutation lease for a first
 * activation). Names the lifecycle holder and the recovery barrier too, since
 * `streaming_active` and `recovery_pending` say only which gate closed, not
 * who holds it.
 */
export function noteBackgroundLeaseRefused(
	recovery: BackgroundRecovery,
	stableKey: string,
	refusal: ModemMutationRefusal,
): void {
	const reason = `lease refused: ${refusal}`;
	const at = slot(recovery, stableKey);
	if (last.get(at) === reason) return;
	last.set(at, reason);
	log.warn(`modem ${recovery} held back: ${reason}`, {
		stableKey,
		refusal,
		lifecycleHolder: currentLifecycleHolder() ?? "none",
		recoveryPending: isRecoveryPending(),
	});
}

/** A dead path the reconnect will not touch yet, and why. */
export function noteDeadPathHeld(stableKey: string, reason: string): void {
	const at = slot("dead-bearer reconnect", stableKey);
	if (last.get(at) === reason) return;
	last.set(at, reason);
	log.warn(`modem dead-bearer reconnect held back: ${reason}`, { stableKey });
}

/** The recovery got its lease (or its path is no longer held): say so once. */
export function noteBackgroundRecoveryClear(
	recovery: BackgroundRecovery,
	stableKey: string,
): void {
	const at = slot(recovery, stableKey);
	const previous = last.get(at);
	if (previous === undefined) return;
	last.delete(at);
	log.info(`modem ${recovery} no longer held back`, {
		stableKey,
		was: previous,
	});
}

/** Test seam: a recording logger, and a clean slate. */
export function setBackgroundRecoveryLoggerForTest(
	logger: BackgroundRecoveryLogger | undefined,
): void {
	log = logger ?? defaultLogger;
	last.clear();
}
