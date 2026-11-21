import type {
	UplinkHealthReason,
	UplinkHealthState,
	UplinkKind,
} from "@ceraui/rpc/events";

export type {
	UplinkHealthReason,
	UplinkHealthState,
	UplinkKind,
} from "@ceraui/rpc/events";

export const UPLINK_HEALTH_CONFIG = {
	failedRoundsDown: 3,
	successfulRoundsUp: 5,
	holdDownMs: 15_000,
	probeRoundCadenceMs: 5_000,
	maxConcurrentProbes: 3,
	telemetryExpiryMs: 15_000,
	// Bound churn history while preserving recovery through brief disappearance.
	missingRecordTtlMs: 24 * 60 * 60 * 1_000,
	maxMissingRecords: 32,
	degradedWeight: 25,
	passiveRttDegradedMs: 1_000,
	passiveNakDegradedCount: 25,
	passiveNakWindowMs: 10_000,
} as const;

/**
 * `success`, `failure` and `captive_portal` come only from the device-bound
 * general-internet probe. `passive_healthy` and `passive_degraded` come from
 * sender (SRTLA) telemetry, which proves the path to the relay and nothing
 * more. `definitive_loss` is address or interface loss, or expired telemetry.
 */
export type UplinkHealthOutcome =
	| "success"
	| "failure"
	| "captive_portal"
	| "passive_healthy"
	| "passive_degraded"
	| "definitive_loss";

export interface UplinkHealthRecord {
	readonly iface: string;
	readonly kind: UplinkKind;
	/** Absent whenever the device could not be named. Never invented. */
	readonly displayName?: string;
	readonly state: UplinkHealthState;
	readonly reason?: UplinkHealthReason;
	readonly weight: number;
	readonly lastTransition: number;
	readonly staleAt: number;
	readonly probes: {
		readonly successes: number;
		readonly failures: number;
	};
	/**
	 * Evidence provenance. `probes` counts both probe rounds and healthy
	 * sender rows (the health state machine treats them alike); these say
	 * which kind of evidence was seen and when.
	 */
	readonly signals: {
		/** Last device-bound general-internet probe result, of any outcome. */
		readonly activeAt?: number;
		/** Last sender telemetry or loss observation, of any outcome. */
		readonly passiveAt?: number;
		/**
		 * Start of the current unbroken run of successful general-internet
		 * probes; while set, `activeAt` is the latest of them. A failed or
		 * captive probe, degraded sender telemetry, loss, a new interface
		 * incarnation, or a gap longer than the telemetry expiry between two
		 * probe successes clears it. Healthy sender rows neither start nor
		 * extend it: only the probe can qualify an uplink for client traffic.
		 */
		readonly probeSince?: number;
	};
}

export interface UplinkObservation {
	readonly iface: string;
	readonly kind: UplinkKind;
	readonly displayName?: string;
	readonly outcome: UplinkHealthOutcome;
	readonly now: number;
}

const weightFor = (state: UplinkHealthState): number => {
	switch (state) {
		case "up":
			return 100;
		case "degraded":
			return UPLINK_HEALTH_CONFIG.degradedWeight;
		case "down":
			return 0;
	}
};

const reasonFor = (
	outcome: UplinkHealthOutcome,
): UplinkHealthReason | undefined => {
	switch (outcome) {
		case "success":
		case "passive_healthy":
			return undefined;
		case "failure":
			return "probe_failed";
		case "captive_portal":
			return "captive_portal";
		case "passive_degraded":
			return "passive_congestion";
		case "definitive_loss":
			return "definitive_loss";
	}
};

export class UplinkHealthEngine {
	readonly #records = new Map<
		string,
		{
			record: UplinkHealthRecord;
			lastSeen: number;
			missingSince?: number;
		}
	>();

