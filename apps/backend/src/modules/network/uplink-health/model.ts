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
	/**
	 * While streaming, a bonded link is checked by probe instead of its sender
	 * row only after it sent nothing at all for this long, and a failed check
	 * does not count if the link sent anything during it.
	 */
	streamingQuietMs: 10_000,
	/** How long a round held for want of a token keeps the last evidence fresh. */
	heldFreshMs: 60_000,
	/**
	 * While a stream runs every check is metered, of a link with or without a
	 * sender row: each costs about 1 KB on the link (a second one when the first
	 * address fails). At most `perHour` per link (one per 15 s on average), with
	 * up to `burst` in a row; a link with no payload for `reserveQuietMs` may
	 * also draw on its own reserve, so a black hole that starts after a drained
	 * bucket still gets its checks. Together at most about 0.6 MB per link per
	 * hour. Without a token the round is held and the last verdict stands.
	 */
	streamingProbeBudget: {
		perHour: 240,
		burst: 24,
		reservePerHour: 60,
		reserveBurst: 6,
		reserveQuietMs: 60_000,
	},
} as const;

export type UplinkHealthOutcome =
	| "success"
	| "failure"
	| "captive_portal"
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
	readonly signals: {
		readonly activeAt?: number;
		readonly passiveAt?: number;
	};
}

export interface UplinkObservation {
	readonly iface: string;
	readonly kind: UplinkKind;
	readonly displayName?: string;
	readonly outcome: UplinkHealthOutcome;
	readonly now: number;
	/** The outcome is a probe's own answer, not passive evidence. */
	readonly probed?: boolean;
}

/** The last answer a real probe gave for an interface (not published). */
export interface UplinkProbeEvidence {
	readonly outcome: UplinkHealthOutcome;
	readonly at: number;
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

	readonly #probes = new Map<string, UplinkProbeEvidence>();

	observe(observation: UplinkObservation): UplinkHealthRecord {
		if (observation.probed === true)
			this.#probes.set(observation.iface, {
				outcome: observation.outcome,
				at: observation.now,
			});
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

	/** The last real probe answer for `iface`, if one was recorded. */
	lastProbe(iface: string): UplinkProbeEvidence | undefined {
		return this.#records.has(iface) ? this.#probes.get(iface) : undefined;
	}

	/**
	 * A round that measured nothing for `iface` (no probe budget) keeps its
	 * verdict and streak; only its freshness moves on, never past `notAfter`.
	 */
	touch(iface: string, now: number, notAfter: number): void {
		const entry = this.#records.get(iface);
		if (!entry) return;
		entry.lastSeen = now;
		entry.record = {
			...entry.record,
			staleAt: Math.max(
				entry.record.staleAt,
				Math.min(now + UPLINK_HEALTH_CONFIG.telemetryExpiryMs, notAfter),
			),
		};
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
				this.#probes.delete(iface);
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
			this.#probes.delete(iface);
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
			signals: passive
				? { ...current.signals, passiveAt: observation.now }
				: { ...current.signals, activeAt: observation.now },
		};
	}

	#nextCounters(
		current: UplinkHealthRecord,
		outcome: UplinkHealthOutcome,
	): UplinkHealthRecord["probes"] {
		switch (outcome) {
			case "success":
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
			case "success": {
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
