import type { CellularNetworkTarget } from "./modems.ts";
import type { NativeBearerSnapshot } from "./native-bearer.ts";

export interface CellularNetworkObservationDeps {
	readonly target: (
		id: number,
		key: string,
	) => Promise<CellularNetworkTarget | undefined>;
	readonly bearer: (
		id: number,
		iface: string,
		current: () => Promise<boolean>,
	) => Promise<NativeBearerSnapshot | undefined>;
}
/** No carrier-policy or vendor-write capability is inferred from this read. A
 * modem object index and interface name alone never identify a returning path.
 */
export async function observeCellularNativeBearer(
	target: CellularNetworkTarget,
	deps: CellularNetworkObservationDeps,
): Promise<NativeBearerSnapshot | undefined> {
	const current = async () => {
		const next = await deps.target(target.id, target.key);
		return (
			!!next &&
			[
				"id",
				"key",
				"deviceId",
				"simId",
				"subscriber",
				"equipment",
				"ifname",
				"ifindex",
				"usbDevice",
				"netDevice",
				"generation",
			].every(
				(key) =>
					next[key as keyof CellularNetworkTarget] ===
					target[key as keyof CellularNetworkTarget],
			) &&
			next.identity.model === target.identity.model &&
			next.identity.firmware === target.identity.firmware &&
			next.identity.mode === target.identity.mode
		);
	};
	if (!(await current())) return undefined;
	const result = await deps.bearer(target.id, target.ifname, current);
	return result?.iface === target.ifname && (await current())
		? result
		: undefined;
}
