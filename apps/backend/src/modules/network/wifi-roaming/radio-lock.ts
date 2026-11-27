/**
 * The roaming coordinator's view of CeraUI's per-adapter Wi-Fi lock. Hotspot
 * start, stop and reconfigure hold this lock while they change a radio, so a
 * scan or join run under it cannot interleave with a radio turning into an AP.
 * The lock never waits: a busy radio is skipped this round.
 *
 * The coordinator knows a radio by its interface name, which is not an
 * identity: names move on replug, and a hotspot can make the lock's owner a
 * composite key. So a radio is admitted the way every Wi-Fi mutation admits
 * one. Only a verified identity row, bound to the exact registry object and
 * currently published, qualifies. Its owner-resolved lock is taken, and under
 * it a fresh sample must show the same physical radio (permanent MAC and
 * lifetime) before the action runs. A Limited, Unverified, unpublished or
 * replaced radio is refused, so the coordinator does not act on it.
 *
 * The admission travels with the action. While `fn` runs, {@link admittedRadio}
 * returns it for this interface, so the NetworkManager port binds profiles to
 * the admitted permanent MAC rather than to whatever MAC the name shows now,
 * and {@link confirmAdmittedRadio} re-samples the radio right before each
 * dispatch (a scan, an activation). A replug under the same name therefore
 * fails the next confirmation instead of receiving the old radio's profile.
 * Confirming after the action, as the two-radio effect adapter does, is a
 * slice-3 item.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
	admitWifiAdapter,
	confirmWifiAdapterLifetime,
	type WifiAdapterAdmission,
} from "../../wifi/wifi-adapter-admission.ts";
import { withWifiAdapterLock } from "../../wifi/wifi-adapter-lock.ts";
import { getWifiInterfacesByMacAddress } from "../../wifi/wifi-connections.ts";
import type { RadioLockResult } from "./coordinator.ts";

/** Admit the radio behind an interface name, or `undefined` when uncertain. */
export function admitRadio(ifname: string): WifiAdapterAdmission | undefined {
	const rows = getWifiInterfacesByMacAddress();
	const keys = Object.keys(rows).filter((key) => rows[key]?.ifname === ifname);
	// Two rows under one name is a registry in flux: refuse rather than guess.
	if (keys.length !== 1) return undefined;
	return admitWifiAdapter(keys[0] as string);
}

const lockedAdmission = new AsyncLocalStorage<WifiAdapterAdmission>();

/**
 * The admission the current {@link withRadioLock} action runs under, when it
 * is for `ifname`. `undefined` outside such an action.
 */
export function admittedRadio(
	ifname: string,
): WifiAdapterAdmission | undefined {
	const admission = lockedAdmission.getStore();
	return admission?.row.ifname === ifname ? admission : undefined;
}

/**
 * Right before a dispatch inside {@link withRadioLock}: the radio behind
 * `ifname` is still the admitted one (same registry row, owner, incarnation,
 * permanent MAC and lifetime, under the held owner lock). False outside an
 * action for this interface.
 */
export async function confirmAdmittedRadio(ifname: string): Promise<boolean> {
	const admission = admittedRadio(ifname);
	return admission !== undefined && confirmWifiAdapterLifetime(admission);
}

export async function withRadioLock<T>(
	ifname: string,
	fn: () => Promise<T>,
): Promise<RadioLockResult<T>> {
	const admission = admitRadio(ifname);
	if (!admission) return { ok: false };
	const result = await withWifiAdapterLock(admission.owner, async () => {
		if (!(await confirmWifiAdapterLifetime(admission)))
			return { confirmed: false as const };
		return {
			confirmed: true as const,
			value: await lockedAdmission.run(admission, fn),
		};
	});
	if (!result.success || !result.result.confirmed) return { ok: false };
	return { ok: true, value: result.result.value };
}
