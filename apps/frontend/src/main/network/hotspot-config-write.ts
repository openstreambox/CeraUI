/**
 * The one live hotspot config write: the dialog's Save and New Wi-Fi password
 * both go through it, so both run under the same keyed op
 * (`hotspot-config:<device>:<incarnation>`), bind to the same radio token, and
 * settle the same way.
 *
 * - The request carries `{device, incarnation}`; a radio the device has not
 *   observed yet gets one retry from a future status frame
 *   (`withWifiEntryRetry`), which moves the op to that token's key.
 * - The device's terminal `hotspot.config` frame is owned by this dispatch
 *   through `withWifiConfigReceipt`; a `radio-changed` terminal turns the
 *   accepted reply into a refusal. The op itself is confirmed or failed by the
 *   subscription layer from that frame, never by the dispatch ack.
 * - A request the device cannot bind (no token, even after the retry) reports
 *   `binding-required`.
 */
import { m } from "@ceraui/i18n/svelte";
import type {
	HotspotConfigInput,
	HotspotConfigOutput,
} from "@ceraui/rpc/schemas";

import {
	classifyWifiMutation,
	wifiFailureReason,
} from "$lib/helpers/wifi-mode-outcome";
import {
	getOperationAttempt,
	osCommand,
} from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";
import { withWifiConfigReceipt } from "$lib/rpc/wifi-status-receipt";

import { withWifiEntryRetry } from "./wifi-entry-request";
import type { WifiRadioBinding } from "./wifi-radio-binding";
import { wifiHotspotConfigOpKey } from "./wifi-station-lock";

/** Everything a config write sends besides the radio binding. */
export type HotspotConfigFields = Omit<
	HotspotConfigInput,
	"device" | "incarnation"
>;

export type HotspotConfigWriteOwner = {
	/** Aborting drops the wait for the terminal frame. */
	readonly signal: AbortSignal;
	/** Whether the caller still owns the admission (same device and link). */
	readonly current: () => boolean;
	/** Whether the caller still owns the result's feedback. */
	readonly isCurrent?: () => boolean;
	/** The keyed op has begun; `attempt` names this dispatch's attempt. */
	readonly onDispatch?: (key: string, attempt: symbol | undefined) => void;
	/** The entry retry is about to rebind to `incarnation`. */
	readonly onRebind?: (incarnation: string) => void;
	/** The op moved to `key` for the rebound token. */
	readonly onHandoff?: (key: string) => void;
	/** The device could not bind this request, even after the retry. */
	readonly onUnsupported?: () => void;
	readonly onResult?: (result: HotspotConfigOutput) => void;
};

export function hotspotConfigFailMessage(
	result: HotspotConfigOutput | undefined,
): string {
	if (wifiFailureReason(result ?? {}) === "hybrid-channel-not-permitted")
		return m["network.wifiMode.error.hybridChannelNotPermitted"]();
	if (result?.error === "radio-unverified")
		return m["hotspotConfigurator.radioUnverified"]();
	return m["network.os.operationFailed"]();
}

/**
 * Write `fields` to the live hotspot on `binding`'s radio. Resolves to the
 * outcome (after the terminal frame when the device accepted the request), or
 * `undefined` when nothing was dispatched (the key was already pending) or the
 * caller no longer owns the result.
 */
export async function writeHotspotConfig(
	binding: WifiRadioBinding & { readonly incarnation: string },
	fields: HotspotConfigFields,
	owner: HotspotConfigWriteOwner,
): Promise<HotspotConfigOutput | undefined> {
	const { device } = binding;
	const key = wifiHotspotConfigOpKey(device, binding.incarnation);
	return osCommand({
		key,
		classify: classifyWifiMutation,
		rpc: async (handoff) => {
			owner.onDispatch?.(key, getOperationAttempt(key));
			const result = await withWifiEntryRetry(
				binding,
				(incarnation, unobserved) =>
					withWifiConfigReceipt(
						{ device, incarnation },
						() => rpc.wifi.hotspotConfigure({ ...fields, device, incarnation }),
						{ signal: owner.signal, unobserved },
					),
				{
					signal: owner.signal,
					current: owner.current,
					rebind: (incarnation) => {
						owner.onRebind?.(incarnation);
						const next = wifiHotspotConfigOpKey(device, incarnation);
						if (!handoff(next)) return false;
						owner.onHandoff?.(next);
						return true;
					},
				},
			);
			if (!result && !owner.signal.aborted && owner.current())
				owner.onUnsupported?.();
			return result ?? { success: false, error: "binding-required" };
		},
		...(owner.isCurrent ? { isCurrent: owner.isCurrent } : {}),
		...(owner.onResult ? { onResult: owner.onResult } : {}),
		failMessage: hotspotConfigFailMessage,
		busyMessage: () => m["network.os.deviceBusy"](),
		// NO confirmOnResolve: the terminal hotspot.config frame confirms.
	});
}
