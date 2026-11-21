import type { TailscaleStatus } from "@ceraui/rpc/schemas";

/** Within this long of the login's expiry, the card warns. */
export const EXPIRES_SOON_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How the device's Tailscale login stands, judged by the viewer's clock (a
 * box may boot with a wrong one):
 * - never: connected, and the login does not expire (tagged, or expiry off)
 * - later: connected, expiry more than EXPIRES_SOON_MS away
 * - soon: connected, expiry within EXPIRES_SOON_MS (or just passed while
 *   tailscaled has not noticed yet)
 * - expired: the device needs a new login because the old one expired
 */
export type RemoteAccessExpiry =
	| { kind: "never" }
	| { kind: "later" | "soon" | "expired"; at: Date };

export function remoteAccessExpiry(
	status: TailscaleStatus | undefined,
	now: number,
): RemoteAccessExpiry | undefined {
	if (!status) return undefined;
	const at =
		status.keyExpiry === undefined ? undefined : new Date(status.keyExpiry);
	const time = at?.getTime();
	if (status.state === "connected") {
		if (status.keyExpiry === undefined) return { kind: "never" };
		if (at === undefined || time === undefined || Number.isNaN(time))
			return undefined;
		return { kind: time - now <= EXPIRES_SOON_MS ? "soon" : "later", at };
	}
	if (
		status.state === "needs_key" &&
		at &&
		time !== undefined &&
		!Number.isNaN(time) &&
		time <= now
	) {
		return { kind: "expired", at };
	}
	return undefined;
}

/** The expiry date in the viewer's language, without a time of day. */
export function formatExpiryDate(at: Date, locale: string): string {
	return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(at);
}
