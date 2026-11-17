import { internalCallUnitKey } from "./internal-call-unit.ts";
import {
	acquireCellularControl as acquire,
	type CellularControlAcquireDeps,
	type CellularControlTarget,
	defaultCellularControlAcquireDeps,
	type InternalCellularControl,
} from "./modems.ts";
import { resolveTransportQuirk } from "./transport-policy.ts";

export type {
	CellularControlAcquireDeps,
	CellularControlTarget,
} from "./modems.ts";
export {
	createCellularSystemTransport,
	parseCellularSubscriber,
} from "./modems.ts";
export type CellularControl = Omit<
	InternalCellularControl,
	"readUsbSpeed" | "setUsbSpeed"
>;
/** FM350-specific admission over the existing shared transport facade. */
export async function acquireCellularControl(
	target: CellularControlTarget,
	signal?: AbortSignal,
	deps: CellularControlAcquireDeps = defaultCellularControlAcquireDeps,
): Promise<CellularControl> {
	if (resolveTransportQuirk(target.identity)?.owner !== "internal-call")
		throw new Error("FM350 control transport is not admitted");
	return acquire(target, signal, deps);
}
/** Recovery keeps access when new calls are disabled. It cannot start a call or
 * change transport mode; only the retained context's inverse is admitted.
 */
export async function acquireCellularInverseControl(
	target: CellularControlTarget,
	authority: import("./internal-call-authority.ts").InternalCallAuthority,
): Promise<CellularControl> {
	const { isRecoveryPending } = await import(
		"../streaming/recovery-barrier.ts"
	);
	if (
		!isRecoveryPending() ||
		target.key !== authority.stableKey ||
		internalCallUnitKey(target.equipment) !== authority.unit ||
		target.ifindex !== authority.physical.ifindex ||
		target.generation !== authority.physical.generation ||
		target.usbDevice !== authority.physical.usbDevice ||
		target.netDevice !== authority.physical.netDevice ||
		target.ifname !== authority.physical.ifname ||
		JSON.stringify(target.identity) !== JSON.stringify(authority.identity)
	)
		throw new Error("Internal inverse authority is unavailable");
	const control = await acquireCellularControl(target, undefined, {
		...defaultCellularControlAcquireDeps,
		enabled: () => isRecoveryPending(),
		scopeCurrent: () => isRecoveryPending(),
	});
	const refuse = async (): Promise<never> => {
		throw new Error("Recovery cannot start an internal call");
	};
	return {
		...control,
		newCallAllowed: () => false,
		reset: refuse,
		disableAutoConnect: refuse,
		activateContext: async (cid, active) => {
			if (active || cid !== authority.cid || !isRecoveryPending())
				return refuse();
			await control.activateContext(cid, false);
		},
		defineContext: async (cid, apn, family, settings) => {
			if (cid !== authority.cid || !isRecoveryPending()) return refuse();
			await control.defineContext(cid, apn, family, settings);
		},
	};
}
