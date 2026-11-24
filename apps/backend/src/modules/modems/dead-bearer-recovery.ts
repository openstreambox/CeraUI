/*
  RECONNECT A MODEM WHOSE BEARER IS UP BUT CARRIES NOTHING.

  A cellular bearer can stay "connected" in ModemManager and NetworkManager
  while no packet gets through: a stale gateway after a cell change, a carrier
  that stopped routing the session, an MTU or NAT state the network dropped.
  Uplink health notices (device-bound probes to the connectivity-check address
  fail and the link reads `down`), but nothing acted on it: the link stayed
  dead until someone replugged the modem. A NetworkManager down/up of the same
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
    whose native IPv6 still reads `up` is not reconnected, and one whose TUN
    has no record yet is left alone;
  - while a stream runs, the sender's own per-link evidence says this
    interface carries nothing (`linkCarryingState`: its byte counter stood
    still across fresh snapshots, CLAT translator traffic counted for its
    modem). A link that moves stream data is not dead, whatever the probe
    says, and a row's mere presence proves nothing: the sender keeps a row
    for every uplink in its IP list. When the evidence is missing, stale or
    too short ("unknown"), nothing happens;
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
    again under it;
  - right before the `down`, with no await in between: the stream state and
    the stream admission count are still what the reads began with, and the
    lifecycle interlock is free. That background lease is journal-only and does
    not refuse a Stream Start, so a start could otherwise be admitted during
    the owner reads and launch onto a link that goes down a moment later. A
    skip caused by stream activity, or a stream admitted since the outage
    began, restarts the outage hold, at most DEAD_BEARER_MAX_HOLD_RESTARTS
    times per outage; a skip because another modem change holds the
    interlock does neither.

  The interlock is held from just before the `down` until NetworkManager shows
  the device has let go of the connection, at most LINK_TEARDOWN_MAX_HOLD_MS,
  and the link is marked pending (`network/link-teardown-pending.ts`) so the
  bond leaves it out. A Start that arrives meanwhile waits. A teardown that has
  not settled by the bound is re-marked and gets no `up`. Every status poll
  (they can overlap, so it skips links still in flight) re-marks such a link
  while its device reads deactivating, keeps the mark when the device cannot be
  read, and lifts it once the device reads settled or when no profiled modem or
  NM device owns it any more. A startup scan marks a link NetworkManager still
  shows deactivating. The `up` follows
  only onto a free device (disconnected, no active connection), so a profile
  that activated after the `down` is left alone; it is an ordinary background
  dial and not held.

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
	linkTeardownPendingIfnames,
	setLinkTeardownPending,
} from "../network/link-teardown-pending.ts";
import {
	nmConnect,
	nmConnGetFields,
	nmDisconnect,
} from "../network/network-manager.ts";
import type { UplinkHealthRecord } from "../network/uplink-health/model.ts";
import { getUplinkHealthEngine } from "../network/uplink-health/state.ts";
import {
	LINK_TEARDOWN_MAX_HOLD_MS,
	linkTeardownRefusal,
	streamingAdmissionCount,
	tryAcquireLinkTeardown,
} from "../streaming/lifecycle-admission.ts";
import type { LinkCarryingState } from "../streaming/link-progress.ts";
import { linkCarryingState } from "../streaming/link-telemetry.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import { automaticActivationReady } from "./cellular-preparation.ts";
import {
	findModemNmDeviceForConnection,
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
import {
	backgroundModemRefusal,
	withBackgroundModemLease,
} from "./mutation-lease.ts";

export const DEAD_BEARER_HOLD_MS = 60_000;
export const DEAD_BEARER_ALONE_HOLD_MS = 300_000;
export const DEAD_BEARER_STABLE_MS = 300_000;
export const DEAD_BEARER_AFTER_DIAL_MS = 60_000;
export const DEAD_BEARER_MIN_FAILURES = 6;
export const DEAD_BEARER_SPACING_MS = [
	60_000, 120_000, 240_000, 480_000, 900_000,
] as const;
/** Stream activity restarts one outage's hold at most this many times. */
export const DEAD_BEARER_MAX_HOLD_RESTARTS = 3;
/** How often a teardown reads the device while it waits for it to settle. */
export const DEAD_BEARER_SETTLE_POLL_MS = 250;

