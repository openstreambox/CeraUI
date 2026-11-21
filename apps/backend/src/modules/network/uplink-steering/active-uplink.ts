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
 *   only after the general-internet probe has confirmed it, without a gap,
 *   for the rejoin hold. Sender (SRTLA) telemetry proves the path to the
 *   relay, not internet for clients: it can demote an uplink, never qualify
 *   one. Each failure while active doubles that uplink's next
 *   hold, up to a cap, so a flapping link cannot keep pulling clients back.
 * - A displaced uplink stays listed (not selectable, weight 0), so flows it
 *   already carries keep their restore and NAT rules and drain naturally.
 *
 * Planning is side-effect free. A plan's state becomes the selector's state
 * only through `commit`, which the steering runtime calls after the plan's
 * ruleset was applied and verified. A rejected apply, a retry or a read-only
 * caller (the shaper) therefore never moves the incumbent or charges a
 * failure to an uplink that did not carry clients.
 */
export const ACTIVE_UPLINK_CONFIG = {
	rejoinHoldMs: 30_000,
	maxRejoinHoldMs: 300_000,
	/** A failure older than this no longer lengthens the next hold. */
	flapWindowMs: 600_000,
	/**
	 * Largest gap between two active probe observations that still counts as
	 * continuous evidence (three 5 s rounds, the health telemetry expiry).
	 */
	maxProbeGapMs: 15_000,
} as const;

const KIND_ORDER = { wired: 0, wifi: 1, cellular: 2 } as const;

export interface ActiveUplinkCandidate {
	readonly uplink: SteeringUplink;
}

export interface ActiveUplinkContext {
	readonly now: number;
	readonly policy: SharingPolicy;
	readonly health: ReadonlyMap<string, UplinkHealthRecord>;
	/**
	 * Interfaces present with an address. An active uplink missing from this
	 * set (gone, or its address lost) has failed, even before health says so.
	 */
	readonly interfaces: ReadonlySet<string>;
}

interface Penalty {
	readonly failures: number;
	readonly lastFailureAt: number;
}

/** Continuous general-internet probe evidence, in probe timestamps. */
interface Proof {
	readonly since: number;
	readonly lastActiveAt: number;
	readonly lastSuccesses: number;
}

export interface ActiveUplinkState {
	readonly active?: { readonly identity: string; readonly ifname: string };
	readonly activeSince: number;
	readonly proofs: ReadonlyMap<string, Proof>;
	readonly penalties: ReadonlyMap<string, Penalty>;
	/** When each candidate identity was first offered, to ignore older samples. */
	readonly seen: ReadonlyMap<string, number>;
}

const EMPTY_STATE: ActiveUplinkState = {
	activeSince: 0,
	proofs: new Map(),
	penalties: new Map(),
	seen: new Map(),
};

export interface ActiveUplinkPlan<T> {
	readonly candidates: T[];
	/** State to commit once this plan is applied; undefined resets. */
	readonly next: ActiveUplinkState | undefined;
}

export class ActiveUplinkSelector {
	#state: ActiveUplinkState = EMPTY_STATE;

	/** Identity of the committed uplink that receives new client flows. */
	active(): string | undefined {
		return this.#state.active?.identity;
	}

	commit(next: ActiveUplinkState | undefined): void {
		this.#state = next ?? EMPTY_STATE;
	}

	/** Plans and commits at once; for callers that apply unconditionally. */
	select<T extends ActiveUplinkCandidate>(
		candidates: readonly T[],
		context: ActiveUplinkContext,
	): T[] {
		const plan = this.plan(candidates, context);
		this.commit(plan.next);
		return plan.candidates;
	}

