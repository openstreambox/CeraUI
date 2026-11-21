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
 * - Only the general-internet probe qualifies an uplink. Sender (SRTLA)
 *   telemetry proves the path to the relay, not internet for clients: it can
 *   demote an uplink (degraded, down), never qualify one. The health engine
 *   records which kind of evidence it saw (`signals.probeSince`).
 * - Failover is immediate: when the active uplink leaves the candidate set
 *   (health `down` after a hard loss or a failed-probe blackhole, interface
 *   gone, policy exclusion) the best remaining probe-confirmed candidate
 *   takes over in the same reconcile. With none, nothing is selected and new
 *   client flows are dropped until a probe confirms one. The first pick
 *   follows the same rule.
 * - Rejoin is held: a better-ranked uplink displaces a working active one
 *   only after an unbroken run of probe successes covers the rejoin hold.
 *   Each failure while active doubles that uplink's next hold, up to a cap,
 *   so a flapping link cannot keep pulling clients back.
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
	 * Oldest probe success that still confirms an uplink (three 5 s rounds,
	 * the health telemetry expiry). The health engine applies the same bound
	 * between two successes of one run.
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

/**
 * A probe run as the selector counts it, in probe timestamps. `since` is the
 * producer's run start, or later when the run predates the identity now on
 * that interface name.
 */
interface Proof {
	readonly runSince: number;
	readonly since: number;
	readonly lastAt: number;
}

/** The identity last seen on an interface name, and since when. */
interface Incarnation {
	readonly identity: string;
	readonly since: number;
}

export interface ActiveUplinkState {
	readonly active?: { readonly identity: string; readonly ifname: string };
	readonly activeSince: number;
	readonly proofs: ReadonlyMap<string, Proof>;
	readonly penalties: ReadonlyMap<string, Penalty>;
	/** Per interface name, to ignore a predecessor device's probe run. */
	readonly incarnations: ReadonlyMap<string, Incarnation>;
}

const EMPTY_STATE: ActiveUplinkState = {
	activeSince: 0,
	proofs: new Map(),
	penalties: new Map(),
	incarnations: new Map(),
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
		const incarnations = trackIncarnations(
			prior.incarnations,
			candidates,
			context,
		);
		const proofs = trackProofs(prior.proofs, incarnations, candidates, context);
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
			// First pick or failover: only an uplink the probe currently
			// confirms. A candidate judged only from sender telemetry, or not
			// yet probed, waits; with none confirmed nothing is selected.
			chosen = usable
				.filter(({ uplink }) => proofs.has(uplink.identity))
				.sort((a, b) => compare(a, b, context))[0];
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
				incarnations,
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
 * The current run of general-internet probe successes on `ifname`, if it is
 * still confirming: not `down`, unexpired, and its latest success recent.
 * Sender telemetry never starts or extends a run (see the health engine), so
 * a link judged only from SRTLA rows has none.
 */
function probeRun(
	ifname: string,
	{ health, now }: ActiveUplinkContext,
): { readonly since: number; readonly lastAt: number } | undefined {
	const record = health.get(ifname);
	const since = record?.signals.probeSince;
	const lastAt = record?.signals.activeAt;
	if (
		record === undefined ||
		record.state === "down" ||
		record.staleAt <= now ||
		since === undefined ||
		lastAt === undefined ||
		lastAt < since ||
		now - lastAt > ACTIVE_UPLINK_CONFIG.maxProbeGapMs
	)
		return undefined;
	return { since, lastAt };
}

/**
 * Remembers which identity sits on each interface name. A different identity
 * on a known name is a replacement and starts its own incarnation; a name
 * the selector has not tracked yet (first plan, after a reset) trusts the
 * producer, which restarts the run on every interface change it sees.
 */
function trackIncarnations(
	prior: ReadonlyMap<string, Incarnation>,
	candidates: readonly ActiveUplinkCandidate[],
	{ interfaces, now }: ActiveUplinkContext,
): Map<string, Incarnation> {
	const next = new Map([...prior].filter(([ifname]) => interfaces.has(ifname)));
	for (const { uplink } of candidates) {
		const before = prior.get(uplink.ifname);
		next.set(
			uplink.ifname,
			before === undefined
				? { identity: uplink.identity, since: Number.NEGATIVE_INFINITY }
				: before.identity === uplink.identity
					? before
					: { identity: uplink.identity, since: now },
		);
	}
	return next;
}

/**
 * The health engine owns run continuity: it sees every probe round, so a
 * coalesced reconcile, a skipped round or a failure between two samples
 * cannot hide a break. The selector only clips a run that started before the
 * identity now on that name appeared, starting it at the first success it
 * observes for the new identity.
 */
function trackProofs(
	prior: ReadonlyMap<string, Proof>,
	incarnations: ReadonlyMap<string, Incarnation>,
	candidates: readonly ActiveUplinkCandidate[],
	context: ActiveUplinkContext,
): Map<string, Proof> {
	const proofs = new Map<string, Proof>();
	for (const { uplink } of candidates) {
		const run = probeRun(uplink.ifname, context);
		if (run === undefined) continue;
		const appeared =
			incarnations.get(uplink.ifname)?.since ?? Number.NEGATIVE_INFINITY;
		let since = run.since;
		if (since < appeared) {
			if (run.lastAt < appeared) continue;
			const before = prior.get(uplink.identity);
			since = before?.runSince === run.since ? before.since : run.lastAt;
		}
		proofs.set(uplink.identity, {
			runSince: run.since,
			since,
			lastAt: run.lastAt,
		});
	}
	return proofs;
}

/** The hold must be covered end to end by one unbroken probe run. */
function rejoinReady(
	{ uplink }: ActiveUplinkCandidate,
	proofs: ReadonlyMap<string, Proof>,
	penalties: ReadonlyMap<string, Penalty>,
): boolean {
	const proof = proofs.get(uplink.identity);
	return (
		proof !== undefined &&
		proof.lastAt - proof.since >= holdFor(uplink.identity, penalties)
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

/**
 * Called once `prepared` is the live steering state: its ruleset installed
 * (the applier reports that, even when a later step fails) or read back.
 * `undefined` (client forwarding off) resets.
 */
export function commitSelectorPlan(
	prepared: object | undefined,
	selector: ActiveUplinkSelector = activeUplinkSelector,
): void {
	selector.commit(
		prepared === undefined ? undefined : plannedStates.get(prepared),
	);
}
