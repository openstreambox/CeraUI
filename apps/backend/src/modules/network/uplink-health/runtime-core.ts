/** Effect-free runtime: construction only stores caller-owned ports and state.
 * No application configuration, timers, probes or publication run on import.
 * Production callers use runtime.ts, which supplies the application adapters.
 */
import type { buildLinkTelemetry } from "../../streaming/link-telemetry.ts";
import type { ProbeCandidate } from "../connectivity-candidates.ts";
import type { NetworkInterface } from "../network-interfaces.ts";
import type { UplinkIdentity } from "../uplink-identity.ts";
import type { ConnectivityTargetResolver } from "./connectivity-target.ts";
import {
	UPLINK_HEALTH_CONFIG,
	UplinkHealthEngine,
	type UplinkHealthOutcome,
	type UplinkHealthRecord,
	type UplinkObservation,
} from "./model.ts";
import { RecentNaks } from "./recent-naks.ts";

export interface UplinkHealthRuntimeCoreDeps {
	readonly onInterfacesChange?: (callback: () => void) => () => void;
	readonly now: () => number;
	readonly interfaces: () => Record<string, NetworkInterface>;
	readonly streaming: () => boolean;
	readonly telemetry: typeof buildLinkTelemetry;
	/**
	 * The address the round's probes are aimed at, or `undefined` when it could
	 * not be established. `undefined` SKIPS the active probe round — see `tick`.
	 */
	readonly resolveTarget: ConnectivityTargetResolver;
	/**
	 * One device-bound probe. `remoteAddr` is the RESOLVED connectivity-check
	 * address, never a hardcoded literal and never a gateway: the probe asserts
	 * `internet.ts`'s 204-with-empty-body contract, so it has to be aimed at
	 * something that actually serves it.
	 */
	readonly probe: (
		candidate: ProbeCandidate,
		remoteAddr: string,
	) => Promise<UplinkHealthOutcome>;
	readonly publish: (records: readonly UplinkHealthRecord[]) => void;
	readonly exclusionReason: (
		entry: NetworkInterface | undefined,
	) => string | undefined;
	readonly candidates: (
		interfaces: Record<string, NetworkInterface>,
	) => ProbeCandidate[];
	readonly identity: (iface: string) => UplinkIdentity;
	readonly notify?: (records: readonly UplinkHealthRecord[]) => void;
	/**
	 * Milliseconds since stream data last went out on the interface
	 * (`linkQuietForMs`), `undefined` without fresh evidence. Without this port
	 * no streamed link is promoted to an active check.
	 */
	readonly quietForMs?: (iface: string) => number | undefined;
	/** Monotonic milliseconds for the probe budget (default `performance.now`). */
	readonly monotonicNow?: () => number;
	/** Another address of the family than `failed`, when the resolver has one. */
	readonly alternateTarget?: (
		family: 4 | 6,
		failed: string,
	) => string | undefined;
	/** A check at `target` failed: the resolver may look the name up again. */
	readonly targetFailed?: (family: 4 | 6, target: string) => void;
}

export class UplinkHealthRuntimeCore {
	readonly #engine: UplinkHealthEngine;
	readonly #deps: UplinkHealthRuntimeCoreDeps;
	#lastJson = "";
	readonly #recentNaks = new Map<
		string,
		{
			ip: string | undefined;
			generation: number | undefined;
			counter: RecentNaks;
		}
	>();
	/** Streaming check tokens per interface (`streamingProbeBudget`). */
	readonly #budget = new Map<
		string,
		{ tokens: number; reserve: number; at: number }
	>();
	#round = 0;
	#completedRound = 0;
	#generation = 0;
	#unsubscribe: (() => void) | undefined;
	readonly #samples = new Map<
		string,
		{
			readonly present: boolean;
			readonly ip: string | undefined;
			readonly eligible: boolean;
			readonly generation: number;
			round: number;
		}
	>();

	constructor(
		deps: UplinkHealthRuntimeCoreDeps,
		engine: UplinkHealthEngine = new UplinkHealthEngine(),
	) {
		this.#engine = engine;
		this.#deps = deps;
	}

