/*
  RECONNECT A MODEM WHOSE BEARER IS UP BUT CARRIES NOTHING.

  A cellular bearer can stay "connected" in ModemManager and NetworkManager
  while no packet gets through: a stale gateway after a cell change, a carrier
  that stopped routing the session, an MTU or NAT state the network dropped.
  Uplink health notices (device-bound probes to the connectivity-check address
  fail and the link reads `down`; while streaming, a link the sender reads as
  carrying nothing is probed the same way instead of being judged by its
  sender row), but nothing acted on it: the link stayed dead until someone
  replugged the modem. A NetworkManager down/up of the same
  profile is the one action taken here.

  The probe is HTTP to one address, so its failure is weaker evidence than the
  link's own stream traffic. A reconnect is due only when all of these hold:

  - the profile is owned by cellular preparation (autoconnect `no` and a live
    preparation grant): manual profiles stay with NetworkManager, and the
    redial in `modem-ready-activation.ts` brings an owned profile back if the
    reconnect's `up` fails;
  - the modem's health record is `down`, its latest evidence is a failed
    probe, and at least DEAD_BEARER_MIN_FAILURES probes in a row have failed
    since the last success. While the image's CLAT service translates for an
    IPv6-only modem, that record is its `clat<N>` TUN's: an IPv4 stream goes
    out there, and a dead bearer keeps the translator's lease up for minutes,
    so skipping such a modem left it dead for that whole time. Both the TUN
    and the native IPv6 address ride the same bearer, so a translated modem
    whose native IPv6 answered a real probe in the last
    DEAD_BEARER_NATIVE_PROOF_MS is not reconnected (a record that reads `up`
    only from passive evidence, or because no IPv6 check address exists, is
    no such answer), and one whose TUN has no record yet is left alone;
  - while a stream runs, the sender's own per-link evidence says this
    interface carries nothing (`linkCarryingState`: its byte counter stood
    still across fresh snapshots, CLAT translator traffic counted for its
    modem). A link that moves stream data is not dead, whatever the probe
    says, and a row's mere presence proves nothing: the sender keeps a row
    for every uplink in its IP list. When the evidence is missing, stale or
    too short ("unknown"), nothing happens. The verdict counts duplicate
    probes and keepalives as traffic and stays latched through short
    bursts, so what decides is payload (`linkQuietForMs`, single-packet
    trickles ignored): a "carrying" link with no payload for
    DEAD_BEARER_PAYLOAD_QUIET_MS counts as carrying nothing, and the link
    must have sent no payload for the whole outage seen here plus the probe
    streak before it (DEAD_BEARER_QUIET_LEAD_MS); any burst starts the
    outage over.
    That is checked once more under the lease, after every other read and
    with nothing awaited before the teardown, so a link that resumed sending
    while the owner reads ran is left alone;
  - NetworkManager reports the device connected (state 100) and ModemManager
    the modem registered or connected;
  - this module has seen the outage continuously for 60 s while an
    independent uplink (another physical link, not a translator, tunnel or this
    modem) is up, or for 300 s when none is; time is monotonic, never wall
    clock;
  - reconnects of one modem are spaced 60, 120, 240, 480, then 900 s apart and
    no dial or reconnect of it ran in the last 60 s (one clock shared with the
    redial); the spacing resets after five minutes up;
  - the modem's background lease is free (never during replay, on a blocked
    identity, or while a stream is being launched), and everything is read
    again under it.

  A failed `up` raises the modem's data-call warning; the redial picks the
  profile up from NetworkManager state 30. No journal entry is written for
  the down/up: after a crash between the two, first activation and the redial
  both dial the owned profile again.
*/

import { logger } from "../../helpers/logger.ts";
import {
	clatTranslationForTun,
	clatTunForParent,
	isClatTunName,
} from "../network/clat-translation.ts";
import {
	nmConnect,
	nmConnGetFields,
	nmDisconnect,
} from "../network/network-manager.ts";
import type {
	UplinkHealthRecord,
	UplinkProbeEvidence,
} from "../network/uplink-health/model.ts";
import { getUplinkHealthEngine } from "../network/uplink-health/state.ts";
import type { LinkCarryingState } from "../streaming/link-progress.ts";
import {
	linkCarryingState,
	linkQuietForMs,
} from "../streaming/link-telemetry.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import { automaticActivationReady } from "./cellular-preparation.ts";
import {
	readModemNmDeviceProp,
	resolveModemNmDeviceForConnection,
} from "./modem-nm-device.ts";
import {
	lastModemDialAt,
	modemDialClock,
	noteModemDial,
	singleDeviceValue,
} from "./modem-ready-activation.ts";
import {
	type ModemId,
	readModemRegistrationState,
} from "./modem-registration.ts";
import { getModem, getModemIds, setModem } from "./modems-state.ts";
import { modemStableKeyForId } from "./mutation-identity.ts";
import { withBackgroundModemLease } from "./mutation-lease.ts";

