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
 * Identity is confirmed at lock entry, and `fn` gets `confirm` to sample it
 * again under the held lock: the coordinator does so right before a join
 * activates and right after, and removes the clone if the radio changed.
 */
import {
	admitWifiAdapter,
	confirmWifiAdapterLifetime,
	type WifiAdapterAdmission,
} from "../../wifi/wifi-adapter-admission.ts";
import { withWifiAdapterLock } from "../../wifi/wifi-adapter-lock.ts";
import { getWifiInterfacesByMacAddress } from "../../wifi/wifi-connections.ts";
import { normalizeMacAddress } from "../../wifi/wifi-permanent-mac.ts";
import type { RadioExpectation, RadioLockResult } from "./coordinator.ts";

/** Admit the radio behind an interface name, or `undefined` when uncertain. */
export function admitRadio(ifname: string): WifiAdapterAdmission | undefined {
	const rows = getWifiInterfacesByMacAddress();
	const keys = Object.keys(rows).filter((key) => rows[key]?.ifname === ifname);
	// Two rows under one name is a registry in flux: refuse rather than guess.
	if (keys.length !== 1) return undefined;
	return admitWifiAdapter(keys[0] as string);
}

/** A radio lifetime as one comparable string; it changes on replug. */
export function lifetimeKey(l: {
	ifindex: number;
	wiphy: number;
	phyPath: string;
}): string {
	return `${l.ifindex}:${l.wiphy}:${l.phyPath}`;
}

/**
 * Run `fn` under the radio's adapter lock. With `expected`, the radio that
 * answers to `ifname` now must be that identity and lifetime: a replacement
 * that took the name since the round resolved it is refused before any effect.
 */
/** The admission for `ifname`, if it is the expected identity and lifetime. */
function admitExpected(
	ifname: string,
	expected: RadioExpectation | null,
): WifiAdapterAdmission | undefined {
	const admission = admitRadio(ifname);
	if (!admission) return undefined;
	if (
		expected &&
		(normalizeMacAddress(admission.registryKey) !==
			normalizeMacAddress(expected.id) ||
			(expected.lifetime !== null &&
				lifetimeKey(admission.lifetime) !== expected.lifetime))
	)
		return undefined;
	return admission;
}

/**
 * Is the radio answering to `ifname` right now the expected identity and
 * lifetime, confirmed against a fresh sample? The NetworkManager executor
 * asks this in the same step as each command.
 */
export async function confirmRadio(
	ifname: string,
	expected: RadioExpectation | null,
): Promise<boolean> {
	const admission = admitExpected(ifname, expected);
	return (
		admission !== undefined && (await confirmWifiAdapterLifetime(admission))
	);
}

/**
 * Run `fn` under the radio's adapter lock. With `expected`, the radio that
 * answers to `ifname` now must be that identity and lifetime: a replacement
 * that took the name since the round resolved it is refused before any effect.
 */
export async function withRadioLock<T>(
	ifname: string,
	expected: RadioExpectation | null,
	fn: (confirm: () => Promise<boolean>) => Promise<T>,
): Promise<RadioLockResult<T>> {
	const admission = admitExpected(ifname, expected);
	if (!admission) return { ok: false };
	const confirm = () => confirmWifiAdapterLifetime(admission);
	const result = await withWifiAdapterLock(admission.owner, async () => {
		if (!(await confirm())) return { confirmed: false as const };
		return { confirmed: true as const, value: await fn(confirm) };
	});
	if (!result.success || !result.result.confirmed) return { ok: false };
	return { ok: true, value: result.result.value };
}
