/**
 * The join notice: "A new device joined" when someone new is on the box's Wi-Fi.
 *
 * It reuses the app's existing toast; there is no new notification type and
 * nothing on the device side. While a Wi-Fi code card is on screen, that card
 * says it in place (and hides the code), so the toast is not shown twice.
 */
import { m } from "@ceraui/i18n/svelte";
import type { WifiStatus } from "@ceraui/rpc/schemas";
import { toast } from "svelte-sonner";

import { createHotspotJoinTracker } from "$main/network/hotspot-joins";

export type HotspotJoin = { readonly at: number; readonly seq: number };

let tracker = createHotspotJoinTracker();
let lastJoin = $state.raw<HotspotJoin | null>(null);
let cards = 0;

/** Feed every wifi snapshot the device sends. */
export function noteHotspotRoster(
	wifi: WifiStatus | undefined,
	now = Date.now(),
): void {
	const joins = tracker.observe(wifi);
	if (joins === 0) return;
	lastJoin = { at: now, seq: (lastJoin?.seq ?? 0) + 1 };
	if (cards > 0) return;
	toast(m["network.hotspot.joinToast"](), {
		description: m["network.hotspot.joinToastHint"](),
	});
}

export function getLastHotspotJoin(): HotspotJoin | null {
	return lastJoin;
}

/** A Wi-Fi code card announces joins itself while it is mounted. */
export function registerWifiCodeCard(): () => void {
	cards += 1;
	let registered = true;
	return () => {
		if (!registered) return;
		registered = false;
		cards -= 1;
	};
}

export function resetHotspotJoinsForTest(): void {
	tracker = createHotspotJoinTracker();
	lastJoin = null;
	cards = 0;
}
