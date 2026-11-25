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
 * RESTART MODEM: one operator-requested restart of one qualified modem.
 *
 * The models and the expected downtime come from `MODEM_RESTART_MODELS`
 * (`@ceraui/rpc`), which only lists models a bench run qualified. The order of
 * everything below is deliberate:
 *
 * 1. Pure checks first (known modem, the confirmed modem still behind that
 *    index, qualified model, one restart at a time, cooldown), so a doomed
 *    request never contends for the modem's lease.
 * 2. The only-link guard: while a stream runs, a restart of the modem that is
 *    the only connection the sender can use stops the stream from sending until
 *    it is back. That is refused unless the operator confirmed exactly that cost.
 *    Another link counts only when the sender is using it right now (fresh row,
 *    non-zero weight and bitrate) and it is positively a different uplink.
 *    Anything less, including missing telemetry, asks the second time.
 * 3. The restart runs under {@link withModemRestartLease}: same-modem exclusion,
 *    and a whole-subsystem modem transition waits for it, but a Stream Start is
 *    never refused.
 * 4. ModemManager's reset is the only method. If ModemManager refuses it, the
 *    result is `failed` and the operator is told to replug; a timeout or transport
 *    failure may still have delivered the reset, so it is only observed. There is
 *    no second method and no retry loop anywhere in this module. (A USB rebind
 *    also brought both models back on the bench, but it never had to: the reset
 *    was never refused, and as a fallback it raced stream admission and the
 *    device's identity. It stays out until a model needs it.)
 * 5. The modem comes back under a NEW ModemManager index every time (measured on
 *    both models), so it is found again by its `stable_key`, the ID_PATH-derived
 *    key of the USB port it sits on. While waiting, the roster is re-discovered
 *    at each poll, so the row comes back as soon as ModemManager lists the
 *    modem rather than one 30 s status poll later.
 *
 * Nothing is persisted: a restart changes no setting, so there is nothing to
 * roll back, and the cooldown deliberately resets with the backend.
 */

import {
	connectionStatusSchema,
	MODEM_RESTART_COOLDOWN_SECONDS,
	type ModemRestartQualification,
	modemRestartQualification,
	type RestartModemInput,
	type RestartModemOutput,
	type RestartModemRefusal,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { buildLinkTelemetry } from "../streaming/link-telemetry.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import { resolveModemIndex } from "./five-g-apply.ts";
import { discoverModems } from "./modem-update-loop.ts";
import { getModems, type Modem } from "./modems-state.ts";
import { modemStableKeyForId } from "./mutation-identity.ts";
import { withModemRestartLease } from "./mutation-lease.ts";

/**
 * What became of ModemManager's reset (the transport lives with the other
 * ModemManager calls and is injected by the RPC procedure):
 *   accepted  ModemManager confirmed it.
 *   refused   ModemManager answered that it could not reset the modem.
 *   unknown   a timeout, a transport failure or anything else: the reset may
 *             have been delivered, so it is observed.
 */
export type MmResetResult = "accepted" | "refused" | "unknown";

export type ModemRestartDeps = {
	readonly modems: () => Readonly<Record<number, Modem>>;
	readonly stableKeyForId: (id: number) => string | undefined;
	readonly mmReset: (id: number) => Promise<MmResetResult>;
	/** Re-list the modems now, so the roster follows ModemManager. */
	readonly refreshRoster: () => Promise<void>;
	readonly isStreaming: () => boolean;
	/**
	 * Whether the sender is using a link other than `ifname` right now (see
	 * {@link otherBondLinkLiveIn}). `undefined` when there is no telemetry.
	 */
	readonly otherLinkLive: (
		ifname: string,
		otherModemIfnames: readonly string[],
	) => boolean | undefined;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly pollMs: number;
};

/** Kernel names of uplinks that can never be an alias of a cellular modem's link. */
const NON_CELLULAR_UPLINK = /^(?:eth|en|wl|usb)[A-Za-z0-9_.-]*$/;

/**
 * Pure rule behind `otherLinkLive`. A row counts only when its interface is
 * positively a different uplink (another modem's interface or a non-cellular
 * kernel name; never the target, a CLAT alias, an unmappable row, a raw address
 * or a `link-N` placeholder) and the sender is using it NOW: the row is fresh,
 * has a non-zero weight, and reports a non-zero bitrate. Session byte totals are
 * not enough: a timed-out link keeps its historical bytes with zero weight.
 */
export function otherBondLinkLiveIn(
	links: readonly {
		readonly iface: string;
		readonly stale: boolean;
		readonly weight_percent?: number | undefined;
		readonly bitrate_bps?: number | undefined;
		readonly identity_state?: string | undefined;
	}[],
	ifname: string,
	otherModemIfnames: readonly string[],
): boolean {
	return links.some(
		(link) =>
			link.iface !== ifname &&
			!link.stale &&
			link.identity_state !== "unmappable" &&
			!link.iface.startsWith("clat") &&
			(otherModemIfnames.includes(link.iface) ||
				NON_CELLULAR_UPLINK.test(link.iface)) &&
			(link.weight_percent ?? 0) > 0 &&
			(link.bitrate_bps ?? 0) > 0,
	);
}

function otherBondLinkLive(
	ifname: string,
	otherModemIfnames: readonly string[],
): boolean | undefined {
	const telemetry = buildLinkTelemetry();
	if (telemetry === null) return undefined;
	return otherBondLinkLiveIn(telemetry.links, ifname, otherModemIfnames);
}

/** Everything but the reset transport, which the caller supplies. */
export const defaultModemRestartDeps: Omit<ModemRestartDeps, "mmReset"> = {
	modems: getModems,
	stableKeyForId: modemStableKeyForId,
	refreshRoster: discoverModems,
	isStreaming: getIsStreaming,
	otherLinkLive: otherBondLinkLive,
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	pollMs: 3_000,
};

/** The stable key of the modem restarting right now; one at a time, device-wide. */
let restarting: string | undefined;
/** When each modem's last attempt ended, for the cooldown. */
const lastAttemptEnded = new Map<string, number>();

/** Forget the one-at-a-time claim and every cooldown (tests). */
export function resetModemRestartDeps(): void {
	restarting = undefined;
	lastAttemptEnded.clear();
}

function findByStableKey(
	stableKey: string,
	deps: ModemRestartDeps,
): { id: number; modem: Modem } | undefined {
	for (const [key, modem] of Object.entries(deps.modems())) {
		const id = Number(key);
		if (deps.stableKeyForId(id) === stableKey) return { id, modem };
	}
	return undefined;
}

function otherModemIfnames(id: number, deps: ModemRestartDeps): string[] {
	return Object.entries(deps.modems())
		.filter(([key, modem]) => Number(key) !== id && modem.ifname !== "")
		.map(([, modem]) => modem.ifname);
}

/** A connection state from the closed vocabulary, for logs and the result. */
function knownConnection(value: string | undefined): string | undefined {
	return value !== undefined &&
		(connectionStatusSchema.options as readonly string[]).includes(value)
		? value
		: undefined;
}

/** Every refusal goes through here, so each one leaves the same warning line. */
function refuse(
	refusal: RestartModemRefusal,
	context: { family?: string; stableKey?: string } = {},
	extra: { retryAfterSeconds?: number } = {},
): RestartModemOutput {
	logger.warn("modem restart refused", {
		module: "modems",
		restartRefusal: refusal,
		...(context.family ? { restartFamily: context.family } : {}),
		...(context.stableKey ? { stableKey: context.stableKey } : {}),
		...(extra.retryAfterSeconds !== undefined
			? { retryAfterSeconds: extra.retryAfterSeconds }
			: {}),
	});
	return { started: false, refusal, ...extra };
}

export async function restartModem(
	input: RestartModemInput,
	deps: ModemRestartDeps,
): Promise<RestartModemOutput> {
	const id = resolveModemIndex(input.device);
	const modem = id === undefined ? undefined : deps.modems()[id];
	if (id === undefined || modem === undefined) return refuse("unknown_modem");

	const qualification = modemRestartQualification(modem.model);
	if (qualification === undefined) return refuse("not_qualified");
	const family = qualification.family;

	const stableKey = deps.stableKeyForId(id);
	if (!stableKey) return refuse("identity_unresolved", { family });
	const context = { family, stableKey };
	// The index the operator confirmed must still be the modem they confirmed.
	if (stableKey !== input.stableKey) return refuse("unknown_modem", context);

	if (restarting !== undefined) return refuse("restart_in_progress", context);

	const ended = lastAttemptEnded.get(stableKey);
	if (ended !== undefined) {
		const left = Math.ceil(
			(ended + MODEM_RESTART_COOLDOWN_SECONDS * 1000 - deps.now()) / 1000,
		);
		if (left > 0)
			return refuse("cooldown", context, { retryAfterSeconds: left });
	}

	if (
		deps.isStreaming() &&
		deps.otherLinkLive(modem.ifname, otherModemIfnames(id, deps)) !== true &&
		input.onlyLinkConfirmed !== true
	)
		return refuse("only_link_live", context);

	// Claimed synchronously, before the first await, so two requests in the same
	// tick cannot both pass the one-at-a-time check.
	restarting = stableKey;
	try {
		const outcome = await withModemRestartLease(stableKey, () =>
			runRestart(id, stableKey, qualification, deps),
		);
		if (!outcome.ok) return refuse(outcome.refusal, context);
		lastAttemptEnded.set(stableKey, deps.now());
		return outcome.value;
	} finally {
		restarting = undefined;
	}
}

async function runRestart(
	id: number,
	stableKey: string,
	qualification: ModemRestartQualification,
	deps: ModemRestartDeps,
): Promise<RestartModemOutput> {
	const family = qualification.family;
	const startedAt = deps.now();
	const elapsed = () => Math.round((deps.now() - startedAt) / 100) / 10;
	logger.info("modem restart started", {
		module: "modems",
		restartFamily: family,
		stableKey,
		oldDevice: id,
		streaming: deps.isStreaming(),
	});

	const reset = await deps.mmReset(id);
	if (reset === "refused") {
		// Nothing happened to the modem. No second method: the operator replugs.
		const result: RestartModemOutput = {
			started: true,
			outcome: "failed",
			method: "mm-reset",
			elapsedSeconds: elapsed(),
		};
		logModemRestartOutcome(family, stableKey, id, result);
		return result;
	}

	// Wait for the modem to leave and come back on the same port. "Left" is seen
	// as no modem on this key, or the key under a different index; a modem that is
	// still listed under its old index has not restarted yet. The verdict comes
	// from the LAST observation, so a modem that came back and went again is
	// reported as gone.
	let left = false;
	let last: { id: number; modem: Modem } | undefined;
	while (deps.now() - startedAt < qualification.boundSeconds * 1000) {
		await deps.sleep(deps.pollMs);
		await deps.refreshRoster().catch(() => undefined);
		last = findByStableKey(stableKey, deps);
		if (last === undefined || last.id !== id) left = true;
		if (left && last?.modem.status?.connection === "connected") {
			const result: RestartModemOutput = {
				started: true,
				outcome: "back_connected",
				method: "mm-reset",
				elapsedSeconds: elapsed(),
				device: String(last.id),
			};
			logModemRestartOutcome(family, stableKey, id, result);
			return result;
		}
	}
	const connection = knownConnection(last?.modem.status?.connection);
	const result: RestartModemOutput = !left
		? {
				started: true,
				outcome: "unchanged",
				method: "mm-reset",
				elapsedSeconds: elapsed(),
			}
		: last === undefined
			? {
					started: true,
					outcome: "not_back",
					method: "mm-reset",
					elapsedSeconds: elapsed(),
				}
			: {
					started: true,
					outcome: "back_not_connected",
					method: "mm-reset",
					elapsedSeconds: elapsed(),
					device: String(last.id),
					...(connection ? { connection } : {}),
				};
	logModemRestartOutcome(family, stableKey, id, result);
	return result;
}

function logModemRestartOutcome(
	family: string,
	stableKey: string,
	oldId: number,
	result: RestartModemOutput,
): void {
	const meta = {
		module: "modems",
		restartFamily: family,
		stableKey,
		restartMethod: result.method,
		restartOutcome: result.outcome,
		oldDevice: oldId,
		...(result.device !== undefined
			? { newDevice: Number(result.device) }
			: {}),
		...(result.connection !== undefined
			? { connection: result.connection }
			: {}),
		elapsedSeconds: result.elapsedSeconds,
	};
	if (result.outcome === "back_connected")
		logger.info("modem restart finished", meta);
	else logger.warn("modem restart finished without a connection", meta);
}
