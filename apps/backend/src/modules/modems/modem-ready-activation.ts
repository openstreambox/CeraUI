import { logger } from "../../helpers/logger.ts";
import { getNetworkInterfaces } from "../network/network-interfaces.ts";
import { nmConnect, nmConnGetFields } from "../network/network-manager.ts";
import { automaticActivationReady } from "./cellular-preparation.ts";
import { SIM_SWAP_JOURNAL_FORMAT } from "./gsm-sim-swap.ts";
import {
	readModemNmDeviceProp,
	resolveModemNmDeviceForConnection,
} from "./modem-nm-device.ts";
import {
	type ModemId,
	readModemRegistrationState,
	readReadyModemSim,
	resolveLateModemConfig,
	settleModemSimSwap,
} from "./modem-registration.ts";
import { getModem, getModemIds, setModem } from "./modems-state.ts";
import { modemStableKeyForId } from "./mutation-identity.ts";
import {
	withBackgroundModemLease,
	withJournaledModemMutation,
	withModemMutation,
} from "./mutation-lease.ts";

interface ActivationIntent {
	state: "pending" | "consumed";
	/** Park and re-arm (gsm-sim-swap.ts) ran for this registration. */
	swapSettled: boolean;
	simReadable: boolean;
	lateConfigPending: boolean;
	lateConfigRunning: boolean;
}

export interface ModemReadyActivationDeps {
	readonly now: () => number;
	readonly stableKey: typeof modemStableKeyForId;
	readonly readRegistration: typeof readModemRegistrationState;
	readonly resolveDevice: typeof resolveModemNmDeviceForConnection;
	readonly readDevice: typeof readModemNmDeviceProp;
	readonly readAutoconnect: (uuid: string) => Promise<string | undefined>;
	readonly readProfileSimId: (uuid: string) => Promise<string | undefined>;
	readonly automaticReady: typeof automaticActivationReady;
	readonly connect: typeof nmConnect;
	readonly mutate: typeof withModemMutation;
	/** The takeover's lease: it replaces an active bearer, so it is journaled. */
	readonly journaled: typeof withJournaledModemMutation;
	readonly settleSwap: typeof settleModemSimSwap;
	/** The redial's lease: same-modem exclusion that never refuses a Stream Start. */
	readonly backgroundMutate: typeof withBackgroundModemLease;
	readonly readSim: typeof readReadyModemSim;
	readonly resolveConfig: typeof resolveLateModemConfig;
}

const defaultDeps: ModemReadyActivationDeps = {
	now: () => performance.now(),
	stableKey: modemStableKeyForId,
	readRegistration: readModemRegistrationState,
	resolveDevice: resolveModemNmDeviceForConnection,
	readDevice: readModemNmDeviceProp,
	readAutoconnect: async (uuid) =>
		(await nmConnGetFields(uuid, ["connection.autoconnect"] as const))?.[0],
	readProfileSimId: async (uuid) =>
		(await nmConnGetFields(uuid, ["gsm.sim-id"] as const))?.[0],
	automaticReady: automaticActivationReady,
	connect: nmConnect,
	mutate: withModemMutation,
	journaled: withJournaledModemMutation,
	settleSwap: settleModemSimSwap,
	backgroundMutate: withBackgroundModemLease,
	readSim: readReadyModemSim,
	resolveConfig: resolveLateModemConfig,
};

let deps = defaultDeps;
const intents = new Map<ModemId, ActivationIntent>();
// Physical identities outlive MM indices and authoritative remove/re-add edges.
const lastDispatch = new Map<string, number>();
const COOLDOWN_MS = 300_000;

