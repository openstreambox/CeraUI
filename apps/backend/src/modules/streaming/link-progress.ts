/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
  IS THIS LINK CARRYING THE STREAM?

  A telemetry row only says that srtla_send has the link in its bond. The
  sender keeps a row for every uplink in its IP list until the next reload, so a
  link that never registered (a stale receiver address), or one the sender
  stopped using, still has a fresh row with a plausible RTT. The row's presence
  is therefore no evidence that anything goes out on it.

  Positive evidence ({@link linkMadeProgress}): the link's cumulative
  `bytes_sent_total` moved forward between two sender snapshots, or its
  measured `bitrate_bps` is above zero. srtla_send counts only stream data and
  duplicate probes in both, never registration or keepalives. The same test
  decides "another link carried traffic" for a stale-address restart
  (`link-carrying.ts`).

  Negative evidence must be comparable: the byte counter, present and
  unchanged, in at least two distinct sender snapshots spanning
  LINK_CARRYING_SHOW_MS, with no measured rate. A missing counter, a counter
  that went backwards (the sender rebuilt the link) and a gap in the reports
  all clear the baseline, any verdict and earlier progress, so the link reads
  unknown until new evidence has accumulated. The caller feeds each sender
  snapshot once (it drops repeated reads of the same snapshot). Consecutive
  snapshots must be at most LINK_CARRYING_EVIDENCE_MS apart: a verdict expires
  that long after the last snapshot, and a snapshot that arrives later starts
  every link over, so a sender that went silent never leaves a stale answer
  behind or lends it to the next report.

  Three answers, and only one of them is a claim:
    - `carrying`: progress within the last LINK_CARRYING_SHOW_MS;
    - `not_carrying`: the comparable negative evidence above; it clears only
      after LINK_CARRYING_CLEAR_MS of progress over distinct snapshots;
    - `unknown`: everything else. Nothing should be concluded from it.

  What it cannot tell: whether the receiver hears the link, or whether a link
  without traffic is a deliberate spare. A link the sender keeps sending into a
  black hole advances its bytes until the sender's own stall detection holds
  it out, and a held-out link still gets one duplicate probe per hundred
  packets. A receiver-side counter (SRTLA ACKs that arrived on the link) would
  be the stronger rung when the sender's telemetry carries one.

  Keys: a row is keyed by its minted `link_id`, else by its interface. The
  interface is the one the identity ladder resolved, which is already the modem
  for a CLAT translator's row; a row the ladder could not resolve and whose
  interface is a translator TUN is mapped to its parent here. Queries by
  interface combine every row of that interface: one carrying row means
  carrying, `not_carrying` needs all of them.
*/

export const LINK_CARRYING_SHOW_MS = 5_000;
export const LINK_CARRYING_CLEAR_MS = 2_000;
/** Sender snapshots arrive every second; a verdict older than this is void. */
export const LINK_CARRYING_EVIDENCE_MS = 2_500;

export type LinkCarryingState = "carrying" | "not_carrying" | "unknown";

/** The fields of one rendered telemetry row this module reads. */
export interface LinkProgressRow {
	readonly link_id?: string;
	readonly iface: string;
	readonly bytes_sent_total?: number;
	readonly bitrate_bps?: number;
}

interface LinkTrack {
	iface: string;
	/** The counter's value and when it took it; undefined without a baseline. */
	bytes: number | undefined;
	bytesSinceMs: number;
	/** Distinct snapshots that reported `bytes` unchanged, the first included. */
	unchangedSamples: number;
	lastProgressMs: number | undefined;
	progressSinceMs: number | undefined;
	notCarrying: boolean;
	/** Start of the current quiet span: the baseline or the last progress. */
	quietSinceMs: number;
}

type ParentResolver = (iface: string) => string | undefined;

export function linkCarryingKey(row: LinkProgressRow): string {
	return row.link_id !== undefined ? `id:${row.link_id}` : `if:${row.iface}`;
}

function counterOf(row: LinkProgressRow): number | undefined {
	const bytes = row.bytes_sent_total;
	return typeof bytes === "number" && Number.isFinite(bytes)
		? bytes
		: undefined;
}

/**
 * THE per-row progress test: did this fresh row move stream data since the
 * snapshot that reported `previousBytes`? A measured rate above zero counts on
 * its own; a byte counter counts only once it has a baseline and moved forward
 * (a counter that went backwards is a rebuilt link, i.e. a new baseline).
 */
export function linkMadeProgress(
	row: LinkProgressRow,
	previousBytes: number | undefined,
): boolean {
	const bps = row.bitrate_bps;
	if (typeof bps === "number" && Number.isFinite(bps) && bps > 0) return true;
	const bytes = counterOf(row);
	return (
		bytes !== undefined && previousBytes !== undefined && bytes > previousBytes
	);
}

function freshTrack(iface: string, nowMs: number): LinkTrack {
	return {
		iface,
		bytes: undefined,
		bytesSinceMs: nowMs,
		unchangedSamples: 0,
		lastProgressMs: undefined,
		progressSinceMs: undefined,
		notCarrying: false,
		quietSinceMs: nowMs,
	};
}

