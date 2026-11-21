/*
  RECONNECT A MODEM WHOSE BEARER IS UP BUT CARRIES NOTHING.

  A cellular bearer can stay "connected" in ModemManager and NetworkManager
  while no packet gets through: a stale gateway after a cell change, a carrier
  that stopped routing the session, an MTU or NAT state the network dropped.
  Uplink health already notices (device-bound probes to the connectivity-check
  address fail three rounds in a row and the link reads `down`), but nothing
  acted on it: the link stayed in the bond and stayed dead until someone
  replugged the modem. A NetworkManager down/up of the same profile brought
  data back in 4.5–10 s on the bench, so that is the one action taken here.

  When a reconnect is due, all of these must hold:

  - the uplink-health record for the modem's interface is `down` and its
    latest evidence is a failed active probe (`probe_failed`); address loss,
    captive portals and passive congestion are other faults;
  - NetworkManager reports the profile's device connected (state 100) and
    ModemManager reports the modem registered or connected, so this is not a
    bearer that already dropped (redial handles that) or a lost registration;
  - the link has been down for at least 60 s while another uplink is up, which
    shows the check address is reachable and the fault is on this path; with no
    other uplink up the hold is 300 s, because a failed check then may be the
    check address and not the modem;
  - reconnects of one physical modem are spaced 60, 120, 240, 480, then 900 s
    apart; the spacing resets once the link has read `up` for five minutes;
  - the modem is not inhibited, not scanning, not being reset this poll, and
    its mutation lease is free. Everything is read again under the lease.
*/

import { logger } from "../../helpers/logger.ts";
import { nmConnect, nmDisconnect } from "../network/network-manager.ts";
import type { UplinkHealthRecord } from "../network/uplink-health/model.ts";
import { getUplinkHealthEngine } from "../network/uplink-health/state.ts";
import {
	readModemNmDeviceProp,
	resolveModemNmDeviceForConnection,
} from "./modem-nm-device.ts";
import {
	type ModemId,
	readModemRegistrationState,
} from "./modem-registration.ts";
import { getModem, getModemIds } from "./modems-state.ts";
import { modemStableKeyForId } from "./mutation-identity.ts";
import { withModemMutation } from "./mutation-lease.ts";

export const DEAD_BEARER_HOLD_MS = 60_000;
export const DEAD_BEARER_ALONE_HOLD_MS = 300_000;
export const DEAD_BEARER_STABLE_MS = 300_000;
export const DEAD_BEARER_SPACING_MS = [
	60_000, 120_000, 240_000, 480_000, 900_000,
] as const;

export interface DeadBearerMemory {
	/** Reconnects since the link last read `up` for DEAD_BEARER_STABLE_MS. */
	readonly reconnects: number;
	readonly lastReconnect?: number;
	readonly upSince?: number;
}

export interface DeadBearerInput {
	readonly now: number;
	readonly record: UplinkHealthRecord | undefined;
	/** Another uplink reads `up` with fresh evidence. */
	readonly otherUplinkUp: boolean;
	/** NetworkManager device state code of the modem's profile. */
	readonly nmState: string | undefined;
	/** ModemManager `modem.generic.state`. */
	readonly mmState: string | undefined;
	readonly memory: DeadBearerMemory;
}

export interface DeadBearerDecision {
	readonly action: "none" | "wait" | "reconnect";
	readonly reason: string;
	readonly memory: DeadBearerMemory;
}

export function deadBearerSpacing(reconnects: number): number {
	return (
		DEAD_BEARER_SPACING_MS[
			Math.min(reconnects, DEAD_BEARER_SPACING_MS.length - 1)
		] ?? 900_000
	);
}

/** Pure: what to do about one modem's path this poll. */
export function decideDeadBearer(input: DeadBearerInput): DeadBearerDecision {
	const { now, record } = input;
	let memory = input.memory;
	if (record?.state === "up" && record.staleAt > now) {
		const upSince = memory.upSince ?? now;
		memory =
			now - upSince >= DEAD_BEARER_STABLE_MS
				? { reconnects: 0, upSince, ...withLast(memory) }
				: { ...memory, upSince };
		return { action: "none", reason: "link up", memory };
	}
	if (memory.upSince !== undefined) {
		const { upSince: _dropped, ...rest } = memory;
		memory = rest;
	}
	if (record?.state !== "down" || record.reason !== "probe_failed")
		return { action: "none", reason: "no failed-probe outage", memory };
	if (record.staleAt <= now)
		return { action: "none", reason: "health evidence stale", memory };
	if (input.nmState !== "100")
		return { action: "none", reason: "bearer not connected", memory };
	if (input.mmState !== "registered" && input.mmState !== "connected")
		return { action: "none", reason: "modem not registered", memory };
	const hold = input.otherUplinkUp
		? DEAD_BEARER_HOLD_MS
		: DEAD_BEARER_ALONE_HOLD_MS;
	if (now - record.lastTransition < hold)
		return { action: "wait", reason: "outage shorter than the hold", memory };
	if (
		memory.reconnects > 0 &&
		memory.lastReconnect !== undefined &&
		now - memory.lastReconnect < deadBearerSpacing(memory.reconnects - 1)
	)
		return {
			action: "wait",
			reason: "spacing after the last reconnect",
			memory,
		};
	return {
		action: "reconnect",
		reason: input.otherUplinkUp
			? "probes fail on this path while another uplink is up"
			: "probes fail on every path for longer than the alone hold",
		memory: { reconnects: memory.reconnects + 1, lastReconnect: now },
	};
}