export const DEAD_BEARER_HOLD_MS = 60_000;
export const DEAD_BEARER_ALONE_HOLD_MS = 300_000;
export const DEAD_BEARER_STABLE_MS = 300_000;
export const DEAD_BEARER_AFTER_DIAL_MS = 60_000;
export const DEAD_BEARER_MIN_FAILURES = 6;
/** No payload for this long overrides a "carrying" verdict built on trickles. */
export const DEAD_BEARER_PAYLOAD_QUIET_MS = 10_000;
/** How recent a native IPv6 probe success must be to veto a CLAT modem. */
export const DEAD_BEARER_NATIVE_PROOF_MS = 60_000;
/** The probe streak before an outage is first seen: six 5 s health rounds. */
export const DEAD_BEARER_QUIET_LEAD_MS = DEAD_BEARER_MIN_FAILURES * 5_000;
export const DEAD_BEARER_SPACING_MS = [
	60_000, 120_000, 240_000, 480_000, 900_000,
] as const;

export interface DeadBearerMemory {
	/** Reconnects since the link last read `up` for DEAD_BEARER_STABLE_MS. */
	readonly reconnects: number;
	readonly lastReconnect?: number;
	readonly upSince?: number;
	/** Monotonic time this module first saw the current outage. */
	readonly downSince?: number;
}

export interface DeadBearerInput {
	/** Monotonic milliseconds. */
	readonly now: number;
	readonly record: UplinkHealthRecord | undefined;
	/** An independent uplink reads `up` with fresh evidence. */
	readonly otherUplinkUp: boolean;
	/** The profile is preparation-owned (autoconnect no + live grant). */
	readonly owned: boolean;
	/** Translated, and the modem's own native IPv6 answered a recent probe. */
	readonly nativeAnswers: boolean;
	/**
	 * `idle` when no stream runs; otherwise the sender's verdict on whether
	 * stream data goes out on this interface (`linkCarryingState`).
	 */
	readonly stream: "idle" | LinkCarryingState;
	/**
	 * While streaming: milliseconds since stream data last went out on this
	 * interface (`linkQuietForMs`). A `not_carrying` link must have been quiet
	 * for the outage seen so far plus DEAD_BEARER_QUIET_LEAD_MS. Production
	 * always supplies it with `not_carrying` (missing evidence reads
	 * `unknown`); omitted, only the latched verdict is used.
	 */
	readonly quietMs?: number;
	/** NetworkManager device state code of the modem's profile. */
	readonly nmState: string | undefined;
	/** ModemManager `modem.generic.state`. */
	readonly mmState: string | undefined;
	/** Monotonic time of the last dial or reconnect of this modem. */
	readonly lastDial: number | undefined;
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
			Math.min(Math.max(reconnects, 0), DEAD_BEARER_SPACING_MS.length - 1)
		] ?? 900_000
	);
}

function outageRecord(record: UplinkHealthRecord | undefined): boolean {
	return (
		record?.state === "down" &&
		record.reason === "probe_failed" &&
		record.probes.failures >= DEAD_BEARER_MIN_FAILURES
	);
}

function without(
	memory: DeadBearerMemory,
	key: "downSince" | "upSince",
): DeadBearerMemory {
	const { [key]: _dropped, ...rest } = memory;
	return rest;
}

/** No burst on a streamed link since its probe streak began. */
function quietThroughOutage(
	input: Pick<DeadBearerInput, "stream" | "quietMs">,
	outageMs: number,
): boolean {
	if (input.stream !== "not_carrying" || input.quietMs === undefined)
		return true;
	return input.quietMs >= outageMs + DEAD_BEARER_QUIET_LEAD_MS;
}