/*
  REDIAL A PREPARED AUTOMATIC PROFILE AFTER IT DROPS.

  Automatic carrier profiles are demoted to `connection.autoconnect=no` by
  cellular preparation, so NetworkManager never brings them back by itself.
  The one-shot intent above dials them once per ModemManager object; without
  this, a bearer that drops later (cell loss, network detach, a settings save
  that reactivated it) stayed down until the modem re-enumerated or the
  backend restarted.

  Only profiles that preparation owns qualify: autoconnect is "no" AND the
  preparation grant still matches this SIM, modem and USB generation. Manual
  profiles keep NetworkManager's own autoconnect and retry handling.

  - The device must read NetworkManager state 30 (disconnected) with the modem
    registered on two polls at least REDIAL_DWELL_MS apart, so a transient
    state between NetworkManager's own steps never triggers a dial.
  - Dials per physical modem are spaced 30, 60, 120, 240, then 300 s apart,
    counted from the last dial of any kind (the first-activation cooldown uses
    the same clock). After REDIAL_TAIL_AFTER dials without a lasting
    connection the spacing becomes REDIAL_TAIL_MS (30 min): a SIM whose plan
    has lapsed or whose APN is wrong is not dialled every five minutes forever.
    The spacing resets once the link has stayed connected for REDIAL_STABLE_MS.
  - ModemManager may still report a stale bearer as `connected` after
    NetworkManager tore the device down; that counts like `registered`.
  - Each dial runs under the modem's background lease
    (`withBackgroundModemLease`), rechecked after it is taken: it excludes
    other mutations of this modem but never refuses a Stream Start, and it
    does not begin while a stream is being launched.
  - A failed dial raises the modem's data-call warning once; repeated failures
    do not re-broadcast it.
*/
const REDIAL_DELAYS_MS = [30_000, 60_000, 120_000, 240_000, 300_000] as const;
const REDIAL_TAIL_AFTER = 5;
const REDIAL_TAIL_MS = 1_800_000;
const REDIAL_DWELL_MS = 20_000;
const REDIAL_STABLE_MS = 300_000;

interface RedialState {
	/** Dials since the link last stayed connected for REDIAL_STABLE_MS. */
	failures: number;
	disconnectedSince?: number;
	connectedSince?: number;
}
const redials = new Map<string, RedialState>();

export function setModemReadyActivationDepsForTest(
	overrides: Partial<ModemReadyActivationDeps> | null,
): void {
	deps = overrides === null ? defaultDeps : { ...defaultDeps, ...overrides };
	intents.clear();
	lastDispatch.clear();
	redials.clear();
}

/**
 * The shared per-modem clock for dials and reconnects (first activation,
 * redial, dead-bearer reconnect), in this module's monotonic time base.
 */
export function lastModemDialAt(key: string): number | undefined {
	return lastDispatch.get(key);
}
export function noteModemDial(key: string): void {
	lastDispatch.set(key, deps.now());
}
export function modemDialClock(): number {
	return deps.now();
}

/** Called only after a genuinely new registry entry has been installed. */
export function armModemReadyActivation(id: ModemId): void {
	intents.set(id, {
		state: "pending",
		swapSettled: false,
		simReadable: false,
		lateConfigPending: false,
		lateConfigRunning: false,
	});
}

export function forgetModemReadyActivation(id: ModemId): void {
	intents.delete(id);
}

function isPending(id: ModemId, intent: ActivationIntent): boolean {
	return intents.get(id) === intent && intent.state === "pending";
}

async function resolveMissingConfig(
	id: ModemId,
	intent: ActivationIntent,
): Promise<boolean> {
	const modem = getModem(id);
	if (
		!modem ||
		modem.config !== undefined ||
		modem.inhibit ||
		modem.is_scanning ||
		intent.lateConfigRunning
	)
		return false;

	// Claim before the first await: overlapping polls share this readable edge.
	intent.lateConfigRunning = true;
	try {
		const sim = await deps.readSim(id);
		if (!isPending(id, intent)) return false;
		if (sim === undefined) return false;
		if (sim === "unreadable") {
			intent.simReadable = false;
			return false;
		}
		if (!intent.simReadable) intent.lateConfigPending = true;
		intent.simReadable = true;
		if (!intent.lateConfigPending) return false;
		const key = deps.stableKey(id);
		if (!key) return false;
		const current = (): boolean =>
			isPending(id, intent) &&
			deps.stableKey(id) === key &&
			getModem(id)?.config === undefined &&
			getModem(id)?.inhibit !== true &&
			getModem(id)?.is_scanning !== true;
		const result = await deps.resolveConfig(id, key, sim, current);
		if (!isPending(id, intent)) return false;
		intent.lateConfigPending = result === "pending";
		return result === "resolved";
	} finally {
		intent.lateConfigRunning = false;
	}
}

