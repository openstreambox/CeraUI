/** What the local helper offer says the image can do. Absent means hidden. */
export type HelperActionOffer = {
	readonly retryPort: boolean;
	readonly rearmExhausted: boolean;
	readonly usb2: boolean;
};

export type HelperActionButtons = {
	readonly retry: boolean;
	readonly exhausted: boolean;
	readonly usb2: boolean;
};

const HIDDEN: HelperActionButtons = {
	retry: false,
	exhausted: false,
	usb2: false,
};

/**
 * The buttons live inside the helper disclosure.
 * A missing unit, a missing offer, or the wrong row keeps them hidden.
 */
export function helperActionButtons(
	offer: HelperActionOffer | null | undefined,
	row: { readonly kind: string | null; readonly helperTypec: boolean },
): HelperActionButtons {
	if (offer == null) return HIDDEN;
	const retry = offer.retryPort && row.helperTypec;
	return {
		retry,
		exhausted: offer.rearmExhausted && row.helperTypec && !retry,
		usb2: offer.usb2 && row.kind === "modem",
	};
}

export function helperActionNote(
	ok: boolean,
	refusal: string | undefined,
): "started" | "streaming" | "exhausted" | "busy" | "refused" {
	if (ok) return "started";
	if (refusal === "streaming_active") return "streaming";
	if (refusal === "budget_exhausted") return "exhausted";
	if (refusal === "action_in_progress" || refusal === "cooldown") return "busy";
	return "refused";
}
