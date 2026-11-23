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
 * The status poll runs the data-session reconnect (dead-bearer recovery), the
 * ready redial and the first ready activation every few seconds. All three
 * stayed silent when they were held back: a refused lease or a dead path the
 * reconnect would not touch left no trace, so a modem that never came back
 * could not be told apart from one whose recovery was blocked.
 *
 * Transitions, per modem (stable key) and recovery kind:
 *   - held back (warn, once per distinct cause): "lease refused" with the
 *     refusal code, the lifecycle holder and whether the recovery barrier is
 *     up; or, for the reconnect only, "dead path left alone" with the decision
 *     reduced to a fixed code;
 *   - no longer held back (info, once): the recovery got its lease, the path
 *     is up again or only waits out its hold, or the redial found the profile
 *     connected again;
 *   - forgotten (silent): the modem left the roster, so a new attachment on the
 *     same port starts afresh.
 * Messages are fixed text and every field a bounded value, so the support
 * bundle keeps them (`support-log-filter.ts`), and no message names the
 * bearer, which the logger's credential rule would redact.
 */
import type { ModemMutationRefusal } from "@ceraui/rpc/schemas";

import { logger as defaultLogger } from "../../helpers/logger.ts";
import { currentLifecycleHolder } from "../streaming/lifecycle-admission.ts";
import { isRecoveryPending } from "../streaming/recovery-barrier.ts";
import type {
	BackgroundRecovery,
	DeadPathHeld,
} from "./background-recovery-codes.ts";

export type { BackgroundRecovery } from "./background-recovery-codes.ts";

export interface BackgroundRecoveryLogger {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
}

let log: BackgroundRecoveryLogger = defaultLogger;
/** The cause last logged per modem and recovery kind. */
const held = new Map<string, string>();

const slot = (recovery: BackgroundRecovery, stableKey: string) =>
	`${recovery}\u0000${stableKey}`;

/** The decision texts of `decideDeadBearer` as fixed codes. */
const DEAD_PATH_CODES: Readonly<Record<string, DeadPathHeld>> = {
	"profile not owned by preparation": "profile_not_owned",
	"native path answers": "native_path_answers",
	"carrying stream traffic": "carrying_stream_traffic",
	"stream traffic on this link unknown": "stream_traffic_unknown",
	"bearer not connected": "session_not_connected",
	"modem not registered": "modem_not_registered",
};

export function deadPathCode(reason: string): DeadPathHeld {
	return DEAD_PATH_CODES[reason] ?? "other";
}

/**
 * The modem's lease refused this recovery: the background lease for the
 * reconnect and the redial, the ordinary mutation lease for a first
 * activation. A change of holder or barrier with the same code is a new cause.
 */
export function noteBackgroundLeaseRefused(
	recovery: BackgroundRecovery,
	stableKey: string,
	refusal: ModemMutationRefusal,
): void {
	const lifecycleHolder = currentLifecycleHolder() ?? "none";
	const recoveryPending = isRecoveryPending();
	const cause = `lease:${refusal}:${lifecycleHolder}:${recoveryPending}`;
	const at = slot(recovery, stableKey);
	if (held.get(at) === cause) return;
	held.set(at, cause);
	log.warn("modem recovery held back: lease refused", {
		recovery,
		stableKey,
		refusal,
		lifecycleHolder,
		recoveryPending,
	});
}

/** A dead path the data-session reconnect will not touch, and why. */
export function noteDeadPathHeld(stableKey: string, decision: string): void {
	const deadPath = deadPathCode(decision);
	const at = slot("data_session_reconnect", stableKey);
	const cause = `dead:${deadPath}`;
	if (held.get(at) === cause) return;
	held.set(at, cause);
	log.warn("modem recovery held back: dead path left alone", {
		recovery: "data_session_reconnect",
		stableKey,
		deadPath,
	});
}

/** The recovery may act again, or no longer needs to: say so once. */
export function noteBackgroundRecoveryClear(
	recovery: BackgroundRecovery,
	stableKey: string,
): void {
	const at = slot(recovery, stableKey);
	if (!held.has(at)) return;
	held.delete(at);
	log.info("modem recovery no longer held back", { recovery, stableKey });
}

/** Silently drop modems no longer on the roster (detached or replaced). */
export function forgetDetachedRecoveries(
	recovery: BackgroundRecovery,
	attached: Iterable<string>,
): void {
	const live = new Set([...attached].map((key) => slot(recovery, key)));
	const prefix = `${recovery}\u0000`;
	for (const at of [...held.keys()])
		if (at.startsWith(prefix) && !live.has(at)) held.delete(at);
}

/** Test seam: a recording logger, and a clean slate. */
export function setBackgroundRecoveryLoggerForTest(
	logger: BackgroundRecoveryLogger | undefined,
): void {
	log = logger ?? defaultLogger;
	held.clear();
}