/**
 * NM success is terminal even while MM still reports connected/searching.
 * Accept only a whole numeric state, optionally followed by nmcli's label.
 */
async function readReadiness(
	id: ModemId,
	intent: ActivationIntent,
	uuid: string,
): Promise<"connected" | "ready" | "takeover" | undefined> {
	const device = await deps.resolveDevice(uuid);
	if (device === undefined) return undefined;
	const fields = await deps.readDevice(device, "GENERAL.STATE");
	const raw = singleDeviceValue(fields);
	const code = raw?.match(/^(\d+)(?: \([^()\r\n]+\))?$/)?.[1];
	if (!isPending(id, intent) || getModem(id)?.config?.conn !== uuid)
		return undefined;
	let takeover = false;
	if (code === "100") {
		takeover = await carriesAnotherSim(id, device, uuid);
		if (!isPending(id, intent) || getModem(id)?.config?.conn !== uuid)
			return undefined;
		if (!takeover) {
			intent.state = "consumed";
			return "connected";
		}
	} else if (code !== "30") return undefined;
	const registration = await deps.readRegistration(id);
	// The bearer another SIM's profile holds makes ModemManager say connected.
	if (
		registration !== "registered" &&
		!(takeover && registration === "connected")
	)
		return undefined;
	if (
		(await deps.readAutoconnect(uuid))?.trim() !== "yes" &&
		!(await deps.automaticReady(uuid))
	)
		return undefined;
	const modem = getModem(id);
	return isPending(id, intent) &&
		modem?.config?.conn === uuid &&
		!modem.inhibit &&
		!modem.is_scanning
		? takeover
			? "takeover"
			: "ready"
		: undefined;
}

/**
 * Is the device up on a profile bound to a SIM other than the modem's own?
 *
 * NetworkManager can bring up another SIM's profile while the modem has not
 * reported its SIM yet (gsm-sim-swap.ts). Only positive evidence counts: the
 * active profile is not ours, names a SIM id, and that id differs from the
 * modem's ICCID. A profile without a SIM id, the same SIM, or a read that
 * failed leaves the connection alone, as before.
 */
async function carriesAnotherSim(
	id: ModemId,
	device: string,
	uuid: string,
): Promise<boolean> {
	const active = singleDeviceValue(
		await deps.readDevice(device, "GENERAL.CON-UUID"),
	)?.toLowerCase();
	if (!active || active === uuid.toLowerCase()) return false;
	const iccid = getModem(id)?.iccid?.trim();
	if (!iccid) return false;
	const activeSim = (await deps.readProfileSimId(active))?.trim();
	if (!activeSim || activeSim === iccid) return false;
	logger.warn("modem is up on a profile for another SIM; activating its own", {
		module: "modems",
		id,
	});
	return true;
}

function redialDelay(failures: number): number {
	if (failures >= REDIAL_TAIL_AFTER) return REDIAL_TAIL_MS;
	return (
		REDIAL_DELAYS_MS[Math.min(failures, REDIAL_DELAYS_MS.length - 1)] ?? 300_000
	);
}

const registeredForRedial = (state: string | undefined): boolean =>
	state === "registered" || state === "connected";

/**
 * The one value a device property read returned. The reader drops nmcli's
 * single trailing newline; anything other than exactly one entry (a blank
 * record, two values) stays ambiguous.
 */
export function singleDeviceValue(
	fields: readonly string[] | undefined,
): string | undefined {
	return fields?.length === 1 ? fields[0]?.trim() : undefined;
}

/** NetworkManager state code of the profile's device, or undefined. */
async function readDeviceState(uuid: string): Promise<string | undefined> {
	const device = await deps.resolveDevice(uuid);
	if (device === undefined) return undefined;
	const fields = await deps.readDevice(device, "GENERAL.STATE");
	const raw = singleDeviceValue(fields);
	return raw?.match(/^(\d+)(?: \([^()\r\n]+\))?$/)?.[1];
}