	plan<T extends ActiveUplinkCandidate>(
		candidates: readonly T[],
		context: ActiveUplinkContext,
	): ActiveUplinkPlan<T> {
		const { now } = context;
		const prior = this.#state;
		const seen = new Map(
			candidates.map(({ uplink }) => [
				uplink.identity,
				prior.seen.get(uplink.identity) ?? now,
			]),
		);
		const proofs = trackProofs(prior.proofs, seen, candidates, context);
		const penalties = new Map(
			[...prior.penalties].filter(
				([, penalty]) =>
					now - penalty.lastFailureAt < ACTIVE_UPLINK_CONFIG.flapWindowMs,
			),
		);
		const usable = candidates.filter(
			({ uplink }) => uplink.selectable && uplink.weight > 0,
		);
		const current = usable.find(
			({ uplink }) => uplink.identity === prior.active?.identity,
		);
		if (prior.active !== undefined && current === undefined) {
			// Only a real loss counts. A policy exclusion or an uplink held back
			// for pending identity proof is not a failure of that uplink.
			const { ifname, identity } = prior.active;
			if (
				!context.interfaces.has(ifname) ||
				context.health.get(ifname)?.state === "down"
			) {
				const before = penalties.get(identity);
				penalties.set(identity, {
					failures: (before?.failures ?? 0) + 1,
					lastFailureAt: now,
				});
			}
		}
		let chosen = current;
		if (chosen === undefined) {
			// Failover: prefer an uplink the probe has confirmed over one with
			// no probe evidence (fresh, or judged only from sender telemetry).
			chosen = [...usable].sort(
				(a, b) =>
					Number(proofs.has(b.uplink.identity)) -
						Number(proofs.has(a.uplink.identity)) || compare(a, b, context),
			)[0];
		} else {
			const incumbent = chosen;
			const challenger = usable
				.filter(
					(candidate) =>
						candidate !== incumbent &&
						rankKey(candidate, context) < rankKey(incumbent, context) &&
						rejoinReady(candidate, proofs, penalties),
				)
				.sort((a, b) => compare(a, b, context))[0];
			if (challenger !== undefined) chosen = challenger;
		}
		const active =
			chosen === undefined
				? undefined
				: { identity: chosen.uplink.identity, ifname: chosen.uplink.ifname };
		const activeSince =
			active?.identity === prior.active?.identity ? prior.activeSince : now;
		if (
			active !== undefined &&
			now - activeSince >= ACTIVE_UPLINK_CONFIG.flapWindowMs
		) {
			penalties.delete(active.identity);
		}
		return {
			candidates: candidates.map((candidate) => {
				const selected = candidate === chosen;
				return {
					...candidate,
					uplink: {
						...candidate.uplink,
						selectable: selected,
						weight: selected ? 100 : 0,
					},
				};
			}),
			next: {
				...(active === undefined ? {} : { active }),
				activeSince,
				proofs,
				penalties,
				seen,
			},
		};
	}

