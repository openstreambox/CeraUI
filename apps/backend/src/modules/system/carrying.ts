import type { StreamLiveness } from "./disruptive-action-gate.ts";

const HOLD_MS = 120_000;
const DWELL_MS = 20_000;
const MAX_SAMPLE_MS = 10_000;
// TODO: calibrate entry/keep rates against field client traffic.
const ENTRY_BPS = 1_000_000;
const KEEP_BPS = 250_000;

/** Evidence of client use, independent of the encoder's lifecycle. */
export class CarryingTracker {
	private onChange: (() => void) | undefined;
	bind(onChange: () => void): void {
		this.onChange = onChange;
	}
	activityAt(now: number): number | null {
		const held =
			this.lastEvidence === null
				? null
				: Math.min(now, this.lastEvidence + HOLD_MS);
		const startup =
			this.startedUntil === null ? null : Math.min(now, this.startedUntil);
		const activity = [held, startup, this.lastAboveAt].filter(
			(at): at is number => at !== null,
		);
		return activity.length ? Math.max(...activity) : null;
	}
	private sessions = new Map<string, { active: boolean | null; at: number }>();
	private previous: {
		at: number;
		bytes: Readonly<Record<string, number>>;
	} | null = null;
	private aboveSince: number | null = null;
	private lastEvidence: number | null = null;
	private startedUntil: number | null = null;
	private lastAboveAt: number | null = null;
	private uploadAt: number | null = null;
	private uploadUnknown = false;

	/** A fresh hold on every process start also covers a lost pre-restart hold. */
	start(now: number): void {
		this.startedUntil = Math.max(this.startedUntil ?? 0, now + HOLD_MS);
	}

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
		const bps = (delta * 8 * 1000) / (now - previous.at);
		const held =
			this.lastEvidence !== null && now - this.lastEvidence < HOLD_MS;
		if (bps > ENTRY_BPS) this.lastAboveAt = now;
		if (
			bps > ENTRY_BPS ||
			(bps > KEEP_BPS && (held || this.aboveSince !== null))
		) {
			if (held) this.lastEvidence = now;
			this.aboveSince ??= previous.at;
			if (now - this.aboveSince >= DWELL_MS) this.lastEvidence = now;
		} else this.aboveSince = null;
	}

	read(now: number): StreamLiveness {
		let unknown =
			this.aboveSince !== null ||
			(this.startedUntil !== null && now < this.startedUntil) ||
			(this.lastAboveAt !== null && now - this.lastAboveAt < DWELL_MS) ||
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
