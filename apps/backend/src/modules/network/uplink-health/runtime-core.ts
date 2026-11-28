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
		const passive = this.#passiveIfaces(now, round);
		const candidates = this.#deps.candidates(interfaces);

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
			(candidate) => !passive.has(candidate.name),
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
				const outcomes = await Promise.all(
					batch.map((candidate) =>
						this.#deps.probe(
							candidate,
							targets.get(candidate.ip.includes(":") ? 6 : 4) as string,
						),
					),
				);
				for (const [index, candidate] of batch.entries()) {
					if (!isCurrent(candidate)) continue;
					this.#observe(
						{
							iface: candidate.name,
							...this.#deps.identity(candidate.name),
							outcome: outcomes[index] ?? "failure",
							now,
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

	#observe(observation: UplinkObservation, round: number): void {
		const sample = this.#samples.get(observation.iface);
		if (sample) sample.round = round;
		this.#engine.observe(observation);
	}

	#passiveIfaces(now: number, round: number): ReadonlySet<string> {
		const passive = new Set<string>();
		if (!this.#deps.streaming()) {
			this.#recentNaks.clear();
			return passive;
		}
		const telemetry = this.#deps.telemetry();
		if (!telemetry) {
			this.#recentNaks.clear();
			return passive;
		}
		const seen = new Set<string>();
		const observations = new Map<string, UplinkHealthOutcome>();
		for (const link of telemetry.links) {
			// Stale sender rows must not recreate pruned missing history.
			if (!this.#deps.interfaces()[link.iface]) continue;
			// Down paths need active recovery; passive degradation resets the streak.
			if (this.#engine.get(link.iface)?.state === "down") continue;
			passive.add(link.iface);
			const expired =
				now - telemetry.lastReadMs >= UPLINK_HEALTH_CONFIG.telemetryExpiryMs;
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
		for (const [iface, outcome] of observations) {
			this.#observe(
				{ iface, ...this.#deps.identity(iface), outcome, now },
				round,
			);
		}
		return passive;
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