export interface DeadBearerMemory {
	/** Reconnects since the link last read `up` for DEAD_BEARER_STABLE_MS. */
	readonly reconnects: number;
	readonly lastReconnect?: number;
	readonly upSince?: number;
	/** Monotonic time this module first saw the current outage. */
	readonly downSince?: number;
	/** `streamCycle` when `downSince` was set. */
	readonly cycle?: number;
	/** Times stream activity restarted this outage's hold. */
	readonly holdRestarts?: number;
}

export interface DeadBearerInput {
	/** Monotonic milliseconds. */
	readonly now: number;
	readonly record: UplinkHealthRecord | undefined;
	/** An independent uplink reads `up` with fresh evidence. */
	readonly otherUplinkUp: boolean;
	/** The profile is preparation-owned (autoconnect no + live grant). */
	readonly owned: boolean;
	/** Translated, and the modem's own native IPv6 still reads `up`. */
	readonly nativeAnswers: boolean;
	/**
	 * `idle` when no stream runs; otherwise the sender's verdict on whether
	 * stream data goes out on this interface (`linkCarryingState`).
	 */
	readonly stream: "idle" | LinkCarryingState;
	/** NetworkManager device state code of the modem's profile. */
	readonly nmState: string | undefined;
	/** ModemManager `modem.generic.state`. */
	readonly mmState: string | undefined;
	/** Monotonic time of the last dial or reconnect of this modem. */
	readonly lastDial: number | undefined;
	/** Stream admissions so far (`streamingAdmissionCount`). */
	readonly streamCycle: number;
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
	if (key === "upSince") {
		const { upSince: _dropped, ...rest } = memory;
		return rest;
	}
	const { downSince: _since, cycle: _cycle, ...rest } = memory;
	return rest;
}

/**
 * Restart the outage hold because a stream came, went or was being admitted,
 * unless that already happened DEAD_BEARER_MAX_HOLD_RESTARTS times this
 * outage: a stream flapping at every eligible poll would otherwise keep a dead
 * link dead indefinitely. Past the cap, the protections at the teardown itself
 * (the stream re-check and the interlock) still apply.
 */
export function restartOutageHold(memory: DeadBearerMemory): DeadBearerMemory {
	const restarts = memory.holdRestarts ?? 0;
	if (restarts >= DEAD_BEARER_MAX_HOLD_RESTARTS) return memory;
	return { ...without(memory, "downSince"), holdRestarts: restarts + 1 };
}

/** Pure: what to do about one modem's path this poll. */
export function decideDeadBearer(input: DeadBearerInput): DeadBearerDecision {
	const { now, record } = input;
	let memory = input.memory;
	if (record?.state === "up") {
		const { holdRestarts: _restarts, ...rest } = without(memory, "downSince");
		memory = rest;
		const upSince = memory.upSince ?? now;
		memory =
			now - upSince >= DEAD_BEARER_STABLE_MS
				? { ...memory, reconnects: 0, upSince }
				: { ...memory, upSince };
		return { action: "none", reason: "link up", memory };
	}
	memory = without(memory, "upSince");
	// No outage now: the next one starts with a fresh restart count.
	const none = (reason: string): DeadBearerDecision => {
		const { holdRestarts: _restarts, ...rest } = without(memory, "downSince");
		return { action: "none", reason, memory: rest };
	};
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
	// A stream admitted since the outage began (one that came and went between
	// two polls included) makes the time before it no evidence about the link.
	if (memory.downSince !== undefined && memory.cycle !== input.streamCycle)
		memory = restartOutageHold(memory);
	const downSince = memory.downSince ?? now;
	memory = { ...memory, downSince, cycle: input.streamCycle };
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
	/** The physical modem interface a CLAT TUN translates for, if any. */
	readonly clatParent: (iface: string) => string | undefined;
	/** The TUN of a usable CLAT translation for this modem interface. */
	readonly clatTun: (parent: string) => string | undefined;
	readonly streaming: () => boolean;
	/** The sender's per-link verdict; CLAT translator rows count for the modem. */
	readonly carrying: (iface: string) => LinkCarryingState;
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
	/** The interlock across the `down`; undefined when a stream or transition holds it. */
	readonly holdTeardown: typeof tryAcquireLinkTeardown;
	/** Why the hold was refused: stream activity, or another modem change. */
	readonly teardownRefusal: typeof linkTeardownRefusal;
	readonly streamCycle: typeof streamingAdmissionCount;
	/** The NM device that carries a connection UUID; `null` absent, undefined unreadable. */
	readonly resolveDevice: (uuid: string) => Promise<string | null | undefined>;
	/** NM device state code and active connection; undefined when unreadable. */
	readonly deviceState: (device: string) => Promise<NmDeviceState | undefined>;
	readonly sleep: (ms: number) => Promise<void>;
	readonly markPending: typeof setLinkTeardownPending;
	readonly pendingIfnames: typeof linkTeardownPendingIfnames;
}

