/**
 * The join notice: "A new device joined" when someone new is on the box's Wi-Fi.
 *
 * It reuses the app's existing toast; there is no new notification type and
 * nothing on the device side. Every join belongs to the access point it happened
 * on (device key, radio incarnation and AP lifetime, see `hotspot-joins.ts`).
 * While a Wi-Fi code card for THAT access point is on screen, the card says it
 * in place (and hides the code), so the toast is not shown twice. A card for
 * another hotspot, or for a later lifetime of the same one, never claims the
 * join, so its "Not mine?" can only ever renew the hotspot the device joined.
 *
 * A lifetime that ends drops its join, and a dropped link starts every AP over
 * (the page cannot know what it missed while the socket was down), so the
 * first reading after either is a fresh baseline.
 */
import { m } from "@ceraui/i18n/svelte";
import type { WifiInterface, WifiStatus } from "@ceraui/rpc/schemas";
import { toast } from "svelte-sonner";

import { getLinkEpoch } from "$lib/rpc/session-epoch.svelte";
import {
	createHotspotJoinTracker,
	type HotspotApLifetimes,
	type HotspotOwner,
	hotspotLifetimeIn,
	sameHotspot,
} from "$main/network/hotspot-joins";

export type { HotspotOwner } from "$main/network/hotspot-joins";

export type HotspotJoin = HotspotOwner & {
	readonly lifetime: number;
	readonly at: number;
	readonly seq: number;
};

let tracker = createHotspotJoinTracker();
let trackedLink: number | undefined;
let seq = 0;
// Latest join per device key; each entry names its radio and AP lifetime.
let joins = $state.raw<Readonly<Record<string, HotspotJoin>>>({});
// The live APs' lifetimes as of the last snapshot; replaced only when they move.
let lifetimes = $state.raw<HotspotApLifetimes>(new Map());
// biome-ignore lint/nursery/useSvelteReactiveClasses: Card registrations only gate the toast; nothing renders from them.
const cards = new Set<{ readonly owner: HotspotOwner }>();

/** Feed every wifi snapshot the device sends. */
export function noteHotspotRoster(
	wifi: WifiStatus | undefined,
	now = Date.now(),
): void {
	if (wifi === undefined) return;
	const link = getLinkEpoch();
	if (trackedLink !== link) {
		trackedLink = link;
		tracker = createHotspotJoinTracker();
	}
	const events = tracker.observe(wifi);
	const current = tracker.lifetimes();
	if (
		current.size !== lifetimes.size ||
		[...current].some(([device, ap]) => {
			const before = lifetimes.get(device);
			return before?.lifetime !== ap.lifetime || before.conn !== ap.conn;
		})
	)
		lifetimes = current;
	const next: Record<string, HotspotJoin> = {};
	// A join outlives neither its AP lifetime nor its radio.
	for (const [device, join] of Object.entries(joins)) {
		if (tracker.lifetimeOf(device, wifi[device]) === join.lifetime)
			next[device] = join;
	}
	let unclaimed = false;
	for (const event of events) {
		seq += 1;
		next[event.device] = {
			device: event.device,
			incarnation: event.incarnation,
			lifetime: event.lifetime,
			at: now,
			seq,
		};
		if (![...cards].some((card) => sameHotspot(card.owner, event)))
			unclaimed = true;
	}
	if (
		events.length > 0 ||
		Object.keys(next).length !== Object.keys(joins).length
	)
		joins = next;
	if (!unclaimed) return;
	toast(m["network.hotspot.joinToast"](), {
		description: m["network.hotspot.joinToastHint"](),
	});
}

/**
 * The page-local lifetime of the AP `iface` shows on `device`, or `undefined`
 * when the roster feed has not seen that AP (yet). Reactive.
 */
export function getHotspotLifetime(
	device: string,
	iface: WifiInterface | undefined,
): number | undefined {
	return hotspotLifetimeIn(lifetimes, device, iface);
}

/** The latest join on this access point, or `null` when none was seen. */
export function getLastHotspotJoin(owner: HotspotOwner): HotspotJoin | null {
	const join = joins[owner.device];
	return join !== undefined && sameHotspot(join, owner) ? join : null;
}

/** A Wi-Fi code card announces its own hotspot's joins while it is mounted. */
export function registerWifiCodeCard(owner: HotspotOwner): () => void {
	const card = {
		owner: {
			device: owner.device,
			incarnation: owner.incarnation,
			lifetime: owner.lifetime,
		},
	};
	cards.add(card);
	return () => {
		cards.delete(card);
	};
}

export function resetHotspotJoinsForTest(): void {
	tracker = createHotspotJoinTracker();
	trackedLink = undefined;
	seq = 0;
	joins = {};
	lifetimes = new Map();
	cards.clear();
}
