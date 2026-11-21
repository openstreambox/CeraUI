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
import { bootClock } from "../../helpers/boot-clock.ts";
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
	sha256Hex,
} from "./network-checkpoint.ts";
import { nmCheckpointAdapter } from "./network-checkpoint-nm.ts";
import { sessionRouteLookup } from "./network-session-route.ts";

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

let streaming: (() => boolean) | undefined;

let owner: ReturnType<typeof createNetworkChangeOwner> | undefined;

export function getNetworkChangeOwner() {
	if (!owner) {
		// Lazily, so the streaming graph is not loaded by importing this module.
		void import("../streaming/streaming.ts")
			.then((module) => {
				streaming = module.getIsStreaming;
			})
			.catch(() => undefined);
	}
	owner ??= createNetworkChangeOwner({
		now: Date.now,
		// Never replaced by wall time: without it no stamp is written and
		// nobody can confirm (see NetworkChangeDeps.clock).
		clock: bootClock,
		bootId: readBootId,
		nm: nmCheckpointAdapter,
		// No effects outside NetworkManager are wired yet; any plan naming one is
		// refused because it has no recorded undo.
		effects: createEffectRegistry([]),
		journal: createFileJournalStore(networkChangeJournalPath()),
		isStreaming: () => streaming?.() === true,
		log: (message) => logger.warn(`network change safety: ${message}`),
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
		// The browser login and the UI address it used, for the confirm rule.
		// Only hashes of the token leave the socket.
		...(data.isAuthenticated && data.authToken
			? { tokenHash: sha256Hex(data.authToken) }
			: {}),
		...(data.uiOrigin ? { origin: data.uiOrigin } : {}),
		...(data.uiHost ? { host: data.uiHost } : {}),
		...(data.openedClock === undefined
			? {}
			: { openedClock: data.openedClock }),
	};
}

/**
 * The session plus the box's route back to it, for the ask-before prompt. Only
 * a session without arrival evidence gets a route; the route never confirms.
 */
export async function resolveNetworkChangeSession(
	ws: AppWebSocket,
	lookup: (address: string) => Promise<NetworkChangeSession["route"]> = (
		address,
	) => sessionRouteLookup.lookup(address),
): Promise<NetworkChangeSession> {
	const session = networkChangeSession(ws);
	if (session.ingress) return session;
	const address = (ws as { remoteAddress?: unknown }).remoteAddress;
	if (typeof address !== "string") return session;
	const route = await lookup(address).catch(() => undefined);
	return route ? { ...session, route } : session;
}

/**
 * A warning that repeats only when its text changes or after `everyMs`: a
 * damaged journal is read on every tick and every role write, and logging each
 * of those would be thousands of identical lines a day.
 */
export function createRateLimitedWarn(
	warn: (message: string) => void,
	options: {
		readonly now?: () => number;
		readonly everyMs?: number;
		/** Classes remembered at once; the oldest is forgotten first. */
		readonly maxClasses?: number;
	} = {},
) {
	const now = options.now ?? Date.now;
	const every = options.everyMs ?? 10 * 60_000;
	const maxClasses = options.maxClasses ?? 32;
	// Per class, so alternating failures each keep their own limit.
	const seen = new Map<string, { at: number; suppressed: number }>();
	/** `key` names the failure class; it defaults to the message itself. */
	return (message: string, key: string = message) => {
		const at = now();
		const last = seen.get(key);
		if (last && at - last.at < every) {
			last.suppressed++;
			return;
		}
		const repeats = last?.suppressed
			? ` (repeated ${last.suppressed} times)`
			: "";
		warn(`${message}${repeats}`);
		seen.delete(key);
		seen.set(key, { at, suppressed: 0 });
		if (seen.size > maxClasses) {
			const oldest = seen.keys().next().value;
			if (oldest !== undefined) seen.delete(oldest);
		}
	};
}

/**
 * A stable class for an error: its name and its message with ids, numbers and
 * paths' variable parts masked, so a retry that names a new id or a new time
 * is still the same failure.
 */
export function errorClass(error: unknown): string {
	const name = error instanceof Error ? error.name : "Error";
	const message = error instanceof Error ? error.message : String(error);
	return `${name}:${message.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9]+/gi, "#")}`;
}

const journalWarn = createRateLimitedWarn((message) => logger.warn(message));

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
		readonly warn?: (message: string, key?: string) => void;
	} = {},
): Promise<boolean> {
	const journalExists =
		options.journalExists ?? existsSync(networkChangeJournalPath());
	if (!journalExists) return false;
	try {
		return await (options.owner ?? getNetworkChangeOwner()).touches(ifname);
	} catch (error) {
		// One failure class whatever the port, so eth0 and eth1 reading the
		// same damaged journal don't each log again.
		(options.warn ?? journalWarn)(
			`network change safety: journal unreadable, treating ${ifname} as in flight: ${(error as Error).message}`,
			"journal-unreadable",
		);
		return true;
	}
}

/**
 * The way out of a damaged journal. The owner does the check, the move and the
 * sweep in one serialized operation, so a reset can never move a journal that
 * an apply has just rewritten. Only an unreadable journal is moved aside (kept
 * next to it for support, never deleted).
 */
export async function resetDamagedNetworkChangeJournal(
	options: {
		readonly path?: string;
		readonly owner?: Pick<
			ReturnType<typeof createNetworkChangeOwner>,
			"resetDamagedJournal"
		>;
	} = {},
): Promise<{ readonly movedTo: string }> {
	const path = options.path ?? networkChangeJournalPath();
	if (!existsSync(path)) throw new Error("No network-change journal");
	const result = await (
		options.owner ?? getNetworkChangeOwner()
	).resetDamagedJournal();
	logger.warn(
		`network change safety: damaged journal moved to ${result.movedTo}`,
	);
	return result;
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
		readonly warn?: (message: string) => void;
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
	// A damaged journal fails every tick the same way: say so once, then again
	// only when the error changes or every ten minutes.
	const warn = createRateLimitedWarn(
		options.warn ?? ((message) => logger.warn(message)),
	);
	const handle = set(() => {
		target.tick().catch((error: unknown) => {
			warn(
				`network change safety: tick failed: ${(error as Error).message}`,
				`tick:${errorClass(error)}`,
			);
		});
	}, TICK_MS);
	return () => clear(handle);
}