export interface NmDeviceState {
	/** `GENERAL.STATE` code: 100 activated, 110 deactivating, 30 disconnected. */
	readonly state: string;
	/** `GENERAL.CON-UUID`, undefined when no connection is active on it. */
	readonly connection: string | undefined;
}

async function readDeviceState(
	device: string,
): Promise<NmDeviceState | undefined> {
	const state = singleDeviceValue(
		await readModemNmDeviceProp(device, "GENERAL.STATE"),
	)?.match(/^(\d+)(?: \([^()\r\n]+\))?$/)?.[1];
	if (state === undefined) return undefined;
	const connection = await readModemNmDeviceProp(device, "GENERAL.CON-UUID");
	if (connection === undefined) return undefined;
	const uuid = connection[0]?.trim();
	return {
		state,
		connection:
			uuid === undefined || uuid === "" || uuid === "--" ? undefined : uuid,
	};
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
	clatParent: (iface) =>
		isClatTunName(iface) ? clatTranslationForTun(iface)?.parent : undefined,
	clatTun: clatTunForParent,
	streaming: getIsStreaming,
	carrying: linkCarryingState,
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
	holdTeardown: tryAcquireLinkTeardown,
	teardownRefusal: linkTeardownRefusal,
	streamCycle: streamingAdmissionCount,
	resolveDevice: findModemNmDeviceForConnection,
	deviceState: readDeviceState,
	sleep: (ms) => Bun.sleep(ms),
	markPending: setLinkTeardownPending,
	pendingIfnames: linkTeardownPendingIfnames,
};

let deps = defaultDeps;
const memories = new Map<string, DeadBearerMemory>();

