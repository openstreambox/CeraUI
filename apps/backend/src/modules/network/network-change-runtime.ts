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
  The one network-change owner of this process, and its recovery loop.

  The flag (`CERALIVE_NETWORK_CHANGE_SAFETY=1`) gates NEW protected changes
  only. Recovery never depends on it: if a journal exists at start, it is
  reconciled and ticked even with the flag off, so turning the flag off while
  a change is pending can never leave that change unconfirmed and in place.
*/

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../../helpers/logger.ts";
import type { AppWebSocket } from "../../rpc/types.ts";
import { networkChangeSafetyEnabled } from "./ethernet-role-safety.ts";
import { createEffectRegistry } from "./network-change-effects.ts";
import {
	createFileJournalStore,
	DEFAULT_JOURNAL_PATH,
} from "./network-change-journal.ts";
import {
	createNetworkChangeOwner,
	type NetworkChangeSession,
	type SettledEvent,
} from "./network-checkpoint.ts";
import { nmCheckpointAdapter } from "./network-checkpoint-nm.ts";

/** Same override/dev-fallback shape as the modem mutation journal. */
export function networkChangeJournalPath(
	env: Readonly<Record<string, string | undefined>> = process.env,
	cwd: string = process.cwd(),
): string {
	const override = env.CERALIVE_NETWORK_CHANGE_DIR;
	if (override !== undefined && override !== "")
		return join(override, "journal.json");
	const development =
		env.NODE_ENV === "development" || env.MOCK_MODE === "true";
	return development
		? join(cwd, "network-change", "journal.json")
		: DEFAULT_JOURNAL_PATH;
}

const settledHandlers = new Set<(event: SettledEvent) => void>();

/** Register a handler for settled changes; returns its removal. */
export function onNetworkChangeSettled(
	handler: (event: SettledEvent) => void,
): () => void {
	settledHandlers.add(handler);
	return () => settledHandlers.delete(handler);
}

function readBootId(): Promise<string> {
	return Promise.resolve(
		readFileSync("/proc/sys/kernel/random/boot_id", "ascii").trim(),
	);
}

let owner: ReturnType<typeof createNetworkChangeOwner> | undefined;

export function getNetworkChangeOwner() {
	owner ??= createNetworkChangeOwner({
		now: Date.now,
		bootId: readBootId,
		nm: nmCheckpointAdapter,
		// No effects outside NetworkManager are wired yet; any plan naming one is
		// refused because it has no recorded undo.
		effects: createEffectRegistry([]),
		journal: createFileJournalStore(networkChangeJournalPath()),
		onSettled: (event) => {
			for (const handler of settledHandlers) handler(event);
		},
	});
	return owner;
}

/** The session the owner judges: trusted ingress comes from the front door only. */
export function networkChangeSession(ws: AppWebSocket): NetworkChangeSession {
	const data = ws.data;
	const ingress =
		data.ingressPath && data.ingressPathValid?.() === true
			? data.ingressPath.interface
			: undefined;
	return {
		// A socket without these never confirms: no id equals no creator, and
		// opened-at 0 precedes every apply.
		id: data.sessionId ?? "",
		openedAt: data.openedAt ?? 0,
		authenticated: data.isAuthenticated,
		ingress,
	};
}

/**
 * Whether a protected change in flight names this interface. Without a journal
 * on disk this is false without constructing anything. An unreadable journal
 * counts as in flight: nothing should edit a port whose undo record is unknown.
 */
export async function networkChangeTouches(
	ifname: string,
	options: {
		readonly journalExists?: boolean;
		readonly owner?: Pick<
			ReturnType<typeof createNetworkChangeOwner>,
			"touches"
		>;
	} = {},
): Promise<boolean> {
	const journalExists =
		options.journalExists ?? existsSync(networkChangeJournalPath());
	if (!journalExists) return false;
	try {
		return await (options.owner ?? getNetworkChangeOwner()).touches(ifname);
	} catch (error) {
		logger.warn(
			`network change safety: journal unreadable, treating ${ifname} as in flight: ${(error as Error).message}`,
		);
		return true;
	}
}

export const TICK_MS = 5_000;

function noop(): void {
	// Nothing was started, so there is nothing to stop.
}

/**
 * Reconcile at backend start, then tick: the tick undoes a change whose
 * deadline passed or whose checkpoint vanished (a NetworkManager restart).
 * Returns a stop function. Does nothing with the flag off and no journal.
 */
export async function startNetworkChangeSafety(
	options: {
		readonly enabled?: boolean;
		readonly journalExists?: boolean;
		readonly owner?: Pick<
			ReturnType<typeof createNetworkChangeOwner>,
			"reconcile" | "tick"
		>;
		readonly setInterval?: (fn: () => void, ms: number) => unknown;
		readonly clearInterval?: (handle: unknown) => void;
	} = {},
): Promise<() => void> {
	const enabled = options.enabled ?? networkChangeSafetyEnabled();
	const journalExists =
		options.journalExists ?? existsSync(networkChangeJournalPath());
	if (!enabled && !journalExists) return noop;
	const target = options.owner ?? getNetworkChangeOwner();
	try {
		const result = await target.reconcile("backend-start");
		logger.info(`network change safety: reconcile at start: ${result}`);
	} catch (error) {
		// The tick retries; a pending change is still bounded by NM's own timer.
		logger.warn(
			`network change safety: reconcile at start failed: ${(error as Error).message}`,
		);
	}
	const set = options.setInterval ?? setInterval;
	const clear =
		options.clearInterval ??
		((handle: unknown) => clearInterval(handle as Timer));
	const handle = set(() => {
		target.tick().catch((error: unknown) => {
			logger.warn(
				`network change safety: tick failed: ${(error as Error).message}`,
			);
		});
	}, TICK_MS);
	return () => clear(handle);
}
