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

export interface UplinkHealthRuntimeCoreDeps {
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
	#round = 0;
	#completedRound = 0;
	readonly #samples = new Map<
		string,
		{
			readonly ip: string | undefined;
			readonly eligible: boolean;
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
		const round = ++this.#round;
		const now = this.#deps.now();
		const interfaces = this.#deps.interfaces();
		const present = new Set(Object.keys(interfaces));
		this.#engine.removeMissing(present);
		for (const iface of new Set([...present, ...this.#samples.keys()])) {
			const entry = interfaces[iface];
			const ip = entry?.ip;
			const eligible = this.#deps.exclusionReason(entry) === undefined;
			const previous = this.#samples.get(iface);
			if (!previous || previous.ip !== ip || previous.eligible !== eligible) {
				this.#samples.set(iface, { ip, eligible, round });
			}
		}
		const passive = this.#passiveIfaces(now, round);
		const candidates = this.#deps.candidates(interfaces);

		for (const iface of present) {
			const entry = interfaces[iface];
			if (!entry?.ip) {
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
		// Candidate addresses are primitive snapshots, independent of the mutable
		// netif entries. A newer observation or completed tick owns later evidence;
		// merely starting another slow round must not starve current probes.
		const isCurrent = (candidate: ProbeCandidate): boolean => {
			const entry = this.#deps.interfaces()[candidate.name];
			return (
				round >= this.#completedRound &&
				round >= (this.#samples.get(candidate.name)?.round ?? 0) &&
				entry?.ip === candidate.ip &&
				this.#deps.exclusionReason(entry) === undefined
			);
		};
		// An unresolvable check address is a statement about DNS, not about any
		// uplink, so the ACTIVE round is skipped whole rather than recording a
		// failure nothing measured. The passive telemetry and address-loss
		// observations above are independent evidence and still stand.
		const target =
			active.length > 0 ? await this.#deps.resolveTarget() : undefined;
		if (target !== undefined) {
			for (
				let offset = 0;
				offset < active.length;
				offset += UPLINK_HEALTH_CONFIG.maxConcurrentProbes
			) {
				const batch = active
					.slice(offset, offset + UPLINK_HEALTH_CONFIG.maxConcurrentProbes)
					.filter(isCurrent);
				const outcomes = await Promise.all(
					batch.map((candidate) => this.#deps.probe(candidate, target)),
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

	#observe(observation: UplinkObservation, round: number): void {
		const sample = this.#samples.get(observation.iface);
		if (sample) sample.round = round;
		this.#engine.observe(observation);
	}

	#passiveIfaces(now: number, round: number): ReadonlySet<string> {
		const passive = new Set<string>();
		if (!this.#deps.streaming()) return passive;
		const telemetry = this.#deps.telemetry();
		if (!telemetry) return passive;
		for (const link of telemetry.links) {
			passive.add(link.iface);
			const expired =
				now - telemetry.lastReadMs >= UPLINK_HEALTH_CONFIG.telemetryExpiryMs;
			const degraded =
				link.stale ||
				link.rtt_ms >= UPLINK_HEALTH_CONFIG.passiveRttDegradedMs ||
				link.nak_count >= UPLINK_HEALTH_CONFIG.passiveNakDegradedCount;
			this.#observe(
				{
					iface: link.iface,
					...this.#deps.identity(link.iface),
					outcome: expired
						? "definitive_loss"
						: degraded
							? "passive_degraded"
							: "success",
					now,
				},
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
