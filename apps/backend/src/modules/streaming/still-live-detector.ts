import {
	AUDIO_METER_STALE_MS,
	INITIAL_METER_FRESHNESS,
	isDigitalSilence,
	isMeterStale,
	type MeterFreshness,
	trackMeterFreshness,
} from "@ceraui/rpc/audio-meter-liveness";
import type { ActiveEncode, AudioLevelMessage } from "@ceraui/rpc/schemas";

export const LIVE_SILENCE_HOLD_MS = 10_000;
export const LIVE_CAMERA_HOLD_MS = 5_000;
/** The synthetic standby leg is known even on a status without a capture block. */
export function isLiveNoticeSuppressed(
	virtualSource: boolean,
	active: ActiveEncode | null,
): boolean {
	return (
		virtualSource ||
		active?.capture?.state === "standby" ||
		active?.active_input === "standby"
	);
}

export type LiveNotice = "camera" | "silence";
export interface LiveNoticeContext {
	streaming: boolean;
	/** Intentional silence, privacy or BRB; never alarm about the operator's choice. */
	suppressed: boolean;
	/** Audio-only mute must not hide a real camera outage. */
	audioSuppressed?: boolean;
	cameraStopped: boolean;
	/** Selection changes begin a new hold, even if both sources are silent. */
	selection: string;
}
export interface LiveNoticeDeps {
	context(): LiveNoticeContext;
	publish(notice: LiveNotice, active: boolean): void;
	now(): number;
	setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
	clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

/** Only the streaming-owner program meter can establish silence, never the idle sidecar. */
export class StillLiveDetector {
	private cameraSince: number | undefined;
	private silenceSince: number | undefined;
	private lastAudioAt: number | undefined;
	private freshness: MeterFreshness = INITIAL_METER_FRESHNESS;
	private selection: string | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private active = new Set<LiveNotice>();
	constructor(private readonly deps: LiveNoticeDeps) {}
	private publish(notice: LiveNotice, active: boolean): void {
		if (this.active.has(notice) === active) return;
		if (active) this.active.add(notice);
		else this.active.delete(notice);
		this.deps.publish(notice, active);
	}
	update(level?: AudioLevelMessage): void {
		if (this.timer !== undefined) this.deps.clearTimer(this.timer);
		this.timer = undefined;
		const now = this.deps.now();
		const context = this.deps.context();
		if (
			!context.streaming ||
			context.suppressed ||
			context.selection !== this.selection
		) {
			this.cameraSince = undefined;
			this.silenceSince = undefined;
			this.lastAudioAt = undefined;
			this.freshness = INITIAL_METER_FRESHNESS;
			this.publish("camera", false);
			this.publish("silence", false);
		}
		this.selection = context.selection;
		if (!context.streaming || context.suppressed) return;
		this.cameraSince = context.cameraStopped
			? (this.cameraSince ?? now)
			: undefined;
		if (level !== undefined) {
			const program =
				level.source?.owner === "streaming" && level.unavailable !== true;
			this.freshness = trackMeterFreshness(this.freshness, level, now);
			const silent =
				program &&
				(level.channels ?? 0) > 0 &&
				(level.peak_db?.length ?? 0) >= (level.channels ?? 0) &&
				level.peak_db?.every(Number.isFinite) === true &&
				isDigitalSilence(level);
			this.silenceSince = silent ? (this.silenceSince ?? now) : undefined;
			this.lastAudioAt = program ? now : undefined;
		}
		// A missing/frozen meter proves an observation gap, not silent encoded audio.
		if (
			context.audioSuppressed === true ||
			this.lastAudioAt === undefined ||
			now - this.lastAudioAt >= AUDIO_METER_STALE_MS ||
			isMeterStale(this.freshness, now)
		)
			this.silenceSince = undefined;
		this.publish(
			"camera",
			this.cameraSince !== undefined &&
				now - this.cameraSince >= LIVE_CAMERA_HOLD_MS,
		);
		this.publish(
			"silence",
			this.silenceSince !== undefined &&
				now - this.silenceSince >= LIVE_SILENCE_HOLD_MS,
		);
		const deadlines = [
			this.cameraSince === undefined || this.active.has("camera")
				? undefined
				: this.cameraSince + LIVE_CAMERA_HOLD_MS,
			this.silenceSince === undefined || this.active.has("silence")
				? undefined
				: this.silenceSince + LIVE_SILENCE_HOLD_MS,
			this.silenceSince === undefined
				? undefined
				: (this.lastAudioAt ?? now) + AUDIO_METER_STALE_MS,
		].filter((value): value is number => value !== undefined && value > now);
		if (deadlines.length)
			this.timer = this.deps.setTimer(
				() => this.update(),
				Math.min(...deadlines) - now,
			);
	}
	reset(): void {
		if (this.timer !== undefined) this.deps.clearTimer(this.timer);
		this.timer = undefined;
		this.cameraSince = this.silenceSince = this.lastAudioAt = undefined;
		this.selection = undefined;
		this.freshness = INITIAL_METER_FRESHNESS;
		for (const notice of [...this.active]) this.publish(notice, false);
	}
}
