import type { SharingPolicy } from "@ceraui/rpc/schemas";
import type { UplinkHealthRecord } from "../uplink-health/model.ts";
import type { SteeringUplink } from "./contracts.ts";
import {
	applySharingPolicy,
	sharingPolicyAllows,
	sharingUplinkKind,
} from "./policy.ts";

/**
 * Single-active client uplink selection.
 *
 * Only forwarded client traffic is affected: the ruleset that consumes this
 * selection matches client zones by input interface and source subnet, so
 * host-originated traffic (SRTLA, Moblink, management) keeps its own routes.
 *
 * - Failover is immediate: when the active uplink leaves the candidate set
 *   (health `down` after a hard loss or a failed-probe blackhole, interface
 *   gone, policy exclusion) the best remaining candidate takes over in the
 *   same reconcile.
 * - Rejoin is held: a better-ranked uplink displaces a working active one
 *   only after it has been continuously `up` with probe evidence for the
 *   rejoin hold. Each failure while active doubles that uplink's next hold,
 *   up to a cap, so a flapping link cannot keep pulling clients back.
 * - A displaced uplink stays listed (not selectable, weight 0), so flows it
 *   already carries keep their restore and NAT rules and drain naturally.
 */
export const ACTIVE_UPLINK_CONFIG = {
	rejoinHoldMs: 30_000,
	maxRejoinHoldMs: 300_000,
	/** A failure older than this no longer lengthens the next hold. */
	flapWindowMs: 600_000,
} as const;

const KIND_ORDER = { wired: 0, wifi: 1, cellular: 2 } as const;

export interface ActiveUplinkCandidate {
	readonly uplink: SteeringUplink;
}

export interface ActiveUplinkContext {
	readonly now: number;
	readonly policy: SharingPolicy;
	readonly health: ReadonlyMap<string, UplinkHealthRecord>;
	/** Identities still present and not health-down, before policy filters. */
	readonly present: ReadonlySet<string>;
}

interface Penalty {
	failures: number;
	lastFailureAt: number;
}

export class ActiveUplinkSelector {
	#active: string | undefined;
	#activeSince = 0;
	readonly #healthySince = new Map<string, number>();
	readonly #penalties = new Map<string, Penalty>();

	/** Identity of the uplink that currently receives new client flows. */
	active(): string | undefined {
		return this.#active;
	}

	select<T extends ActiveUplinkCandidate>(
		candidates: readonly T[],
		context: ActiveUplinkContext,
	): T[] {
		const { now } = context;
		this.#trackHealthy(candidates, context);
		this.#forgetStalePenalties(now);
		const usable = candidates.filter(
			({ uplink }) => uplink.selectable && uplink.weight > 0,
		);
		const current = usable.find(
			({ uplink }) => uplink.identity === this.#active,
		);
		if (this.#active !== undefined && current === undefined) {
			// Lost while active. A policy exclusion is a choice, not a failure.
			if (!context.present.has(this.#active)) this.#penalize(now);
			this.#active = undefined;
		}
		let chosen = current;
		if (chosen === undefined) {
			chosen = [...usable].sort((a, b) => compare(a, b, context))[0];
		} else {
			const challenger = usable
				.filter(
					(candidate) =>
						candidate !== current &&
						rankKey(candidate, context) < rankKey(current as T, context) &&
						this.#rejoinReady(candidate.uplink.identity, now),
				)
				.sort((a, b) => compare(a, b, context))[0];
			if (challenger !== undefined) chosen = challenger;
		}
		if (chosen?.uplink.identity !== this.#active) {
			this.#active = chosen?.uplink.identity;
			this.#activeSince = now;
		}
		if (
			this.#active !== undefined &&
			now - this.#activeSince >= ACTIVE_UPLINK_CONFIG.flapWindowMs
		) {
			this.#penalties.delete(this.#active);
		}
		return candidates.map((candidate) => {
			const selected = candidate === chosen;
			return {
				...candidate,
				uplink: {
					...candidate.uplink,
					selectable: selected,
					weight: selected ? 100 : 0,
				},
			};
		});
	}

	/** The hold a candidate must stay healthy before it may displace another. */
	rejoinHoldMs(identity: string): number {
		const failures = this.#penalties.get(identity)?.failures ?? 0;
		return Math.min(
			ACTIVE_UPLINK_CONFIG.rejoinHoldMs * 2 ** failures,
			ACTIVE_UPLINK_CONFIG.maxRejoinHoldMs,
		);
	}

	#rejoinReady(identity: string, now: number): boolean {
		const since = this.#healthySince.get(identity);
		return since !== undefined && now - since >= this.rejoinHoldMs(identity);
	}

	#trackHealthy(
		candidates: readonly ActiveUplinkCandidate[],
		{ now, health }: ActiveUplinkContext,
	): void {
		const seen = new Set<string>();
		for (const { uplink } of candidates) {
			const record = health.get(uplink.ifname);
			// A record that starts `up` before any probe is not evidence.
			const proven = record?.state === "up" && record.probes.successes > 0;
			if (!proven) continue;
			seen.add(uplink.identity);
			if (!this.#healthySince.has(uplink.identity))
				this.#healthySince.set(uplink.identity, now);
		}
		for (const identity of this.#healthySince.keys()) {
			if (!seen.has(identity)) this.#healthySince.delete(identity);
		}
	}

	#penalize(now: number): void {
		if (this.#active === undefined) return;
		const prior = this.#penalties.get(this.#active);
		this.#penalties.set(this.#active, {
			failures: (prior?.failures ?? 0) + 1,
			lastFailureAt: now,
		});
	}

	#forgetStalePenalties(now: number): void {
		for (const [identity, penalty] of this.#penalties) {
			if (now - penalty.lastFailureAt >= ACTIVE_UPLINK_CONFIG.flapWindowMs)
				this.#penalties.delete(identity);
		}
	}
}

/**
 * Lower is better: operator priority for the kind, then healthy before
 * degraded, then the cheaper kind (wired, Wi-Fi, cellular). Interface names
 * only break ties for the first pick and never cause a switch.
 */
function rankKey(
	{ uplink }: ActiveUplinkCandidate,
	{ policy, health }: ActiveUplinkContext,
): number {
	const kind = sharingUplinkKind(uplink.ifname);
	const degraded = health.get(uplink.ifname)?.state === "degraded" ? 1 : 0;
	return policy.priorities[kind] * 100 + degraded * 10 + KIND_ORDER[kind];
}

function compare(
	a: ActiveUplinkCandidate,
	b: ActiveUplinkCandidate,
	context: ActiveUplinkContext,
): number {
	return (
		rankKey(a, context) - rankKey(b, context) ||
		a.uplink.ifname.localeCompare(b.uplink.ifname)
	);
}

/**
 * The policy step of the state builder. `spread` keeps the weighted
 * distribution unchanged; `single` lets the selector pick one active uplink
 * from everything the mode and administrative filters allow.
 */
export function applyClientUplinkPolicy<T extends ActiveUplinkCandidate>(
	candidates: readonly T[],
	selector: ActiveUplinkSelector,
	context: ActiveUplinkContext,
): T[] {
	if (context.policy.selection === "spread")
		return applySharingPolicy(candidates, context.policy);
	return selector.select(
		candidates.filter(({ uplink }) =>
			sharingPolicyAllows(uplink, context.policy),
		),
		context,
	);
}

export const activeUplinkSelector = new ActiveUplinkSelector();