/** Pure: what to do about one modem's path this poll. */
export function decideDeadBearer(input: DeadBearerInput): DeadBearerDecision {
	const { now, record } = input;
	let memory = input.memory;
	if (record?.state === "up") {
		memory = without(memory, "downSince");
		const upSince = memory.upSince ?? now;
		memory =
			now - upSince >= DEAD_BEARER_STABLE_MS
				? { ...memory, reconnects: 0, upSince }
				: { ...memory, upSince };
		return { action: "none", reason: "link up", memory };
	}
	memory = without(memory, "upSince");
	const none = (reason: string): DeadBearerDecision => ({
		action: "none",
		reason,
		memory: without(memory, "downSince"),
	});
	if (!input.owned) return none("profile not owned by preparation");
	if (input.nativeAnswers) return none("native path answers");
	if (!outageRecord(record)) return none("no failed-probe outage");
	// Only positive evidence of no traffic lets a live link go; "unknown" is
	// not that evidence.
	if (input.stream === "carrying") return none("carrying stream traffic");
	if (input.stream === "unknown")
		return none("stream traffic on this link unknown");
	if (input.nmState !== "100") return none("bearer not connected");
	if (input.mmState !== "registered" && input.mmState !== "connected")
		return none("modem not registered");
	const downSince = memory.downSince ?? now;
	if (!quietThroughOutage(input, now - downSince))
		return none("stream data moved on this link during the outage");
	memory = { ...memory, downSince };
	const hold = input.otherUplinkUp
		? DEAD_BEARER_HOLD_MS
		: DEAD_BEARER_ALONE_HOLD_MS;
	if (now - downSince < hold)
		return { action: "wait", reason: "outage shorter than the hold", memory };
	if (
		input.lastDial !== undefined &&
		now - input.lastDial < DEAD_BEARER_AFTER_DIAL_MS
	)
		return { action: "wait", reason: "dialled recently", memory };
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

export interface DeadBearerDeps {
	/** Monotonic milliseconds, the same base as the shared dial clock. */
	readonly now: () => number;
	readonly ids: () => readonly ModemId[];
	readonly stableKey: typeof modemStableKeyForId;
	readonly health: (iface: string) => UplinkHealthRecord | undefined;
	readonly healthList: () => readonly UplinkHealthRecord[];
	/** The last real probe answer for an interface (not passive evidence). */
	readonly lastProbe: (iface: string) => UplinkProbeEvidence | undefined;
	/** The physical modem interface a CLAT TUN translates for, if any. */
	readonly clatParent: (iface: string) => string | undefined;
	/** The TUN of a usable CLAT translation for this modem interface. */
	readonly clatTun: (parent: string) => string | undefined;
	readonly streaming: () => boolean;
	/** The sender's per-link verdict; CLAT translator rows count for the modem. */
	readonly carrying: (iface: string) => LinkCarryingState;
	/** Milliseconds since stream data last went out (`linkQuietForMs`). */
	readonly quiet: (iface: string) => number | undefined;
	/** Wall clock, only to compare with health record timestamps. */
	readonly wallNow: () => number;
	readonly readAutoconnect: (uuid: string) => Promise<string | undefined>;
	readonly automaticReady: typeof automaticActivationReady;
	readonly nmState: (uuid: string) => Promise<string | undefined>;
	readonly mmState: typeof readModemRegistrationState;
	readonly lastDial: (key: string) => number | undefined;
	readonly noteDial: (key: string) => void;
	readonly disconnect: (uuid: string) => Promise<unknown>;
	readonly connect: (uuid: string, timeout: number) => Promise<boolean>;
	readonly mutate: typeof withBackgroundModemLease;
}

async function readNmState(uuid: string): Promise<string | undefined> {
	const device = await resolveModemNmDeviceForConnection(uuid);
	if (device === undefined) return undefined;
	const raw = singleDeviceValue(
		await readModemNmDeviceProp(device, "GENERAL.STATE"),
	);
	return raw?.match(/^(\d+)(?: \([^()\r\n]+\))?$/)?.[1];
}

const defaultDeps: DeadBearerDeps = {
	now: modemDialClock,
	ids: getModemIds,
	stableKey: modemStableKeyForId,
	health: (iface) => getUplinkHealthEngine().get(iface),
	healthList: () => getUplinkHealthEngine().list(),
	lastProbe: (iface) => getUplinkHealthEngine().lastProbe(iface),
	clatParent: (iface) =>
		isClatTunName(iface) ? clatTranslationForTun(iface)?.parent : undefined,
	clatTun: clatTunForParent,
	streaming: getIsStreaming,
	carrying: linkCarryingState,
	quiet: linkQuietForMs,
	wallNow: Date.now,
	readAutoconnect: async (uuid) =>
		(await nmConnGetFields(uuid, ["connection.autoconnect"] as const))?.[0],
	automaticReady: automaticActivationReady,
	nmState: readNmState,
	mmState: readModemRegistrationState,
	lastDial: lastModemDialAt,
	noteDial: noteModemDial,
	disconnect: nmDisconnect,
	connect: nmConnect,
	mutate: withBackgroundModemLease,
};

let deps = defaultDeps;
const memories = new Map<string, DeadBearerMemory>();

export function setDeadBearerDepsForTest(
	overrides: Partial<DeadBearerDeps> | null,
): void {
	deps = overrides === null ? defaultDeps : { ...defaultDeps, ...overrides };
	memories.clear();
}

/** Another physical uplink is up: not a translator, tunnel or this modem. */
function independentUplinkUp(iface: string, wallNow: number): boolean {
	return deps
		.healthList()
		.some(
			(record) =>
				record.iface !== iface &&
				record.kind !== "other" &&
				!isClatTunName(record.iface) &&
				deps.clatParent(record.iface) === undefined &&
				record.state === "up" &&
				record.staleAt > wallNow,
		);
}

/** The modem's native IPv6 answered a real probe recently. */
function nativeAnswered(iface: string, wallNow: number): boolean {
	const probe = deps.lastProbe(iface);
	return (
		deps.health(iface)?.state === "up" &&
		probe?.outcome === "success" &&
		wallNow - probe.at <= DEAD_BEARER_NATIVE_PROOF_MS
	);
}

function streamState(
	iface: string,
): Pick<DeadBearerInput, "stream" | "quietMs"> {
	if (!deps.streaming()) return { stream: "idle" };
	const stream = deps.carrying(iface);
	if (stream === "unknown") return { stream };
	const quietMs = deps.quiet(iface);
	// Without a quiet span to check, neither verdict is evidence enough.
	if (quietMs === undefined) return { stream: "unknown" };
	// The carrying verdict counts duplicate probes and keepalives as traffic;
	// a link that moved no payload for DEAD_BEARER_PAYLOAD_QUIET_MS carries
	// nothing, whatever that verdict says.
	if (stream === "carrying" && quietMs < DEAD_BEARER_PAYLOAD_QUIET_MS)
		return { stream };
	return { stream: "not_carrying", quietMs };
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
	const wallNow = deps.wallNow();
	const tun = deps.clatTun(modem.ifname);
	const native = deps.health(modem.ifname);
	const record = tun === undefined ? native : deps.health(tun);
	const base = {
		now,
		record,
		otherUplinkUp: independentUplinkUp(modem.ifname, wallNow),
		nativeAnswers: tun !== undefined && nativeAnswered(modem.ifname, wallNow),
		...streamState(modem.ifname),
		lastDial: deps.lastDial(key),
		memory,
	};
	// Only a path that health calls dead needs the owner reads.
	if (!outageRecord(record))
		return {
			uuid,
			input: { ...base, owned: true, nmState: undefined, mmState: undefined },
		};
	const owned =
		(await deps.readAutoconnect(uuid))?.trim() === "no" &&
		(await deps.automaticReady(uuid));
	const nmState = owned ? await deps.nmState(uuid) : undefined;
	const mmState = owned ? await deps.mmState(id) : undefined;
	return { uuid, input: { ...base, owned, nmState, mmState } };
}

/**
 * The status poll calls this after its reconcile lock is released. Returns the
 * modems whose data-call warning it raised, for the caller to broadcast.
 */
export async function runDeadBearerRecovery(
	skip: readonly number[] = [],
): Promise<readonly ModemId[]> {
	const changed: ModemId[] = [];
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
				// The owner reads above awaited: read the stream evidence once
				// more and tear down with nothing awaited in between.
				const iface = getModem(id)?.ifname;
				const outageMs =
					deps.now() - (fresh.input.memory.downSince ?? fresh.input.now);
				const last = iface === undefined ? undefined : streamState(iface);
				if (
					last === undefined ||
					(fresh.input.stream === "idle") !== (last.stream === "idle") ||
					(last.stream !== "idle" &&
						(last.stream !== "not_carrying" ||
							!quietThroughOutage(last, outageMs)))
				) {
					memories.set(key, without(fresh.input.memory, "downSince"));
					logger.info("modem data session reconnect withdrawn", {
						id,
						stableKey: key,
						iface,
						stream: last?.stream,
					});
					return;
				}
				memories.set(key, again.memory);
				deps.noteDial(key);
				logger.warn("modem data session carries no traffic; reconnecting", {
					id,
					stableKey: key,
					iface,
					reason: again.reason,
					attempt: again.memory.reconnects,
					nextSpacingS: deadBearerSpacing(again.memory.reconnects - 1) / 1000,
				});
				await deps.disconnect(fresh.uuid);
				const result = await deps.connect(fresh.uuid, 45);
				logger.info("modem data session reconnect finished", {
					id,
					stableKey: key,
					result,
				});
				const current = getModem(id);
				if (
					result === false &&
					deps.stableKey(id) === key &&
					current?.config?.conn === fresh.uuid &&
					current.data_connection_failed !== true
				) {
					setModem(id, { ...current, data_connection_failed: true });
					changed.push(id);
				}
			});
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			logger.warn("data session check did not complete", {
				id,
				error: error.message,
			});
		}
	}
	return changed;
}