	observe(observation: UplinkObservation): UplinkHealthRecord {
		const previous = this.#records.get(observation.iface)?.record;
		const current = previous ?? this.#initialRecord(observation);
		const next = this.#reduce(current, observation);
		this.#records.set(observation.iface, {
			record: next,
			lastSeen: observation.now,
		});
		return next;
	}

	get(iface: string): UplinkHealthRecord | undefined {
		return this.#records.get(iface)?.record;
	}

	restartRecovery(iface: string, now: number): void {
		const entry = this.#records.get(iface);
		if (entry?.record.state !== "down") return;
		entry.record = {
			...entry.record,
			lastTransition: now,
			probes: { ...entry.record.probes, successes: 0 },
		};
	}

	/**
	 * A new interface incarnation (address, presence or eligibility changed)
	 * must earn its own probe evidence; the previous one's run does not carry.
	 */
	restartProbeStreak(iface: string): void {
		const entry = this.#records.get(iface);
		if (entry?.record.signals.probeSince === undefined) return;
		const { probeSince: _cleared, ...signals } = entry.record.signals;
		entry.record = { ...entry.record, signals };
	}

	list(): readonly UplinkHealthRecord[] {
		return [...this.#records.values()]
			.map(({ record }) => record)
			.sort((a, b) => a.iface.localeCompare(b.iface));
	}

	removeMissing(ifaces: ReadonlySet<string>, now: number): void {
		const missing: { readonly iface: string; readonly since: number }[] = [];
		for (const [iface, entry] of this.#records) {
			const present = ifaces.has(iface);
			const { record } = entry;
			if (
				(!present || entry.missingSince !== undefined) &&
				(record.state !== "down" ||
					now - entry.lastSeen >= UPLINK_HEALTH_CONFIG.missingRecordTtlMs)
			) {
				this.#records.delete(iface);
				continue;
			}
			if (present) {
				entry.lastSeen = now;
				delete entry.missingSince;
				continue;
			}
			entry.missingSince ??= now;
			entry.record = this.#reduce(record, {
				iface,
				kind: record.kind,
				outcome: "definitive_loss",
				now,
			});
			missing.push({ iface, since: entry.missingSince });
		}
		missing.sort((a, b) => a.since - b.since);
		for (const { iface } of missing.slice(
			0,
			Math.max(0, missing.length - UPLINK_HEALTH_CONFIG.maxMissingRecords),
		)) {
			this.#records.delete(iface);
		}
	}

	isClientSteeringEligible(iface: string): boolean {
		return this.get(iface)?.state !== "down";
	}

	#initialRecord(observation: UplinkObservation): UplinkHealthRecord {
		const { iface, kind, displayName, now } = observation;
		return {
			iface,
			kind,
			...(displayName === undefined ? {} : { displayName }),
			state: "up",
			weight: 100,
			lastTransition: now,
			staleAt: now + UPLINK_HEALTH_CONFIG.telemetryExpiryMs,
			probes: { successes: 0, failures: 0 },
			signals: {},
		};
	}

	#reduce(
		current: UplinkHealthRecord,
		observation: UplinkObservation,
	): UplinkHealthRecord {
		const passive =
			observation.outcome === "passive_healthy" ||
			observation.outcome === "passive_degraded" ||
			observation.outcome === "definitive_loss";
		const probes = this.#nextCounters(current, observation.outcome);
		const state = this.#nextState(current, observation, probes);
		const transitioned = state !== current.state;
		const reason = state === "up" ? undefined : reasonFor(observation.outcome);
		return {
			iface: observation.iface,
			kind: observation.kind,
			// Absence RETRACTS: a device whose marker sweep stopped naming it must
			// stop claiming a name, or a resolved identity latches onto whatever
			// re-enumerates under that interface next.
			...(observation.displayName === undefined
				? {}
				: { displayName: observation.displayName }),
			state,
			...(reason === undefined ? {} : { reason }),
			weight: weightFor(state),
			lastTransition: transitioned ? observation.now : current.lastTransition,
			staleAt: observation.now + UPLINK_HEALTH_CONFIG.telemetryExpiryMs,
			probes,
			signals: this.#nextSignals(current.signals, observation, passive),
		};
	}

	#nextSignals(
		current: UplinkHealthRecord["signals"],
		{ outcome, now }: UplinkObservation,
		passive: boolean,
	): UplinkHealthRecord["signals"] {
		const { probeSince, ...rest } = current;
		if (passive) {
			// Sender rows may only demote: a healthy row keeps the probe run as
			// it is, anything worse ends it.
			const keep = outcome === "passive_healthy" && probeSince !== undefined;
			return { ...rest, passiveAt: now, ...(keep ? { probeSince } : {}) };
		}
		if (outcome !== "success") return { ...rest, activeAt: now };
		const continuous =
			probeSince !== undefined &&
			current.activeAt !== undefined &&
			now - current.activeAt <= UPLINK_HEALTH_CONFIG.telemetryExpiryMs;
		return {
			...rest,
			activeAt: now,
			probeSince: continuous ? probeSince : now,
		};
	}

	#nextCounters(
		current: UplinkHealthRecord,
		outcome: UplinkHealthOutcome,
	): UplinkHealthRecord["probes"] {
		switch (outcome) {
			case "success":
			case "passive_healthy":
				return { successes: current.probes.successes + 1, failures: 0 };
			case "failure":
				return { successes: 0, failures: current.probes.failures + 1 };
			case "captive_portal":
			case "passive_degraded":
			case "definitive_loss":
				return { successes: 0, failures: 0 };
		}
	}

	#nextState(
		current: UplinkHealthRecord,
		observation: UplinkObservation,
		probes: UplinkHealthRecord["probes"],
	): UplinkHealthState {
		switch (observation.outcome) {
			case "captive_portal":
			case "passive_degraded":
				return current.state === "down" ? "down" : "degraded";
			case "definitive_loss":
				return "down";
			case "failure":
				return probes.failures >= UPLINK_HEALTH_CONFIG.failedRoundsDown
					? "down"
					: current.state;
			case "success":
			case "passive_healthy": {
				if (current.state === "up") return "up";
				const dwellMet =
					observation.now - current.lastTransition >=
					UPLINK_HEALTH_CONFIG.holdDownMs;
				return dwellMet &&
					probes.successes >= UPLINK_HEALTH_CONFIG.successfulRoundsUp
					? "up"
					: current.state;
			}
		}
	}
}
