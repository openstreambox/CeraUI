import type { WifiInterface } from "@ceraui/rpc/schemas";

export interface WifiRadioBinding {
	readonly device: string;
	readonly incarnation: string | undefined;
	readonly link: number;
	readonly session: number;
}

export function sameWifiRadio(
	a: WifiRadioBinding,
	b: WifiRadioBinding,
): boolean {
	return (
		a.device === b.device &&
		a.incarnation === b.incarnation &&
		a.link === b.link &&
		a.session === b.session
	);
}

// Future backend refusals are optional during the additive protocol rollout.
export function wifiRadioChanged(result: { readonly error?: string }): boolean {
	return (
		result.error === "radio-changed" || result.error === "binding-required"
	);
}

/**
 * A row whose token the device withholds for a moment while a peer restarts
 * its access point. It names no radio lifetime, so it neither proves nor ends
 * the one a bound editor opened on.
 */
export function wifiTokenWithheld(
	row:
		| Pick<WifiInterface, "incarnation" | "transition" | "leaving">
		| undefined,
): boolean {
	return (
		row !== undefined &&
		row.incarnation === undefined &&
		(row.transition !== undefined || row.leaving !== undefined)
	);
}