function withLast(memory: DeadBearerMemory): { lastReconnect?: number } {
	return memory.lastReconnect === undefined
		? {}
		: { lastReconnect: memory.lastReconnect };
}

export interface DeadBearerDeps {
	readonly now: () => number;
	readonly ids: () => readonly ModemId[];
	readonly stableKey: typeof modemStableKeyForId;
	readonly health: (iface: string) => UplinkHealthRecord | undefined;
	readonly healthList: () => readonly UplinkHealthRecord[];
	readonly nmState: (uuid: string) => Promise<string | undefined>;
	readonly mmState: typeof readModemRegistrationState;
	readonly disconnect: (uuid: string) => Promise<unknown>;
	readonly connect: (uuid: string, timeout: number) => Promise<boolean>;
	readonly mutate: typeof withModemMutation;
}

async function readNmState(uuid: string): Promise<string | undefined> {
	const device = await resolveModemNmDeviceForConnection(uuid);
	if (device === undefined) return undefined;
	const fields = await readModemNmDeviceProp(device, "GENERAL.STATE");
	const raw = fields?.length === 1 ? fields[0]?.trim() : undefined;
	return raw?.match(/^(\d+)(?: \([^()\r\n]+\))?$/)?.[1];
}

const defaultDeps: DeadBearerDeps = {
	now: Date.now,
	ids: getModemIds,
	stableKey: modemStableKeyForId,
	health: (iface) => getUplinkHealthEngine().get(iface),
	healthList: () => getUplinkHealthEngine().list(),
	nmState: readNmState,
	mmState: readModemRegistrationState,
	disconnect: nmDisconnect,
	connect: nmConnect,
	mutate: withModemMutation,
};

let deps = defaultDeps;
const memories = new Map<string, DeadBearerMemory>();

export function setDeadBearerDepsForTest(
	overrides: Partial<DeadBearerDeps> | null,
): void {
	deps = overrides === null ? defaultDeps : { ...defaultDeps, ...overrides };
	memories.clear();
}

function otherUplinkUp(iface: string, now: number): boolean {
	return deps
		.healthList()
		.some(
			(record) =>
				record.iface !== iface && record.state === "up" && record.staleAt > now,
		);
}

/** Inputs read fresh; undefined when the modem is not a candidate at all. */
async function readInput(
	id: ModemId,
	key: string,
	memory: DeadBearerMemory,
): Promise<{ input: DeadBearerInput; uuid: string } | undefined> {
	const modem = getModem(id);
	const uuid = modem?.config?.conn;
	if (
		!modem ||
		!uuid ||
		!modem.ifname ||
		modem.inhibit ||
		modem.is_scanning ||
		deps.stableKey(id) !== key
	)
		return undefined;
	const now = deps.now();
	const record = deps.health(modem.ifname);
	const base = {
		now,
		record,
		otherUplinkUp: otherUplinkUp(modem.ifname, now),
		memory,
	};
	// Only a path that health calls down needs the owner reads.
	if (record?.state !== "down" || record.reason !== "probe_failed")
		return {
			uuid,
			input: { ...base, nmState: undefined, mmState: undefined },
		};
	const nmState = await deps.nmState(uuid);
	const mmState = await deps.mmState(id);
	return { uuid, input: { ...base, nmState, mmState } };
}

/** The status poll calls this after its reconcile lock is released. */
export async function runDeadBearerRecovery(
	skip: readonly number[] = [],
): Promise<readonly ModemId[]> {
	const reconnected: ModemId[] = [];
	for (const id of deps.ids()) {
		if (skip.includes(id)) continue;
		const key = deps.stableKey(id);
		if (!key) continue;
		try {
			const before = memories.get(key) ?? { reconnects: 0 };
			const first = await readInput(id, key, before);
			if (!first) continue;
			const decision = decideDeadBearer(first.input);
			if (decision.action !== "reconnect") {
				memories.set(key, decision.memory);
				continue;
			}
			await deps.mutate(key, async () => {
				// Memory changes only here, so a refused lease leaves it as it was.
				const fresh = await readInput(id, key, memories.get(key) ?? before);
				if (!fresh || fresh.uuid !== first.uuid) return;
				const again = decideDeadBearer(fresh.input);
				if (again.action !== "reconnect") return;
				memories.set(key, again.memory);
				const iface = getModem(id)?.ifname;
				logger.warn("modem bearer carries no traffic; reconnecting", {
					id,
					stableKey: key,
					iface,
					reason: again.reason,
					attempt: again.memory.reconnects,
					nextSpacingS: deadBearerSpacing(again.memory.reconnects - 1) / 1000,
				});
				await deps.disconnect(fresh.uuid);
				const result = await deps.connect(fresh.uuid, 45);
				logger.info("modem bearer reconnect finished", {
					id,
					stableKey: key,
					result,
				});
				reconnected.push(id);
			});
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			logger.warn("dead-bearer check did not complete", {
				id,
				error: error.message,
			});
		}
	}
	return reconnected;
}