export function setDeadBearerDepsForTest(
	overrides: Partial<DeadBearerDeps> | null,
): void {
	deps = overrides === null ? defaultDeps : { ...defaultDeps, ...overrides };
	memories.clear();
	pendingSeeded = false;
	teardownsInFlight.clear();
	unsettledTeardowns.clear();
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

function streamState(iface: string): DeadBearerInput["stream"] {
	return deps.streaming() ? deps.carrying(iface) : "idle";
}

function pathObservation(iface: string, key: string) {
	const now = deps.now();
	const wallNow = deps.wallNow();
	const tun = deps.clatTun(iface);
	const native = deps.health(iface);
	const record = tun === undefined ? native : deps.health(tun);
	return {
		now,
		record,
		otherUplinkUp: independentUplinkUp(iface, wallNow),
		nativeAnswers: tun !== undefined && native?.state === "up",
		stream: streamState(iface),
		lastDial: deps.lastDial(key),
	};
}

/** Inputs read fresh; undefined when the modem is not a candidate at all. */
async function readInput(
	id: ModemId,
	key: string,
	memory: DeadBearerMemory,
): Promise<
	{ input: DeadBearerInput; uuid: string; iface: string } | undefined
> {
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
	const iface = modem.ifname;
	const base = {
		...pathObservation(iface, key),
		streamCycle: deps.streamCycle(),
		memory,
	};
	const { record } = base;
	// Only a path that health calls dead needs the owner reads.
	if (!outageRecord(record))
		return {
			uuid,
			iface,
			input: { ...base, owned: true, nmState: undefined, mmState: undefined },
		};
	const owned =
		(await deps.readAutoconnect(uuid))?.trim() === "no" &&
		(await deps.automaticReady(uuid));
	const nmState = owned ? await deps.nmState(uuid) : undefined;
	const mmState = owned ? await deps.mmState(id) : undefined;
	return { uuid, iface, input: { ...base, owned, nmState, mmState } };
}

type TeardownOutcome = "left" | "kept" | "unsettled";

/**
 * Has the device let go of this connection? `left`: NetworkManager shows it
 * disconnected, or carrying another connection. `kept`: the `down` finished
 * and it is still activated with this one. Undefined while it is deactivating
 * or unreadable.
 */
function teardownOutcome(
	state: NmDeviceState | undefined,
	uuid: string,
	atBound: boolean,
): TeardownOutcome | undefined {
	if (state === undefined || state.state === "110") return undefined;
	if (Number(state.state) < 40 || state.connection !== uuid) return "left";
	// Still activated with this connection. An `nmcli` that gave up (exit 3)
	// can leave NetworkManager about to deactivate, so only the bound decides
	// that the `down` did not take.
	return atBound && state.state === "100" ? "kept" : undefined;
}

/**
 * Issue the `down` and wait, while the interlock is held, until NetworkManager
 * shows the device has let go of the connection. `kept` when it still shows
 * this connection activated at LINK_TEARDOWN_MAX_HOLD_MS; `unsettled` when it
 * is deactivating or unreadable then (an `nmcli` that timed out, a stuck
 * device): the caller keeps the link out of the bond.
 */
async function takeDown(
	uuid: string,
	device: string,
): Promise<TeardownOutcome> {
	void deps.disconnect(uuid).catch(() => undefined);
	const started = deps.now();
	for (;;) {
		const atBound = deps.now() - started >= LINK_TEARDOWN_MAX_HOLD_MS;
		const outcome = teardownOutcome(
			await deps.deviceState(device),
			uuid,
			atBound,
		);
		if (outcome !== undefined) return outcome;
		if (atBound) return "unsettled";
		await deps.sleep(DEAD_BEARER_SETTLE_POLL_MS);
	}
}

/**
 * Lift the bond exclusion from links whose teardown has since settled, and on
 * the first call of the process mark any modem link NetworkManager still shows
 * deactivating (a backend that restarted mid-teardown has no memory of it).
 * A link stays excluded while its device reads deactivating or cannot be read.
 */
async function reconcilePendingTeardowns(): Promise<void> {
	// A teardown in flight owns its mark until its own outcome.
	const pending = new Set(
		[...deps.pendingIfnames(), ...unsettledTeardowns].filter(
			(ifname) => !teardownsInFlight.has(ifname),
		),
	);
	const scan = !pendingSeeded;
	pendingSeeded = true;
	if (pending.size === 0 && !scan) return;
	const owned = new Set<string>();
	for (const id of deps.ids()) {
		const modem = getModem(id);
		const uuid = modem?.config?.conn;
		if (!modem?.ifname || !uuid) continue;
		owned.add(modem.ifname);
		const ifname = modem.ifname;
		const watched = pending.has(ifname);
		if (!watched && !scan) continue;
		const device = await deps.resolveDevice(uuid);
		// Unreadable proves nothing: a watched link stays as it is.
		if (device === undefined) continue;
		const state = device === null ? null : await deps.deviceState(device);
		if (state === undefined) continue;
		if (state?.state === "110") {
			// Deactivating, also after a poll that lifted the mark: (re-)mark it.
			if (!deps.pendingIfnames().includes(ifname)) {
				deps.markPending([ifname], true);
				logger.warn("modem link found deactivating; kept out of the bond", {
					id,
					iface: ifname,
				});
			}
			continue;
		}
		// Settled, or no device carries the profile any more.
		if (watched) deps.markPending([ifname], false);
		unsettledTeardowns.delete(ifname);
	}
	// A mark no profiled modem owns (re-enumerated without a profile, or gone)
	// would otherwise exclude that name forever.
	const stale = [...pending].filter((ifname) => !owned.has(ifname));
	if (stale.length > 0) deps.markPending(stale, false);
	for (const ifname of stale) unsettledTeardowns.delete(ifname);
}

let pendingSeeded = false;
/** Interfaces whose teardown is between its mark and its outcome. */
const teardownsInFlight = new Set<string>();
/** Interfaces whose teardown ended unsettled, until a poll reads them settled. */
const unsettledTeardowns = new Set<string>();

/** Seed the bond exclusion from NetworkManager at startup, before the first poll. */
export async function seedPendingTeardowns(): Promise<void> {
	if (pendingSeeded) return;
	await reconcilePendingTeardowns();
}

/**
 * The status poll calls this after its reconcile lock is released. Returns the
 * modems whose data-call warning it raised, for the caller to broadcast.
 */
export async function runDeadBearerRecovery(
	skip: readonly number[] = [],
): Promise<readonly ModemId[]> {
	const changed: ModemId[] = [];
	try {
		await reconcilePendingTeardowns();
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		logger.warn("modem link teardown reconcile did not complete", {
			error: error.message,
		});
	}
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
				if (!fresh || fresh.uuid !== first.uuid || fresh.iface !== first.iface)
					return;
				const device = await deps.resolveDevice(fresh.uuid);
				// The owner reads and the device lookup awaited. Re-sample the
				// sender, link and identity synchronously at the decision that sends
				// NM down. A stream being launched or forwarded is left to the
				// teardown hold below, which refuses then and treats it as stream
				// activity.
				const row = getModem(id);
				const refusal = backgroundModemRefusal(key);
				if (
					row?.ifname !== fresh.iface ||
					row.config?.conn !== fresh.uuid ||
					row.inhibit ||
					row.is_scanning ||
					deps.stableKey(id) !== key ||
					(refusal !== undefined && refusal !== "streaming_active")
				)
					return;
				// The reads above awaited, and the background lease does not refuse
				// a Stream Start. From here to the `down` nothing awaits, so these
				// checks, the interlock and the bond exclusion see the state the
				// `down` meets.
				const ifname = fresh.iface;
				const observed = pathObservation(ifname, key);
				const streamNow = observed.stream;
				const streamChanged =
					streamNow !== fresh.input.stream ||
					deps.streamCycle() !== fresh.input.streamCycle;
				const skipped = (message: string) => {
					const memory = restartOutageHold(fresh.input.memory);
					memories.set(key, memory);
					logger.info(message, {
						id,
						stableKey: key,
						was: fresh.input.stream,
						now: streamNow,
						holdRestarts: memory.holdRestarts,
					});
				};
				const again = decideDeadBearer({ ...fresh.input, ...observed });
				if (again.action !== "reconnect") {
					// A stream that went live with unknown traffic still vetoes the
					// `down`, but it is stream activity, not the end of the outage: it
					// restarts the hold within the cap instead of clearing it.
					if (
						streamChanged &&
						decideDeadBearer({
							...fresh.input,
							...observed,
							stream: fresh.input.stream,
						}).action === "reconnect"
					) {
						skipped("modem reconnect skipped: the stream changed");
						return;
					}
					// Saved also when the device lookup failed, so an outage that ended
					// during the reads does not keep its age.
					if (refusal === undefined) memories.set(key, again.memory);
					return;
				}
				if (streamChanged) {
					skipped("modem reconnect skipped: the stream changed");
					return;
				}
				if (device == null) {
					logger.info("modem reconnect skipped: its device is not resolved", {
						id,
						stableKey: key,
					});
					return;
				}
				const teardown = deps.holdTeardown(LINK_TEARDOWN_MAX_HOLD_MS);
				if (teardown === undefined) {
					// Only stream activity restarts the hold; another modem's change
					// says nothing about this link.
					if (deps.teardownRefusal() === "transition") {
						logger.info(
							"modem reconnect skipped: another modem change holds the link set",
							{ id, stableKey: key },
						);
						return;
					}
					skipped("modem reconnect skipped: a stream holds the link set");
					return;
				}
				teardownsInFlight.add(ifname);
				deps.markPending([ifname], true);
				let outcome: TeardownOutcome = "unsettled";
				try {
					memories.set(key, again.memory);
					deps.noteDial(key);
					logger.warn("modem bearer carries no traffic; reconnecting", {
						id,
						stableKey: key,
						iface: fresh.iface,
						reason: again.reason,
						attempt: again.memory.reconnects,
						nextSpacingS: deadBearerSpacing(again.memory.reconnects - 1) / 1000,
					});
					outcome = await takeDown(fresh.uuid, device);
				} finally {
					// Re-marked when unsettled: nothing else may have lifted it.
					deps.markPending([ifname], outcome === "unsettled");
					if (outcome === "unsettled") unsettledTeardowns.add(ifname);
					else unsettledTeardowns.delete(ifname);
					teardownsInFlight.delete(ifname);
					teardown.release();
				}
				if (outcome === "unsettled") {
					logger.warn(
						"modem link deactivation did not settle; kept out of the bond",
						{ id, stableKey: key, iface: ifname },
					);
					return;
				}
				if (outcome === "kept") {
					logger.warn("modem link stayed connected after the down", {
						id,
						stableKey: key,
					});
					return;
				}
				// Bring the profile back only onto a free device: another profile
				// that activated after the down may already be carrying a stream.
				const free = await deps.deviceState(device);
				if (free?.state !== "30" || free.connection !== undefined) {
					logger.info("modem reconnect left the device to its new state", {
						id,
						stableKey: key,
						state: free?.state,
					});
					return;
				}
				const result = await deps.connect(fresh.uuid, 45);
				logger.info("modem bearer reconnect finished", {
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
			logger.warn("dead-bearer check did not complete", {
				id,
				error: error.message,
			});
		}
	}
	return changed;
}