	async tick(): Promise<void> {
		// Subscribe on first use: the netif import graph cycles back here before
		// its event emitter is initialized.
		this.#unsubscribe ??= this.#deps.onInterfacesChange?.(() =>
			this.#sampleInterfaces(this.#deps.interfaces(), this.#deps.now()),
		);
		const round = ++this.#round;
		const now = this.#deps.now();
		const interfaces = this.#deps.interfaces();
		const present = new Set(Object.keys(interfaces));
		this.#engine.removeMissing(present, now);
		this.#sampleInterfaces(interfaces);
		const { passive, fresh } = this.#passiveEvidence(now);
		const candidates = this.#deps.candidates(interfaces);
		// A streamed link that sends no payload has no passive evidence either
		// way: a black hole returns no NAKs, its RTT freezes and its row stays
		// fresh, so the row alone would keep it `up` for as long as the stream
		// runs. Once no payload went out on it for `streamingQuietMs` (on fresh,
		// current rows; duplicate probes and keepalives are no payload), or once
		// health has it down, its own probe decides instead, within the link's
		// probe budget. A link that sent
		// payload recently keeps its passive verdict, down or not: it works.
		// Without a token the round is held: nothing is recorded, so the last
		// real verdict and its failure streak stand.
		const promoted = new Set<string>();
		const held = new Set<string>();
		for (const candidate of candidates) {
			const iface = candidate.name;
			if (!passive.has(iface) || promoted.has(iface) || held.has(iface))
				continue;
			const quiet = this.#deps.quietForMs?.(iface);
			const down = this.#engine.get(iface)?.state === "down";
			if (quiet !== undefined && quiet < UPLINK_HEALTH_CONFIG.streamingQuietMs)
				continue;
			if (!down && !(fresh.has(iface) && quiet !== undefined)) continue;
			const record = this.#engine.get(iface);
			const failing = down || (record?.probes.failures ?? 0) > 0;
			(this.#takeToken(iface, quiet, failing) ? promoted : held).add(iface);
		}
		for (const [iface, outcome] of passive) {
			if (promoted.has(iface)) continue;
			if (held.has(iface)) {
				this.#engine.touch(iface, now);
				continue;
			}
			this.#observe(
				{ iface, ...this.#deps.identity(iface), outcome, now },
				round,
			);
		}

		for (const iface of present) {
			const entry = interfaces[iface];
			if (!(entry?.ip ?? entry?.ipv6)) {
				this.#observe(
					{
						iface,
						...this.#deps.identity(iface),
						outcome: "definitive_loss",
						now,
					},
					round,
				);
			}
		}

