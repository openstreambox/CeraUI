import type { LinkTelemetryMessage } from "@ceraui/rpc/schemas";
import type { LinkSignal } from "$lib/types/hud";

export const IDLE_HOLD_MS = 20_000;
export const SAMPLE_GAP_MS = 5_000;
// Allow transport keepalives, but never call a useful media rate idle.
const QUIET_BPS = 1024;

type Sample = {
	since: number;
	at: number;
	bytes: number | undefined;
	identity: string;
};

/** Observation-only; elapsed time without fresh sender samples is not evidence. */
export class ConnectedIdleDetector {
	private samples = new Map<string, Sample>();
	update(
		now: number,
		live: boolean,
		links: LinkSignal[],
		telemetry: LinkTelemetryMessage | null | undefined,
	): string[] {
		const next = new Map<string, Sample>();
		const idle: string[] = [];
		const eligible = links.filter(
			(link) =>
				link.enabled &&
				link.isConnected &&
				!link.isStale &&
				link.connectionState === "connected",
		);
		if (live)
			for (const link of eligible) {
				const row = telemetry?.links.find((row) => row.iface === link.id);
				const peerCarries = telemetry?.links.some(
					(peer) =>
						peer.iface !== link.id &&
						!peer.stale &&
						(peer.bitrate_bps ?? 0) > QUIET_BPS &&
						eligible.some((link) => link.id === peer.iface),
				);
				if (
					!row ||
					row.stale ||
					row.bitrate_bps === undefined ||
					!Number.isFinite(row.bitrate_bps) ||
					row.bitrate_bps > QUIET_BPS ||
					!peerCarries
				)
					continue;
				const identity = row.link_id ?? row.conn_id;
				const previous = this.samples.get(link.id);
				const continuous =
					previous &&
					previous.identity === identity &&
					now >= previous.at &&
					now - previous.at <= SAMPLE_GAP_MS;
				const bytes = row.bytes_sent_total;
				const delta =
					continuous && bytes !== undefined && previous.bytes !== undefined
						? bytes - previous.bytes
						: undefined;
				const resumed =
					previous !== undefined &&
					delta !== undefined &&
					(delta < 0 || (delta * 8) / ((now - previous.at) / 1000) > QUIET_BPS);
				const since = continuous && !resumed ? previous.since : now;
				next.set(link.id, { since, at: now, bytes, identity });
				if (now - since >= IDLE_HOLD_MS) idle.push(link.id);
			}
		this.samples = next;
		return idle;
	}
}
