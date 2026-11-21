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

  The evidence used here is progress ({@link linkMadeProgress}): the link's
  cumulative `bytes_sent_total` advancing between two fresh snapshots, or a
  nonzero measured `bitrate_bps`. srtla_send counts only stream data and
  duplicate probes in both, never registration or keepalives, so a link that is
  up but unused shows neither. The same test decides "another link carried
  traffic" for a stale-address restart (`link-carrying.ts`).

  Three answers, and only one of them is a claim of trouble:
    - `carrying`: the link made progress within the last LINK_CARRYING_SHOW_MS;
    - `not_carrying`: snapshots stayed fresh and the link made no progress for
      LINK_CARRYING_SHOW_MS (or kept failing to for LINK_CARRYING_CLEAR_MS of
      fresh progress after that, so a lone packet does not flip it back);
    - `unknown`: no stream, no fresh snapshot, a snapshot gap, or a link seen
      for less than the dwell. Nothing should be concluded from it.

  What it cannot tell: whether the receiver hears the link. A link the sender
  keeps sending into a black hole advances its bytes until the sender's own
  stall detection holds it out, and a held-out link still gets one duplicate
  probe per hundred packets. A receiver-side counter (SRTLA ACKs that arrived on
  the link) would be the stronger rung when the sender's telemetry carries one.

  Keys: a row is keyed by its minted `link_id`, else by its interface. The
  interface is the one the identity ladder resolved, which is already the modem
  for a CLAT translator's row; a row the ladder could not resolve and whose
  interface is a translator TUN is mapped to its parent here. Queries by
  interface combine every row of that interface: one carrying row means
  carrying, `not_carrying` needs all of them.
*/

export const LINK_CARRYING_SHOW_MS = 5_000;
export const LINK_CARRYING_CLEAR_MS = 2_000;

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
	firstSeenMs: number;
	lastBytes: number | undefined;
	lastProgressMs: number | undefined;
	progressSinceMs: number | undefined;
	notCarrying: boolean;
}

type ParentResolver = (iface: string) => string | undefined;

export function linkCarryingKey(row: LinkProgressRow): string {
	return row.link_id !== undefined ? `id:${row.link_id}` : `if:${row.iface}`;
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
	const bytes = row.bytes_sent_total;
	return (
		typeof bytes === "number" &&
		previousBytes !== undefined &&
		bytes > previousBytes
	);
}

export class LinkProgressTracker {
	private tracks = new Map<string, LinkTrack>();

	constructor(private readonly parentOf: ParentResolver = () => undefined) {}

	/** The interface a row's traffic belongs to, translator TUNs folded in. */
	ifaceOf(row: LinkProgressRow): string {
		return this.parentOf(row.iface) ?? row.iface;
	}

	/** Feed one FRESH snapshot's rows. Call once per snapshot, never per render. */
	observe(rows: readonly LinkProgressRow[], nowMs: number): void {
		const next = new Map<string, LinkTrack>();
		for (const row of rows) {
			const key = linkCarryingKey(row);
			const track = next.get(key) ??
				this.tracks.get(key) ?? {
					iface: this.ifaceOf(row),
					firstSeenMs: nowMs,
					lastBytes: undefined,
					lastProgressMs: undefined,
					progressSinceMs: undefined,
					notCarrying: false,
				};
			const moved = linkMadeProgress(row, track.lastBytes);
			track.iface = this.ifaceOf(row);
			track.lastBytes = row.bytes_sent_total ?? track.lastBytes;
			if (moved) {
				track.lastProgressMs = nowMs;
				track.progressSinceMs ??= nowMs;
			} else {
				track.progressSinceMs = undefined;
			}
			const quietSince = track.lastProgressMs ?? track.firstSeenMs;
			if (!track.notCarrying && nowMs - quietSince >= LINK_CARRYING_SHOW_MS) {
				track.notCarrying = true;
			} else if (
				track.notCarrying &&
				track.progressSinceMs !== undefined &&
				nowMs - track.progressSinceMs >= LINK_CARRYING_CLEAR_MS
			) {
				track.notCarrying = false;
			}
			next.set(key, track);
		}
		// A link that left the bond stops resolving.
		this.tracks = next;
	}

	/**
	 * A stale or missing snapshot breaks the chain of evidence. Every link
	 * starts over, so a gap in the sender's reports never reads as a link that
	 * stopped carrying.
	 */
	markGap(): void {
		this.tracks.clear();
	}

	reset(): void {
		this.tracks.clear();
	}

	stateFor(row: LinkProgressRow, nowMs: number): LinkCarryingState {
		const track = this.tracks.get(linkCarryingKey(row));
		return track ? trackState(track, nowMs) : "unknown";
	}

	/** Combined state of every row whose traffic belongs to `iface`. */
	stateForIface(iface: string, nowMs: number): LinkCarryingState {
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