function redialEligible(id: ModemId, uuid: string, key: string): boolean {
	const modem = getModem(id);
	const intent = intents.get(id);
	return (
		(intent === undefined || intent.state === "consumed") &&
		deps.stableKey(id) === key &&
		modem?.config?.conn === uuid &&
		!modem.inhibit &&
		!modem.is_scanning
	);
}

/** Prepared automatic profile that has dropped: dial it again, spaced out. */
async function redialAutomaticProfile(
	id: ModemId,
	configured: ModemId[],
): Promise<void> {
	const uuid = getModem(id)?.config?.conn;
	const key = deps.stableKey(id);
	if (!uuid || !key || !redialEligible(id, uuid, key)) return;
	const state: RedialState = redials.get(key) ?? { failures: 0 };
	redials.set(key, state);
	const code = await readDeviceState(uuid);
	const now = deps.now();
	if (code === "100") {
		delete state.disconnectedSince;
		state.connectedSince ??= now;
		if (now - state.connectedSince >= REDIAL_STABLE_MS) state.failures = 0;
		return;
	}
	delete state.connectedSince;
	if (code !== "30") {
		// Activating, deactivating, unavailable or unreadable: not a drop to act on.
		delete state.disconnectedSince;
		return;
	}
	if (!registeredForRedial(await deps.readRegistration(id))) {
		delete state.disconnectedSince;
		return;
	}
	if ((await deps.readAutoconnect(uuid))?.trim() !== "no") return;
	if (!(await deps.automaticReady(uuid))) return;
	if (state.disconnectedSince === undefined) {
		state.disconnectedSince = now;
		return;
	}
	if (now - state.disconnectedSince < REDIAL_DWELL_MS) return;
	const spaced = (): boolean => {
		const previous = lastDispatch.get(key);
		return (
			previous === undefined ||
			deps.now() - previous >= redialDelay(state.failures)
		);
	};
	if (!spaced()) return;
	await deps.backgroundMutate(key, async () => {
		if (!redialEligible(id, uuid, key) || !spaced()) return;
		if ((await readDeviceState(uuid)) !== "30") return;
		if (!registeredForRedial(await deps.readRegistration(id))) return;
		if ((await deps.readAutoconnect(uuid))?.trim() !== "no") return;
		if (!(await deps.automaticReady(uuid))) return;
		if (!redialEligible(id, uuid, key) || !spaced()) return;
		lastDispatch.set(key, deps.now());
		state.failures += 1;
		delete state.disconnectedSince;
		const result = await deps.connect(uuid, 45);
		const currentModem = getModem(id);
		if (
			result === false &&
			deps.stableKey(id) === key &&
			currentModem?.config?.conn === uuid &&
			currentModem.data_connection_failed !== true
		) {
			setModem(id, { ...currentModem, data_connection_failed: true });
			configured.push(id);
		}
		logger.info("automatic profile redial", {
			id,
			stableKey: key,
			result,
			attempt: state.failures,
			nextSpacingS: redialDelay(state.failures) / 1000,
		});
	});
}

/**
 * Replace another SIM's profile on this modem with its own, once per
 * registration. Unlike the plain first activation this replaces an ACTIVE
 * bearer, so it takes the journaled lease (refused while a stream is admitted
 * or forwarded, and while another mutation of this modem runs) and repeats
 * every readiness read under it. There is no restoring the previous profile
 * on failure: once the SIM is known NetworkManager refuses to activate a
 * profile whose SIM id differs. A failed dial is a failed first activation:
 * NetworkManager's own autoconnect (armed profile) or the automatic redial
 * below (prepared profile) brings the link back.
 */
