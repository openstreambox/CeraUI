import { tick } from "svelte";
import { waitForWifiStatus } from "$lib/rpc/wifi-status-receipt";
import type { WifiRadioBinding } from "./wifi-radio-binding";

/**
 * A transient missing observation gets one retry from a future status frame,
 * and only for the SAME radio lifetime. A frame carrying a different token
 * names another target: the first refusal stands, so the caller's changed-radio
 * handling applies and the operator has to pick the radio again.
 */
export async function withWifiEntryRetry<
	T extends { readonly error?: string; readonly reason?: string },
>(
	binding: WifiRadioBinding,
	invoke: (incarnation: string, unobserved?: () => void) => Promise<T>,
	owner: {
		readonly signal: AbortSignal;
		readonly current: () => boolean;
		/**
		 * Called with the SAME token before the resend. False when this attempt
		 * no longer owns its operation (another client's transition holds it).
		 */
		readonly rebind: (incarnation: string) => boolean;
	},
): Promise<T | undefined> {
	const incarnation = binding.incarnation;
	if (!incarnation) return;
	let observation: ReturnType<typeof waitForWifiStatus> | undefined;
	const result = await invoke(incarnation, () => {
		observation ??= waitForWifiStatus(binding.device, owner.signal);
	});
	if (
		result.error !== "radio-changed" ||
		result.reason !== "current-unobserved"
	)
		return result;
	const row = await (observation ??
		waitForWifiStatus(binding.device, owner.signal));
	await tick();
	if (owner.signal.aborted || !owner.current() || !row?.incarnation) return;
	if (row.incarnation !== incarnation || !owner.rebind(incarnation))
		return result;
	return invoke(incarnation);
}
