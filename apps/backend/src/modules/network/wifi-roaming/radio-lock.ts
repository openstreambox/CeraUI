/**
 * The roaming coordinator's view of CeraUI's per-adapter Wi-Fi lock. Hotspot
 * start, stop and reconfigure hold this lock while they change a radio, so a
 * scan or join run under it cannot interleave with a radio turning into an AP.
 * The lock never waits: a busy radio is skipped this round.
 */
import {
	wifiAdapterLockKeyForIfname,
	withWifiAdapterLock,
} from "../../wifi/wifi-adapter-lock.ts";
import type { RadioLockResult } from "./coordinator.ts";

export async function withRadioLock<T>(
	ifname: string,
	fn: () => Promise<T>,
): Promise<RadioLockResult<T>> {
	// A radio CeraUI has not registered cannot be serialized against, so the
	// coordinator does not act on it at all.
	const key = wifiAdapterLockKeyForIfname(ifname);
	if (key === undefined) return { ok: false };
	const result = await withWifiAdapterLock(key, fn);
	return result.success ? { ok: true, value: result.result } : { ok: false };
}
