/*
  A LINK THAT KEPT ITS OLD ADDRESS, AND THE ONE THING THAT FIXES IT.

  The sender is signalled, and signalled once more after about ten seconds. If
  a source that is no longer published is still bound after that, only a full
  session restart helps: a replacement sender would register a new relay group,
  and the engine's SRT session cannot follow it.

  What that restart costs depends on the other links (link-carrying.ts):
  - another link carried traffic in the last ten seconds: the stream is going
    out on it, and a restart would put the BRB screen on air for nothing. The
    device says the link is not contributing, offers the restart with its cost,
    and does nothing until the operator taps it;
  - no other link carried anything: the stream is already down, so the device
    restarts it once on its own (connection-restart.ts) and says so afterwards;
  - can't tell: the offer, without any claim about the other links.

  What this module may say: which link is affected, whether the other links
  were seen carrying the stream, and what a restart costs. It never says the
  stream is "still live"; that is not something it observes.
*/

import { randomUUID } from "node:crypto";
import type { NotificationAction } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";
import type { CarryVerdict } from "./link-carrying.ts";

export const STALE_LINK_NOTICE = "stale_link_address";
/** The notice cannot come back within this long, whatever the modem does. */
export const STALE_LINK_NOTICE_COOLDOWN_MS = 5 * 60_000;

/**
 * What the session does with a source that stays stale after the retry:
 * `offer` while other links carry the stream (or nobody can tell), `restart`
 * when no other link does. A later option, an automatic restart that is
 * announced afterwards even while other links carry, would be selected here by
 * a device setting that is off by default. It is not built.
 */
export type StaleSourceResponse = "offer" | "restart";

/** Restart on its own only when nothing else carries the stream. */
export function staleSourceResponse(
	verdict: CarryVerdict,
): StaleSourceResponse {
	return verdict === "none_carrying" ? "restart" : "offer";
}

const COST =
	"Restart connection? Viewers see your BRB screen for a few seconds.";
const CARRYING = "Your other links are carrying the stream.";

/**
 * `count` stuck links; `name` only when exactly one is known by name;
 * `othersCarrying` only when another link was seen carrying traffic.
 */
export type StaleLinks = {
	readonly count: number;
	readonly name?: string;
	readonly othersCarrying?: boolean;
};

export function staleLinkMessage(links: StaleLinks): {
	key: string;
	params?: Record<string, unknown>;
	msg: string;
} {
	const carrying = links.othersCarrying === true;
	const tail = carrying ? `${CARRYING} ${COST}` : COST;
	if (links.count <= 1 && links.name)
		return {
			key: carrying
				? "notifications.staleLinkAddressCarrying"
				: "notifications.staleLinkAddress",
			params: { link: links.name },
			msg: `${links.name} isn't contributing because it's still using an old address. ${tail}`,
		};
	if (links.count > 1)
		return {
			key: carrying
				? "notifications.staleLinkAddressSeveralCarrying"
				: "notifications.staleLinkAddressSeveral",
			msg: `Some links aren't contributing because they're still using old addresses. ${tail}`,
		};
	return {
		key: carrying
			? "notifications.staleLinkAddressUnnamedCarrying"
			: "notifications.staleLinkAddressUnnamed",
		msg: `One link isn't contributing because it's still using an old address. ${tail}`,
	};
}

export type StaleLinkOffer = {
	readonly token: string;
	readonly generation: number;
};

export type StaleLinkNoticeDeps = {
	readonly now: () => number;
	readonly token: () => string;
	readonly show: (notice: {
		name: string;
		msg: string;
		key: string;
		params?: Record<string, unknown>;
		action: NotificationAction;
		/** The operator closed the notice: no restart, and the token is spent. */
		onDismiss: () => void;
	}) => void;
	readonly remove: (name: string) => void;
	readonly log: (message: string, meta: Record<string, unknown>) => void;
	readonly cooldownMs?: number;
};

export function createStaleLinkNotice(deps: StaleLinkNoticeDeps) {
	const cooldownMs = deps.cooldownMs ?? STALE_LINK_NOTICE_COOLDOWN_MS;
	let offer: StaleLinkOffer | undefined;
	let lastShownAt = Number.NEGATIVE_INFINITY;
	const clear = () => {
		if (offer === undefined) return;
		offer = undefined;
		deps.remove(STALE_LINK_NOTICE);
	};
	return {
		/**
		 * Show the offer unless one was shown within the cooldown. `pastCooldown`
		 * is for the one case where silence would be wrong: nothing else carries
		 * the stream and the automatic restart is held.
		 */
		offer(
			generation: number,
			links: StaleLinks,
			options?: { readonly pastCooldown?: boolean },
		): boolean {
			if (
				options?.pastCooldown !== true &&
				deps.now() - lastShownAt < cooldownMs
			) {
				deps.log("stale link notice held by cooldown", { generation });
				return false;
			}
			lastShownAt = deps.now();
			const token = deps.token();
			offer = { token, generation };
			deps.show({
				name: STALE_LINK_NOTICE,
				...staleLinkMessage(links),
				action: {
					schema: 1,
					kind: "command",
					command: "restart-connection",
					token,
					labelKey: "notifications.restartConnection",
				},
				onDismiss: () => {
					if (offer?.token === token) offer = undefined;
				},
			});
			return true;
		},
		/** A later adoption or the end of the session withdraws the offer. */
		retract(generation: number): void {
			if (offer?.generation === generation) clear();
		},
		/** One tap, one restart: a matching token is spent on first use. */
		take(token: string, generation: number | undefined) {
			const current = offer;
			if (
				current === undefined ||
				current.token !== token ||
				current.generation !== generation
			)
				return undefined;
			clear();
			return current;
		},
		current: () => offer,
		/** Tests only: forget the offer and the cooldown. */
		resetForTest(): void {
			offer = undefined;
			lastShownAt = Number.NEGATIVE_INFINITY;
		},
	};
}

export type StaleLinkNotice = ReturnType<typeof createStaleLinkNotice>;

export const staleLinkNotice = createStaleLinkNotice({
	now: Date.now,
	token: randomUUID,
	show: ({ name, msg, key, params, action, onDismiss }) =>
		notificationBroadcast(name, "info", msg, 0, true, true, true, key, params, {
			action,
			onDismiss,
		}),
	remove: (name) => {
		notificationRemove(name);
	},
	log: (event, meta) => logger.info("stale link notice", { event, ...meta }),
});