/** Fold one row of a new snapshot into its link's track. */
function observeRow(
	track: LinkTrack,
	row: LinkProgressRow,
	nowMs: number,
): void {
	const bytes = counterOf(row);
	const moved = linkMadeProgress(row, track.bytes);
	if (
		bytes === undefined ||
		(track.bytes !== undefined && bytes < track.bytes)
	) {
		// No comparable evidence: forget the baseline, any verdict and the
		// progress the old counter showed. A measured rate below can still
		// make the link carrying again on its own.
		track.notCarrying = false;
		track.quietSinceMs = nowMs;
		track.progressSinceMs = undefined;
		track.lastProgressMs = undefined;
	}
	if (bytes === undefined) {
		track.bytes = undefined;
		track.unchangedSamples = 0;
	} else if (track.bytes === bytes) {
		track.unchangedSamples += 1;
	} else {
		track.bytes = bytes;
		track.bytesSinceMs = nowMs;
		track.unchangedSamples = 1;
	}
	if (moved) {
		track.quietSinceMs = nowMs;
		track.lastProgressMs = nowMs;
		track.progressSinceMs ??= nowMs;
	} else {
		track.progressSinceMs = undefined;
	}
	if (
		!track.notCarrying &&
		!moved &&
		track.bytes !== undefined &&
		track.unchangedSamples >= 2 &&
		nowMs - track.bytesSinceMs >= LINK_CARRYING_SHOW_MS
	) {
		track.notCarrying = true;
	} else if (
		track.notCarrying &&
		track.progressSinceMs !== undefined &&
		nowMs - track.progressSinceMs >= LINK_CARRYING_CLEAR_MS
	) {
		track.notCarrying = false;
	}
}

export class LinkProgressTracker {
	private tracks = new Map<string, LinkTrack>();
	private lastSnapshotMs: number | undefined;

	constructor(private readonly parentOf: ParentResolver = () => undefined) {}

	/** The interface a row's traffic belongs to, translator TUNs folded in. */
	ifaceOf(row: LinkProgressRow): string {
		return this.parentOf(row.iface) ?? row.iface;
	}

	/**
	 * Feed one NEW sender snapshot's rows. The caller drops repeated reads of a
	 * snapshot it already fed; feeding one twice would count as a second sample.
	 */
	observe(rows: readonly LinkProgressRow[], nowMs: number): void {
		// A snapshot after the evidence window is not part of the old chain:
		// every link starts over, as after a reported gap.
		if (!this.current(nowMs)) this.tracks.clear();
		const next = new Map<string, LinkTrack>();
		for (const row of rows) {
			const key = linkCarryingKey(row);
			const iface = this.ifaceOf(row);
			const track =
				next.get(key) ?? this.tracks.get(key) ?? freshTrack(iface, nowMs);
			track.iface = iface;
			observeRow(track, row, nowMs);
			next.set(key, track);
		}
		// A link that left the bond stops resolving.
		this.tracks = next;
		this.lastSnapshotMs = nowMs;
	}

	/**
	 * A stale or missing snapshot breaks the chain of evidence. Every link
	 * starts over, so a gap in the sender's reports never reads as a link that
	 * stopped carrying.
	 */
	markGap(): void {
		this.tracks.clear();
		this.lastSnapshotMs = undefined;
	}

	reset(): void {
		this.markGap();
	}

	private current(nowMs: number): boolean {
		return (
			this.lastSnapshotMs !== undefined &&
			nowMs - this.lastSnapshotMs <= LINK_CARRYING_EVIDENCE_MS
		);
	}

	stateFor(row: LinkProgressRow, nowMs: number): LinkCarryingState {
		const track = this.tracks.get(linkCarryingKey(row));
		return track && this.current(nowMs) ? trackState(track, nowMs) : "unknown";
	}

	/** Combined state of every row whose traffic belongs to `iface`. */
	stateForIface(iface: string, nowMs: number): LinkCarryingState {
		if (!this.current(nowMs)) return "unknown";
		let sawNotCarrying = false;
		let sawUnknown = false;
		for (const track of this.tracks.values()) {
			if (track.iface !== iface) continue;
			const state = trackState(track, nowMs);
			if (state === "carrying") return "carrying";
			if (state === "not_carrying") sawNotCarrying = true;
			else sawUnknown = true;
		}
		return sawNotCarrying && !sawUnknown ? "not_carrying" : "unknown";
	}

	/**
	 * How long no row of `iface` has moved anything, on the tracker's clock:
	 * since its latest progress of any size, or since the start of the
	 * comparable evidence. `undefined` without current evidence for every row.
	 * Diagnostic: uplink health uses it to decide when a streamed link's own
	 * check is worth a look, never to judge the link.
	 */
	quietForIface(iface: string, nowMs: number): number | undefined {
		if (!this.current(nowMs)) return undefined;
		let quietSince: number | undefined;
		for (const track of this.tracks.values()) {
			if (track.iface !== iface) continue;
			if (track.bytes === undefined) return undefined;
			quietSince = Math.max(
				quietSince ?? track.quietSinceMs,
				track.quietSinceMs,
			);
		}
		return quietSince === undefined ? undefined : nowMs - quietSince;
	}

	/** Every interface whose combined state is `not_carrying`, sorted. */
	notCarryingIfaces(nowMs: number): string[] {
		const ifaces = new Set([...this.tracks.values()].map((t) => t.iface));
		return [...ifaces]
			.filter((iface) => this.stateForIface(iface, nowMs) === "not_carrying")
			.sort();
	}
}

function trackState(track: LinkTrack, nowMs: number): LinkCarryingState {
	if (track.notCarrying) return "not_carrying";
	if (
		track.lastProgressMs !== undefined &&
		nowMs - track.lastProgressMs < LINK_CARRYING_SHOW_MS
	)
		return "carrying";
	return "unknown";
}