async function takeOver(
	id: ModemId,
	intent: ActivationIntent,
	uuid: string,
	key: string,
	cooledDown: () => boolean,
	configured: ModemId[],
): Promise<void> {
	await deps.journaled(
		key,
		"modem-config",
		{ format: SIM_SWAP_JOURNAL_FORMAT, step: "takeover" },
		async (mutation) => {
			const current = (): boolean =>
				isPending(id, intent) &&
				deps.stableKey(id) === key &&
				getModem(id)?.config?.conn === uuid &&
				cooledDown();
			if (!current()) return { confirmed: true, value: undefined };
			if ((await readReadiness(id, intent, uuid)) !== "takeover" || !current())
				return { confirmed: true, value: undefined };
			await mutation.markExecuting();
			if (!current()) return { confirmed: true, value: undefined };
			// No await between consumption and dispatch; failure never rearms it.
			intent.state = "consumed";
			lastDispatch.set(key, deps.now());
			const result = await deps.connect(uuid, 45);
			const currentModem = getModem(id);
			if (
				result === false &&
				intents.get(id) === intent &&
				deps.stableKey(id) === key &&
				currentModem?.config?.conn === uuid
			) {
				setModem(id, { ...currentModem, data_connection_failed: true });
				configured.push(id);
			}
			logger.info("modem takeover from another SIM's profile", {
				id,
				stableKey: key,
				result,
			});
			return { confirmed: true, value: undefined };
		},
	);
}

/** The retained status poll calls this only AFTER releasing its reconcile lock. */
export async function runModemReadyActivations(
	skip: readonly number[] = [],
): Promise<readonly ModemId[]> {
	const configured: ModemId[] = [];
	for (const id of getModemIds()) {
		if (skip.includes(id)) continue;
		const modem = getModem(id);
		if (
			modem?.data_connection_failed === true &&
			(modem.status?.connection === "connected" ||
				Boolean(getNetworkInterfaces()[modem.ifname]?.ip))
		) {
			const { data_connection_failed: _failure, ...recovered } = modem;
			setModem(id, recovered);
			configured.push(id);
		}
		const intent = intents.get(id);
		if (intent === undefined || !isPending(id, intent)) {
			try {
				await redialAutomaticProfile(id, configured);
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				logger.warn("automatic profile redial did not complete", {
					id,
					error: error.message,
				});
			}
			continue;
		}
		try {
			if (await resolveMissingConfig(id, intent)) configured.push(id);
			const uuid = getModem(id)?.config?.conn;
			if (!uuid) continue;
			const key = deps.stableKey(id);
			if (!key) continue;
			if (!intent.swapSettled) {
				const settled = await deps.settleSwap(
					id,
					key,
					() => isPending(id, intent) && deps.stableKey(id) === key,
				);
				if (settled === "done") intent.swapSettled = true;
			}
			const readiness = await readReadiness(id, intent, uuid);
			if (readiness !== "ready" && readiness !== "takeover") continue;
			const cooledDown = (): boolean => {
				const previous = lastDispatch.get(key);
				return previous === undefined || deps.now() - previous >= COOLDOWN_MS;
			};
			if (!cooledDown()) continue;
			if (readiness === "takeover") {
				await takeOver(id, intent, uuid, key, cooledDown, configured);
				continue;
			}
			await deps.mutate(key, async () => {
				const current = (): boolean =>
					isPending(id, intent) &&
					deps.stableKey(id) === key &&
					getModem(id)?.config?.conn === uuid &&
					cooledDown();
				if (!current()) return;
				if ((await readReadiness(id, intent, uuid)) !== "ready" || !current())
					return;
				// No await between consumption and dispatch; failure never rearms it.
				intent.state = "consumed";
				lastDispatch.set(key, deps.now());
				const result = await deps.connect(uuid, 45);
				const currentModem = getModem(id);
				if (
					result === false &&
					intents.get(id) === intent &&
					deps.stableKey(id) === key &&
					currentModem?.config?.conn === uuid
				) {
					setModem(id, { ...currentModem, data_connection_failed: true });
					configured.push(id);
				}
				logger.info("modem ready activation", { id, stableKey: key, result });
			});
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			logger.warn("modem readiness poll did not complete", {
				id,
				error: error.message,
			});
		}
	}
	return configured;
}
