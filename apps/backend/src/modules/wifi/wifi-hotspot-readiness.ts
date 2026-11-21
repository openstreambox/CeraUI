/*
  A hotspot Start completes only when the AP's client zone is verified.

  NetworkManager's confirmation commits the AP state as before; the terminal
  Start outcome then waits, outside the adapter lock, for a steering
  verification of exactly that AP: the same interface lifetime, the same
  active profile and no later hotspot operation on the row. Verification that
  predates the confirmation does not count. A Stop, a reconfiguration, a
  replacement under the same name or a newer Start cancels the wait, and
  nothing is published for the superseded Start (the newer operation owns the
  outcome). If the zone is not verified within the deadline the outcome is
  `pending` with the AP left up.
*/
import { getNetworkInterfaceIncarnation } from "../network/network-interfaces.ts";
import {
	hotspotSteeringVerified,
	steeringReadinessGeneration,
} from "../network/uplink-steering/readiness.ts";
import type { WifiInterfaceWithHotspot } from "./wifi-hotspot-types.ts";
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

export type HotspotSteeringFence = {
	readonly apIfname: string;
	readonly incarnation: number | undefined;
	readonly since: number;
	readonly owned: () => boolean;
};

export type HotspotSteeringDeps = {
	readonly reconcile: () => Promise<void>;
	readonly verified: (
		ifname: string,
		incarnation: number | undefined,
		since: number,
	) => boolean;
};

const operationEpochs = new WeakMap<WifiInterfaceWithHotspot, number>();

/** Every hotspot operation on a row (Start, Stop, reconfigure) moves this. */
export function advanceHotspotOperation(row: WifiInterfaceWithHotspot): void {
	operationEpochs.set(row, (operationEpochs.get(row) ?? 0) + 1);
}

/** The exact AP a confirmation (or an already-up Start) has just committed. */
export function captureHotspotSteeringFence(
	row: WifiInterfaceWithHotspot,
	uuid: string,
): HotspotSteeringFence {
	const hotspot = row.hotspot;
	const parent = row.ifname;
	const binding = row.concurrentHotspot;
	const virtualIfname =
		binding?.activeConn === uuid ? binding.ifname : undefined;
	const apIfname = virtualIfname ?? parent;
	const incarnation = getNetworkInterfaceIncarnation(apIfname);
	const epoch = operationEpochs.get(row) ?? 0;
	const lifetimes = [parent, apIfname].map(
		(ifname) =>
			[ifname, wifiRadioIdentity.state.rows.get(ifname)?.lifetime] as const,
	);
	const since = steeringReadinessGeneration();
	const owned = (): boolean =>
		row.hotspot === hotspot &&
		hotspot.conn === uuid &&
		hotspot.transition === undefined &&
		(operationEpochs.get(row) ?? 0) === epoch &&
		row.ifname === parent &&
		(virtualIfname === undefined
			? row.conn === uuid
			: row.concurrentHotspot?.ifname === virtualIfname &&
				row.concurrentHotspot.activeConn === uuid) &&
		getNetworkInterfaceIncarnation(apIfname) === incarnation &&
		lifetimes.every(
			([ifname, lifetime]) =>
				lifetime === undefined ||
				sameRadioLifetime(
					lifetime,
					wifiRadioIdentity.state.rows.get(ifname)?.lifetime,
				),
		);
	return { apIfname, incarnation, since, owned };
}

/** `undefined` means superseded: publish nothing for this Start. */
export async function awaitHotspotSteering(
	fence: HotspotSteeringFence,
	deps: HotspotSteeringDeps,
	clock = {
		now: () => performance.now(),
		wait: (ms: number) => Bun.sleep(ms),
	},
): Promise<HotspotReadinessResult | undefined> {
	const verified = () =>
		deps.verified(fence.apIfname, fence.incarnation, fence.since);
	if (!fence.owned()) return undefined;
	if (verified()) return { success: true };
	const deadline = clock.now() + HOTSPOT_READINESS_TIMEOUT_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, HOTSPOT_READINESS_TIMEOUT_MS);
	});
	try {
		while (clock.now() < deadline) {
			// A failed reconcile is not proof that the AP failed. Try again until
			// the deadline, then leave the authoritative live state pending.
			await Promise.race([deps.reconcile().catch(() => undefined), expired]);
			if (!fence.owned()) return undefined;
			if (verified()) return { success: true };
			if (clock.now() >= deadline) break;
			await Promise.race([
				clock.wait(Math.min(HOTSPOT_READINESS_POLL_MS, deadline - clock.now())),
				expired,
			]);
			if (!fence.owned()) return undefined;
		}
		if (!fence.owned()) return undefined;
		return verified()
			? { success: true }
			: { success: true, pending: true, reason: "steering-readiness-timeout" };
	} finally {
		clearTimeout(timer);
	}
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
};
