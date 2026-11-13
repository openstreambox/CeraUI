import { UPLINK_HEALTH_CONFIG as config } from "./model.ts";

/** One connection's cumulative counter, converted to a bounded recent window. */
export class RecentNaks {
	#last: { at: number; count: number } | undefined;
	#deltas: { at: number; count: number }[] = [];
	#degraded = false;

	observe(at: number, count: number): boolean {
		const last = this.#last;
		if (last && at <= last.at) return this.#degraded;
		if (!Number.isFinite(count) || count < 0) return this.#degraded;
		if (
			!last ||
			count < last.count ||
			at - last.at >= config.telemetryExpiryMs
		) {
			// Unknown history, counter reset or a telemetry gap: establish a baseline.
			// The next observed increase is assessed immediately, including at startup.
			this.#deltas = [];
			this.#degraded = false;
		} else if (count > last.count) {
			// Attribute an interval's delta to its end, conservatively retaining it for
			// a full window even if some loss occurred near the interval's beginning.
			this.#deltas.push({ at, count: count - last.count });
		}
		this.#last = { at, count };
		this.#deltas = this.#deltas.filter(
			(delta) => at - delta.at < config.passiveNakWindowMs,
		);
		const recent = this.#deltas.reduce((sum, delta) => sum + delta.count, 0);
		if (recent >= config.passiveNakDegradedCount) this.#degraded = true;
		else if (recent <= config.passiveNakRecoveredCount) this.#degraded = false;
		return this.#degraded;
	}
}