	/** The hold a candidate must stay healthy before it may displace another. */
	rejoinHoldMs(identity: string): number {
		return holdFor(identity, this.#state.penalties);
	}
}

function holdFor(
	identity: string,
	penalties: ReadonlyMap<string, Penalty>,
): number {
	const failures = penalties.get(identity)?.failures ?? 0;
	return Math.min(
		ACTIVE_UPLINK_CONFIG.rejoinHoldMs * 2 ** failures,
		ACTIVE_UPLINK_CONFIG.maxRejoinHoldMs,
	);
}

/**
 * The latest general-internet probe observation that confirms `ifname`: an
 * `up`, unexpired record with a real success whose last ACTIVE observation is
 * recent. Passive sender telemetry never sets `activeAt`, so a link judged
 * only from SRTLA rows (probing is suppressed while streaming) has none.
 */
function probeEvidence(
	ifname: string,
	{ health, now }: ActiveUplinkContext,
): { readonly activeAt: number; readonly successes: number } | undefined {
	const record = health.get(ifname);
	const activeAt = record?.signals.activeAt;
	if (
		record?.state !== "up" ||
		record.probes.successes <= 0 ||
		record.staleAt <= now ||
		activeAt === undefined ||
		now - activeAt > ACTIVE_UPLINK_CONFIG.maxProbeGapMs
	)
		return undefined;
	return { activeAt, successes: record.probes.successes };
}

/**
 * Evidence restarts on any gap between probe observations, on a reset
 * success counter (a failed round), and ignores observations older than the
 * identity's first appearance (a predecessor on the same interface name).
 */
function trackProofs(
	prior: ReadonlyMap<string, Proof>,
	seen: ReadonlyMap<string, number>,
	candidates: readonly ActiveUplinkCandidate[],
	context: ActiveUplinkContext,
): Map<string, Proof> {
	const proofs = new Map<string, Proof>();
	for (const { uplink } of candidates) {
		const evidence = probeEvidence(uplink.ifname, context);
		const firstSeen = seen.get(uplink.identity) ?? context.now;
		if (evidence === undefined || evidence.activeAt < firstSeen) continue;
		const before = prior.get(uplink.identity);
		const continuous =
			before !== undefined &&
			evidence.activeAt >= before.lastActiveAt &&
			evidence.activeAt - before.lastActiveAt <=
				ACTIVE_UPLINK_CONFIG.maxProbeGapMs &&
			evidence.successes >= before.lastSuccesses;
		proofs.set(uplink.identity, {
			since: continuous ? before.since : evidence.activeAt,
			lastActiveAt: evidence.activeAt,
			lastSuccesses: evidence.successes,
		});
	}
	return proofs;
}

/** The hold must be covered end to end by continuous probe evidence. */
function rejoinReady(
	{ uplink }: ActiveUplinkCandidate,
	proofs: ReadonlyMap<string, Proof>,
	penalties: ReadonlyMap<string, Penalty>,
): boolean {
	const proof = proofs.get(uplink.identity);
	return (
		proof !== undefined &&
		proof.lastActiveAt - proof.since >= holdFor(uplink.identity, penalties)
	);
}

/**
 * Lower is better: healthy before degraded, then operator priority for the
 * kind, then the cheaper kind (wired, Wi-Fi, cellular). Health comes first so
 * a preferred uplink that health only marks degraded (captive portal, or a
 * streaming link judged from sender telemetry) yields to a proven healthy
 * one. Interface names only break ties for the first pick and never cause a
 * switch.
 */
function rankKey(
	{ uplink }: ActiveUplinkCandidate,
	{ policy, health }: ActiveUplinkContext,
): number {
	const kind = sharingUplinkKind(uplink.ifname);
	const degraded = health.get(uplink.ifname)?.state === "degraded" ? 1 : 0;
	return degraded * 100_000 + policy.priorities[kind] * 10 + KIND_ORDER[kind];
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
 * distribution unchanged and plans a selector reset; `single` lets the
 * selector plan one active uplink from everything the mode and administrative
 * filters allow.
 */
export function applyClientUplinkPolicy<T extends ActiveUplinkCandidate>(
	candidates: readonly T[],
	selector: ActiveUplinkSelector,
	context: ActiveUplinkContext,
): ActiveUplinkPlan<T> {
	if (context.policy.selection === "spread")
		return {
			candidates: applySharingPolicy(candidates, context.policy),
			next: undefined,
		};
	return selector.plan(
		candidates.filter(({ uplink }) =>
			sharingPolicyAllows(uplink, context.policy),
		),
		context,
	);
}

export const activeUplinkSelector = new ActiveUplinkSelector();

/**
 * Plans keyed by the prepared state they were built into. A state without an
 * entry (no client zone, spread, no policy) commits as a reset.
 */
const plannedStates = new WeakMap<object, ActiveUplinkState | undefined>();

export function recordSelectorPlan(
	prepared: object,
	next: ActiveUplinkState | undefined,
): void {
	plannedStates.set(prepared, next);
}

/** Called once `prepared` is the applied, verified steering state. */
export function commitSelectorPlan(
	prepared: object,
	selector: ActiveUplinkSelector = activeUplinkSelector,
): void {
	selector.commit(plannedStates.get(prepared));
}