		const active = candidates.filter(
			(candidate) =>
				!passive.has(candidate.name) || promoted.has(candidate.name),
		);
		const generations = new Map(
			active.map((candidate) => [
				candidate.name,
				this.#samples.get(candidate.name)?.generation,
			]),
		);
		// Candidate addresses are primitive snapshots, independent of the mutable
		// netif entries. A newer observation or completed tick owns later evidence;
		// merely starting another slow round must not starve current probes.
		const isCurrent = (candidate: ProbeCandidate): boolean => {
			const entry = this.#deps.interfaces()[candidate.name];
			return (
				round >= this.#completedRound &&
				round >= (this.#samples.get(candidate.name)?.round ?? 0) &&
				generations.get(candidate.name) ===
					this.#samples.get(candidate.name)?.generation &&
				(entry?.ip ?? entry?.ipv6) === candidate.ip &&
				this.#deps.exclusionReason(entry) === undefined
			);
		};
		// An unresolvable check address is a statement about DNS, not about any
		// uplink, so the ACTIVE round is skipped whole rather than recording a
		// failure nothing measured. The passive telemetry and address-loss
		// observations above are independent evidence and still stand.
		const targets = new Map<4 | 6, string>();
		for (const family of new Set(
			active.map((candidate): 4 | 6 => (candidate.ip.includes(":") ? 6 : 4)),
		)) {
			const target = await this.#deps.resolveTarget(family);
			if (target !== undefined) targets.set(family, target);
		}
		// Without a check address for its family a promoted link is held, like
		// a link without a token: its last real verdict stands.
		for (const candidate of active) {
			if (
				promoted.has(candidate.name) &&
				!targets.has(candidate.ip.includes(":") ? 6 : 4)
			)
				this.#engine.touch(candidate.name, now);
		}
		if (targets.size > 0) {
			for (
				let offset = 0;
				offset < active.length;
				offset += UPLINK_HEALTH_CONFIG.maxConcurrentProbes
			) {
				const batch = active
					.slice(offset, offset + UPLINK_HEALTH_CONFIG.maxConcurrentProbes)
					.filter(
						(candidate) =>
							isCurrent(candidate) &&
							targets.has(candidate.ip.includes(":") ? 6 : 4),
					);
				// Timed only for streamed links: the clock port may count its reads.
				const timed = batch.some((candidate) => promoted.has(candidate.name));
				const sentAt = timed ? this.#deps.now() : 0;
				const outcomes = await Promise.all(
					batch.map((candidate) =>
						this.#checkOnce(
							candidate,
							targets.get(candidate.ip.includes(":") ? 6 : 4) as string,
						),
					),
				);
				const elapsed = timed ? Math.max(0, this.#deps.now() - sentAt) : 0;
				for (const [index, candidate] of batch.entries()) {
					if (!isCurrent(candidate)) continue;
					let outcome = outcomes[index] ?? "failure";
					let probed = true;
					// A failed check of a streamed link does not count when the
					// sender saw payload go out on it during the check: the path
					// works, and its passive verdict stands.
					const quiet = this.#deps.quietForMs?.(candidate.name);
					if (
						promoted.has(candidate.name) &&
						outcome !== "success" &&
						quiet !== undefined &&
						quiet < UPLINK_HEALTH_CONFIG.streamingQuietMs + elapsed
					) {
						const fallback = passive.get(candidate.name);
						if (fallback === undefined) continue;
						outcome = fallback;
						probed = false;
					}
					this.#observe(
						{
							iface: candidate.name,
							...this.#deps.identity(candidate.name),
							outcome,
							now,
							probed,
						},
						round,
					);
				}
			}
		}
		this.#completedRound = Math.max(this.#completedRound, round);
		const current = this.#deps.interfaces();
		for (const [iface, sample] of this.#samples) {
			if (!current[iface] && sample.round <= this.#completedRound) {
				this.#samples.delete(iface);
			}
		}
		for (const iface of this.#budget.keys()) {
			if (!current[iface]) this.#budget.delete(iface);
		}
		this.#publishIfChanged();
	}

	records(): readonly UplinkHealthRecord[] {
		return this.#engine.list();
	}

	isClientSteeringEligible(iface: string): boolean {
		return this.#engine.isClientSteeringEligible(iface);
	}

	dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	#sampleInterfaces(
		interfaces: Record<string, NetworkInterface>,
		changedAt?: number,
	): void {
		for (const iface of new Set([
			...Object.keys(interfaces),
			...this.#samples.keys(),
		])) {
			const entry = interfaces[iface];
			const present = entry !== undefined;
			const ip = entry?.ip ?? entry?.ipv6;
			const eligible = this.#deps.exclusionReason(entry) === undefined;
			const previous = this.#samples.get(iface);
			if (
				!previous ||
				previous.present !== present ||
				previous.ip !== ip ||
				previous.eligible !== eligible
			) {
				// Events record even A -> B -> A changes entirely between ticks.
				// Never reuse a generation after removed samples are retired.
				this.#samples.set(iface, {
					present,
					ip,
					eligible,
					generation: ++this.#generation,
					round: this.#round,
				});
				// A tick's initial roster is a sample, not an identity-change event.
				if (changedAt !== undefined) {
					this.#engine.restartRecovery(iface, changedAt);
				}
			}
		}
	}

	/**
	 * One check, retried once at another address of the same family when it
	 * fails: a cached check address can stop answering on its own, and that is
	 * no verdict on the link. A failure also asks the resolver to look again.
	 */
	async #checkOnce(
		candidate: ProbeCandidate,
		target: string,
	): Promise<UplinkHealthOutcome> {
		const outcome = await this.#deps.probe(candidate, target);
		if (outcome !== "failure") return outcome;
		const family: 4 | 6 = candidate.ip.includes(":") ? 6 : 4;
		this.#deps.targetFailed?.(family, target);
		const alternate = this.#deps.alternateTarget?.(family, target);
		return alternate === undefined
			? outcome
			: this.#deps.probe(candidate, alternate);
	}

	/**
	 * Spend one streaming check token for `iface`. The main bucket refills per
	 * hour on the monotonic clock; when it is empty, a link that is already
	 * failing its checks and quiet for `reserveQuietMs` may draw on a small
	 * reserve of its own, so a black hole that starts after a drained bucket
	 * still reaches a recovery decision. A healthy quiet link never touches it.
	 */
	#takeToken(
		iface: string,
		quiet: number | undefined,
		failing: boolean,
	): boolean {
		const budget = UPLINK_HEALTH_CONFIG.streamingProbeBudget;
		const at = (this.#deps.monotonicNow ?? performance.now.bind(performance))();
		const entry = this.#budget.get(iface) ?? {
			tokens: budget.burst,
			reserve: budget.reserveBurst,
			at,
		};
		const elapsed = Math.max(0, at - entry.at);
		const tokens = Math.min(
			budget.burst,
			entry.tokens + (elapsed * budget.perHour) / 3_600_000,
		);
		const reserve = Math.min(
			budget.reserveBurst,
			entry.reserve + (elapsed * budget.reservePerHour) / 3_600_000,
		);
		const fromMain = tokens >= 1;
		const fromReserve =
			!fromMain &&
			failing &&
			reserve >= 1 &&
			quiet !== undefined &&
			quiet >= budget.reserveQuietMs;
		this.#budget.set(iface, {
			tokens: fromMain ? tokens - 1 : tokens,
			reserve: fromReserve ? reserve - 1 : reserve,
			at,
		});
		return fromMain || fromReserve;
	}

	#observe(observation: UplinkObservation, round: number): void {
		const sample = this.#samples.get(observation.iface);
		if (sample) sample.round = round;
		this.#engine.observe(observation);
	}

	/**
	 * Each streamed link's passive verdict for this round, not yet observed, and
	 * the links among them whose rows are fresh and current (no expired
	 * snapshot, no stale row): only those can be judged quiet.
	 */
	#passiveEvidence(now: number): {
		readonly passive: ReadonlyMap<string, UplinkHealthOutcome>;
		readonly fresh: ReadonlySet<string>;
	} {
		const observations = new Map<string, UplinkHealthOutcome>();
		const fresh = new Set<string>();
		const none = { passive: observations, fresh };
		if (!this.#deps.streaming()) {
			this.#recentNaks.clear();
			return none;
		}
		const telemetry = this.#deps.telemetry();
		if (!telemetry) {
			this.#recentNaks.clear();
			return none;
		}
		const seen = new Set<string>();
		const expired =
			now - telemetry.lastReadMs >= UPLINK_HEALTH_CONFIG.telemetryExpiryMs;
		// Any stale row of an interface keeps it on the passive path.
		const staleRow = new Set<string>();
		for (const link of telemetry.links) {
			// Stale sender rows must not recreate pruned missing history.
			if (!this.#deps.interfaces()[link.iface]) continue;
			if (link.stale) staleRow.add(link.iface);
			if (!expired) fresh.add(link.iface);
			const key = JSON.stringify([link.iface, link.link_id ?? link.conn_id]);
			seen.add(key);
			const entry = this.#deps.interfaces()[link.iface];
			const ip = entry?.ip ?? entry?.ipv6;
			const generation = this.#samples.get(link.iface)?.generation;
			let sample = this.#recentNaks.get(key);
			if (!sample || sample.ip !== ip || sample.generation !== generation) {
				sample = { ip, generation, counter: new RecentNaks() };
				this.#recentNaks.set(key, sample);
			}
			// Stale rows never contribute counter deltas. Resume from a baseline.
			const nakDegraded =
				!expired && !link.stale
					? sample.counter.observe(telemetry.lastReadMs, link.nak_count)
					: false;
			if (expired || link.stale) this.#recentNaks.delete(key);
			const degraded =
				link.stale ||
				link.rtt_ms >= UPLINK_HEALTH_CONFIG.passiveRttDegradedMs ||
				nakDegraded;
			const outcome = expired
				? "definitive_loss"
				: degraded
					? "passive_degraded"
					: "success";
			const previous = observations.get(link.iface);
			// Multiple sender connections may share an interface. Its worst evidence
			// wins once per round; a clean sibling cannot overwrite a losing path.
			if (
				previous !== "definitive_loss" &&
				(outcome !== "success" || !previous)
			) {
				observations.set(link.iface, outcome);
			}
		}
		for (const key of this.#recentNaks.keys()) {
			if (!seen.has(key)) this.#recentNaks.delete(key);
		}
		for (const iface of staleRow) fresh.delete(iface);
		return { passive: observations, fresh };
	}

	#publishIfChanged(): void {
		const records = this.#engine.list();
		const json = JSON.stringify(records);
		if (json === this.#lastJson) return;
		this.#lastJson = json;
		this.#deps.notify?.(records);
		this.#deps.publish(records);
	}
}
