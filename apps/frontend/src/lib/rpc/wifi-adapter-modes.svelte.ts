/**
 * wifi-adapter-modes — the per-adapter station/hotspot/hybrid offering.
 *
 * This is a PULL (`rpc.wifi.getAdapterModes`), not a field on the `wifi`
 * broadcast, so it needs a slot of its own. It is deliberately NOT owned by
 * `subscriptions.svelte.ts`: that module is the sole `rpcClient.onMessage`
 * consumer, and nothing here reads the socket.
 *
 * The map is a CACHE of the device's own answer, never a local derivation. A
 * refresh is triggered on mount and after a terminal mode-change frame, because
 * a successful transition changes both `mode` and (for hybrid) which options are
 * still on offer.
 *
 * `undefined` before the first answer is load-bearing: it is "we have not asked
 * yet", which a consumer must render as the adapter's own legacy truth rather
 * than as an empty offering.
 */

import type {
	WifiAdapterModeEntry,
	WifiAdapterModeStatus,
	WifiStatus,
} from "@ceraui/rpc/schemas";

import { rpc } from "./client";

let adapterModes = $state<WifiAdapterModeStatus | undefined>(undefined);
let inFlight: Promise<void> | undefined;
// A refresh asked for while one is in flight: that pull may predate the change
// that asked, so exactly one more follows it.
let again = false;

export function getWifiAdapterModes(): WifiAdapterModeStatus | undefined {
	return adapterModes;
}

export function getWifiAdapterModeEntry(
	device: string,
): WifiAdapterModeEntry | undefined {
	return adapterModes?.[device];
}

/**
 * Self-serialising: calls while a pull is in flight share it and then get ONE
 * follow-up pull, because the in-flight answer may predate the change that
 * asked. A burst of calls costs at most two pulls.
 */
export function refreshWifiAdapterModes(): Promise<void> {
	if (inFlight) {
		again = true;
		return inFlight;
	}
	again = false;
	// The dispatch itself can throw SYNCHRONOUSLY (a transport that is not up, a
	// double without the method). Callers run this from an `$effect`, where an
	// escaping throw tears down the component rather than degrading the offering.
	inFlight = Promise.resolve()
		.then(() => rpc.wifi.getAdapterModes())
		.then((modes) => {
			adapterModes = modes;
		})
		.catch(() => {
			// A failed read says nothing about the adapter, so the previous answer
			// stands. Replacing it with `{}` would report every mode as unoffered.
		})
		.finally(() => {
			inFlight = undefined;
			if (again) void refreshWifiAdapterModes();
		});
	return inFlight;
}

/**
 * The per-radio facts a hotspot start or stop changes on the `wifi` snapshot:
 * the radio's mode, whether a live AP reports its clients, and the transition.
 *
 * The adapter-mode answer is a pull, so it would otherwise refresh only on mount
 * and after a mode change this UI tracked. A Start from the API, another client
 * or the device itself shows up first here, and a changed signature is the cue
 * to pull again.
 */
export function wifiLiveApSignature(wifi: WifiStatus | undefined): string {
	if (wifi === undefined) return "";
	return Object.entries(wifi)
		.map(
			([id, iface]) =>
				`${id}:${iface.mode ?? ""}:${iface.hotspot?.clients !== undefined ? "ap" : ""}:${iface.transition ?? ""}`,
		)
		.sort()
		.join("|");
}

/** Test/reset seam — also called from `resetState()` on a session teardown. */
export function resetWifiAdapterModes(): void {
	adapterModes = undefined;
	inFlight = undefined;
	again = false;
}

/** Test seam: seed the slot without a socket. */
export function setWifiAdapterModesForTest(
	modes: WifiAdapterModeStatus | undefined,
): void {
	adapterModes = modes;
}
