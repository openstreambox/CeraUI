/*
  A hotspot Start completes only when the AP's client zone is verified.

  NetworkManager's confirmation commits the AP state as before; the terminal
  Start outcome then waits, outside the adapter lock, for a steering
  verification of exactly that AP. Every Start (an already-up one too), Stop
  and reconfigure takes a new operation ticket on the row, and the wait holds:
  - its own ticket, so a newer operation supersedes it;
  - the registry entry that owned the row, the active profile, the AP
    interface and its lifetime (netif incarnation and radio lifetimes);
  - the exact NetworkManager activation (active connection path and profile
    instance) the confirmation observed, or for an already-up AP the one read
    at entry, rechecked against NetworkManager before the terminal.
  Only a verification that started after the confirmation counts. A Stop, a
  reconfiguration, a replacement under the same name, a same-profile
  reactivation or a newer Start cancels the wait, and nothing is published for
  the cancelled Start (a newer operation owns the outcome). If the zone is not
  verified within the deadline the outcome is `pending` with the AP left up.
*/

import { getNetworkInterfaceIncarnation } from "../network/network-interfaces.ts";
import { nmDeviceProp } from "../network/network-manager.ts";
import {
	readNmProfileInstance,
	sameNmProfileActivation,
} from "../network/network-manager-profile-instance.ts";
import {
	hotspotSteeringVerified,
	steeringReadinessEnabled,
	steeringVerificationMark,
} from "../network/uplink-steering/readiness.ts";
import { getWifiInterfacesByMacAddress } from "./wifi-connections.ts";
import type {
	HotspotActivationInstance,
	WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";
import { sameRadioLifetime, wifiRadioIdentity } from "./wifi-radio-identity.ts";

// Readiness can lag activation by several seconds. Allow 20 s after NM confirms,
// with a hard deadline even when an individual reconciliation never resolves.
export const HOTSPOT_READINESS_TIMEOUT_MS = 20_000;
export const HOTSPOT_READINESS_POLL_MS = 500;
/** Extra time a chained mode change allows for the steering wait. */
export const HOTSPOT_READINESS_GRACE_S = 25;

export type HotspotReadinessResult =
	| { success: true }
	| { success: true; pending: true; reason: "steering-readiness-timeout" };

/** One hotspot operation on one row; only the newest ticket is current. */
export type HotspotOperationTicket = {
	readonly row: WifiInterfaceWithHotspot;
	readonly epoch: number;
};

export type HotspotSteeringFence = {
	readonly apIfname: string;
	readonly uuid: string;
	readonly incarnation: number | undefined;
	readonly since: number;
	/** The exact NM activation the confirmation observed, when it has one. */
	readonly witness?: HotspotActivationInstance;
	readonly owned: () => boolean;
};

export type HotspotSteeringDeps = {
	readonly reconcile: () => Promise<void>;
	readonly verified: (
		ifname: string,
		incarnation: number | undefined,
		since: number,
	) => boolean;
	/** False when the board has no steering: nothing waits. Absent means active. */
	readonly active?: () => boolean;
	/**
	 * The AP's current NM activation, or undefined when NM does not report this
	 * profile active on it. Absent only for injected NM fakes.
	 */
	readonly readActivation?: (
		apIfname: string,
		uuid: string,
	) => Promise<HotspotActivationInstance | undefined>;
};

const operationEpochs = new WeakMap<WifiInterfaceWithHotspot, number>();
const awaitingSteering = new WeakMap<
	WifiInterfaceWithHotspot,
	HotspotSteeringFence
>();

/** Every hotspot operation on a row (Start, Stop, reconfigure) takes a ticket. */
export function advanceHotspotOperation(
	row: WifiInterfaceWithHotspot,
): HotspotOperationTicket {
	const epoch = (operationEpochs.get(row) ?? 0) + 1;
	operationEpochs.set(row, epoch);
	awaitingSteering.delete(row);
	return { row, epoch };
}

/** The row's current operation, without starting a new one. */
export function currentHotspotOperation(
	row: WifiInterfaceWithHotspot,
): HotspotOperationTicket {
	return { row, epoch: operationEpochs.get(row) ?? 0 };
}

export function hotspotOperationCurrent(
	ticket: HotspotOperationTicket,
): boolean {
	return (operationEpochs.get(ticket.row) ?? 0) === ticket.epoch;
}

/** Status: a Start on this row is still waiting for its verified client zone. */
export function hotspotAwaitingSteering(
	row: WifiInterfaceWithHotspot,
): boolean {
	return awaitingSteering.get(row)?.owned() === true;
}

/**
 * The exact AP a confirmation (or an already-up Start) has just committed.
 * Synchronous: `owned()` checks the cached evidence only; the NM activation
 * witness is checked by {@link awaitHotspotSteering}.
 */
export function captureHotspotSteeringFence(
	row: WifiInterfaceWithHotspot,
	uuid: string,
	start: {
		readonly ticket?: HotspotOperationTicket;
		readonly witness?: HotspotActivationInstance;
	} = {},
): HotspotSteeringFence {
	const hotspot = row.hotspot;
	const parent = row.ifname;
	const binding = row.concurrentHotspot;
	const virtualIfname =
		binding?.activeConn === uuid ? binding.ifname : undefined;
	const apIfname = virtualIfname ?? parent;
	let incarnation = getNetworkInterfaceIncarnation(apIfname);
	const ticket = start.ticket ?? currentHotspotOperation(row);
	const registry = getWifiInterfacesByMacAddress();
	const registryKey = Object.keys(registry).find(
		(key) => registry[key] === row,
	);
	const lifetimes = [parent, apIfname].map(
		(ifname) =>
			[ifname, wifiRadioIdentity.state.rows.get(ifname)?.lifetime] as const,
	);
	const since = steeringVerificationMark();
	const ownsActivation = (): boolean =>
		hotspotOperationCurrent(ticket) &&
		registryKey !== undefined &&
		getWifiInterfacesByMacAddress()[registryKey] === row &&
		row.hotspot === hotspot &&
		hotspot.conn === uuid &&
		hotspot.transition === undefined &&
		row.ifname === parent &&
		(virtualIfname === undefined
			? // `conn` also needs the AP's IP; NM's active connection can lead it.
				row.conn === uuid || row.activeConn === uuid
			: row.concurrentHotspot?.ifname === virtualIfname &&
				row.concurrentHotspot.activeConn === uuid) &&
		lifetimes.every(
			([ifname, lifetime]) =>
				lifetime === undefined ||
				sameRadioLifetime(
					lifetime,
					wifiRadioIdentity.state.rows.get(ifname)?.lifetime,
				),
		);
	const owned = (): boolean => {
		if (!ownsActivation()) return false;
		const observed = getNetworkInterfaceIncarnation(apIfname);
		// NM can confirm before the first netif snapshot of the AP. Bind the
		// first observed incarnation, then require it to stay the same.
		incarnation ??= observed;
		return observed === incarnation;
	};
	return {
		apIfname,
		uuid,
		get incarnation() {
			return incarnation;
		},
		since,
		...(start.witness ? { witness: start.witness } : {}),
		owned,
	};
}

/** The exact NM activation this fence holds, or undefined when it has none. */
async function activationWitness(
	fence: HotspotSteeringFence,
	read: NonNullable<HotspotSteeringDeps["readActivation"]>,
): Promise<HotspotActivationInstance | undefined> {
	const witness =
		fence.witness?.activePath && fence.witness.profile
			? fence.witness
			: await read(fence.apIfname, fence.uuid);
	return witness?.activePath && witness.profile ? witness : undefined;
}

/**
 * `undefined` means cancelled: publish nothing for this Start. `commit` runs
 * synchronously with the final recheck, so nothing can intervene.
 */
export async function awaitHotspotSteering(
	fence: HotspotSteeringFence,
	deps: HotspotSteeringDeps,
	clock = {
		now: () => performance.now(),
		wait: (ms: number) => Bun.sleep(ms),
	},
	commit?: (result: HotspotReadinessResult) => void,
): Promise<HotspotReadinessResult | undefined> {
	if (!fence.owned()) return undefined;
	const read = deps.readActivation;
	const witness = read ? await activationWitness(fence, read) : undefined;
	if (read && !witness) return undefined;
	const holds = async (): Promise<boolean> => {
		if (!fence.owned()) return false;
		if (read && witness) {
			const now = await read(fence.apIfname, fence.uuid);
			if (
				!now ||
				now.activePath !== witness.activePath ||
				!sameNmProfileActivation(witness.profile, now.profile)
			)
				return false;
		}
		return fence.owned();
	};
	const verified = () =>
		deps.verified(fence.apIfname, fence.incarnation, fence.since);
	const settle = (
		result: HotspotReadinessResult,
	): HotspotReadinessResult | undefined => {
		if (!fence.owned()) return undefined;
		commit?.(result);
		return result;
	};
	const deadline = clock.now() + HOTSPOT_READINESS_TIMEOUT_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, HOTSPOT_READINESS_TIMEOUT_MS);
	});
	try {
		for (;;) {
			if (!fence.owned()) return undefined;
			if (verified()) {
				if (!(await holds())) return undefined;
				// Verified again after the NM read: the terminal is this proof.
				if (verified()) return settle({ success: true });
			}
			if (clock.now() >= deadline) break;
			// A failed reconcile is not proof that the AP failed. Try again until
			// the deadline, then leave the authoritative live state pending.
			await Promise.race([deps.reconcile().catch(() => undefined), expired]);
			if (!fence.owned()) return undefined;
			if (verified() || clock.now() >= deadline) continue;
			await Promise.race([
				clock.wait(Math.min(HOTSPOT_READINESS_POLL_MS, deadline - clock.now())),
				expired,
			]);
		}
		if (!(await holds())) return undefined;
		return settle(
			verified()
				? { success: true }
				: {
						success: true,
						pending: true,
						reason: "steering-readiness-timeout",
					},
		);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Begin the terminal of a Start whose AP is up: the row shows as awaiting
 * steering from now on. The returned function publishes at once without
 * steering, otherwise once the client zone is verified (or `pending` at the
 * deadline). Nothing is published for a cancelled or superseded Start.
 */
export function beginHotspotStartTerminal(
	row: WifiInterfaceWithHotspot,
	uuid: string,
	start: {
		readonly ticket: HotspotOperationTicket;
		readonly witness?: HotspotActivationInstance;
	},
	steering: HotspotSteeringDeps | undefined,
	/** `waited` is false only for the immediate frame without steering. */
	publish: (result: HotspotReadinessResult, waited: boolean) => void,
	onError: (error: unknown) => void,
	/** Runs once the wait is over, whether or not it published a frame. */
	done: () => void = () => {},
): () => void {
	if (!steering || steering.active?.() === false)
		return () => {
			try {
				if (hotspotOperationCurrent(start.ticket))
					publish({ success: true }, false);
			} finally {
				done();
			}
		};
	const fence = captureHotspotSteeringFence(row, uuid, start);
	if (fence.owned()) awaitingSteering.set(row, fence);
	const release = () => {
		if (awaitingSteering.get(row) === fence) awaitingSteering.delete(row);
	};
	return () => {
		void awaitHotspotSteering(fence, steering, undefined, (result) => {
			release();
			publish(result, true);
		})
			.then(release, (error: unknown) => {
				release();
				onError(error);
			})
			.finally(done);
	};
}

async function readHotspotActivation(
	apIfname: string,
	uuid: string,
): Promise<HotspotActivationInstance | undefined> {
	const state = await nmDeviceProp(
		apIfname,
		"GENERAL.STATE,GENERAL.CON-UUID,GENERAL.CON-PATH",
	);
	if (
		Number.parseInt(state?.[0] ?? "", 10) !== 100 ||
		state?.[1] !== uuid ||
		!state?.[2]
	)
		return undefined;
	const activePath = state[2];
	const profile = await readNmProfileInstance(uuid);
	const after = await nmDeviceProp(apIfname, "GENERAL.CON-PATH");
	// The profile was read between two equal path reads, so its NM run owns
	// that path (the run proof the activation match expects).
	return after?.[0] === activePath
		? { profile, activePath, activeRunId: profile?.runId }
		: undefined;
}

/** Production steering: reconcile, then read the verified zones. */
export const defaultHotspotSteeringDeps: HotspotSteeringDeps = {
	reconcile: async () => {
		const { requestUplinkSteeringReconcile } = await import(
			"../network/uplink-steering/runtime.ts"
		);
		await requestUplinkSteeringReconcile();
	},
	verified: hotspotSteeringVerified,
	active: steeringReadinessEnabled,
	readActivation: readHotspotActivation,
};
