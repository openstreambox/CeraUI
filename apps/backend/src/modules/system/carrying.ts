import type { StreamLiveness } from "./disruptive-action-gate.ts";

const HOLD_MS = 120_000;
const DWELL_MS = 20_000;
const MAX_SAMPLE_MS = 10_000;

/** Evidence of client use, independent of the encoder's lifecycle. */
export class CarryingTracker {
	private onChange: (() => void) | undefined;
	bind(onChange: () => void): void {
		this.onChange = onChange;
	}
	activityAt(now: number): number | null {
		return this.lastEvidence === null
			? null
			: Math.min(now, this.lastEvidence + HOLD_MS);
	}
	private sessions = new Map<string, { active: boolean | null; at: number }>();
	private previous: {
		at: number;
		bytes: Readonly<Record<string, number>>;
	} | null = null;
	private aboveSince: number | null = null;
	private lastEvidence: number | null = null;
	private uploadAt: number | null = null;
	private uploadUnknown = false;

	session(source: string, active: boolean | null, now: number): void {
		if (this.sessions.get(source)?.active === true) this.lastEvidence = now;
		this.sessions.set(source, { active, at: now });
		if (active) this.lastEvidence = now;
		this.onChange?.();
	}

	upload(now: number, bytes: Readonly<Record<string, number>> | null): void {
		this.uploadAt = now;
		this.uploadUnknown = bytes === null;
		const previous = this.previous;
		this.previous = bytes === null ? null : { at: now, bytes };
		if (
			!previous ||
			!bytes ||
			now <= previous.at ||
			now - previous.at > MAX_SAMPLE_MS
		) {
			this.aboveSince = null;
			return;
		}
		let delta = 0;
		for (const [name, count] of Object.entries(bytes)) {
			const old = previous.bytes[name];
			if (!Number.isSafeInteger(count) || count < 0) {
				this.uploadUnknown = true;
				this.aboveSince = null;
				return;
			}
			if (old !== undefined && count >= old) delta += count - old;
		}
		if ((delta * 8 * 1000) / (now - previous.at) > 1_000_000) {
			this.aboveSince ??= previous.at;
			if (now - this.aboveSince >= DWELL_MS) this.lastEvidence = now;
		} else this.aboveSince = null;
	}

	read(now: number): StreamLiveness {
		let unknown =
			this.aboveSince !== null ||
			this.uploadUnknown ||
			(this.uploadAt !== null && now - this.uploadAt > MAX_SAMPLE_MS);
		for (const { active } of this.sessions.values()) {
			if (active === null) unknown = true;
			else if (active) return "streaming";
		}
		if (this.lastEvidence !== null && now - this.lastEvidence < HOLD_MS)
			return "streaming";
		return unknown ? "unknown" : "idle";
	}
}

export const carryingTracker = new CarryingTracker();
export const getCarryingLiveness = (): StreamLiveness =>
	carryingTracker.read(performance.now());
