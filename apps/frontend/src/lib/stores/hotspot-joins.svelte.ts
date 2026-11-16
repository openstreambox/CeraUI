/**
 * The join notice: "A new device joined" when someone new is on the box's Wi-Fi.
 *
 * It reuses the app's existing toast; there is no new notification type and
 * nothing on the device side. Every join belongs to the access point it happened
 * on (device key and radio incarnation). While a Wi-Fi code card for THAT access
 * point is on screen, the card says it in place (and hides the code), so the
 * toast is not shown twice. A card for another hotspot never claims the join,
 * so its "Not mine?" can only ever renew the hotspot the device actually joined.
 */
import { m } from "@ceraui/i18n/svelte";
import type { WifiStatus } from "@ceraui/rpc/schemas";
import { toast } from "svelte-sonner";

import {
	createHotspotJoinTracker,
	type HotspotOwner,
	sameHotspot,
} from "$main/network/hotspot-joins";

export type { HotspotOwner } from "$main/network/hotspot-joins";

export type HotspotJoin = HotspotOwner & {
	readonly at: number;
	readonly seq: number;
};

let tracker = createHotspotJoinTracker();
let seq = 0;
// Latest join per device key; the incarnation in each entry says which radio.
let joins = $state.raw<Readonly<Record<string, HotspotJoin>>>({});
// biome-ignore lint/nursery/useSvelteReactiveClasses: Card registrations only gate the toast; nothing renders from them.
const cards = new Set<{ readonly owner: HotspotOwner }>();

/** Feed every wifi snapshot the device sends. */
export function noteHotspotRoster(
	wifi: WifiStatus | undefined,
	now = Date.now(),
): void {
	const events = tracker.observe(wifi);
	if (events.length === 0) return;
	const next = { ...joins };
	let unclaimed = false;
	for (const event of events) {
		seq += 1;
		next[event.device] = {
			device: event.device,
			incarnation: event.incarnation,
			at: now,
			seq,
		};
		if (![...cards].some((card) => sameHotspot(card.owner, event)))
			unclaimed = true;
	}
	joins = next;
	if (!unclaimed) return;
	toast(m["network.hotspot.joinToast"](), {
		description: m["network.hotspot.joinToastHint"](),
	});
}

/** The latest join on this access point, or `null` when none was seen. */
export function getLastHotspotJoin(owner: HotspotOwner): HotspotJoin | null {
	const join = joins[owner.device];
	return join !== undefined && sameHotspot(join, owner) ? join : null;
}

/** A Wi-Fi code card announces its own hotspot's joins while it is mounted. */
export function registerWifiCodeCard(owner: HotspotOwner): () => void {
	const card = {
		owner: { device: owner.device, incarnation: owner.incarnation },
	};
	cards.add(card);
	return () => {
		cards.delete(card);
	};
}

export function resetHotspotJoinsForTest(): void {
	tracker = createHotspotJoinTracker();
	seq = 0;
	joins = {};
	cards.clear();
}
