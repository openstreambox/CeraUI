/**
 * The sender's per-link view, reduced to what the roaming proof reads, and
 * mapped onto radios.
 *
 * The arrival-report field names come from irlserver/srtla_send#30, which is
 * not merged upstream yet. They are read here and nowhere else, so a rename is
 * a one-file change.
 *
 * Pure: snapshots in, samples out.
 */

import type { SenderLinkStats, SenderStats } from "@ceraui/srtla-send/control";

/** One link in one snapshot, as the proof reads it. */
export type LinkSample = Readonly<{
	/** `srtla_ack_epoch`: totals and age compare only within one epoch. */
	epoch: number;
	connected: boolean;
	timedOut: boolean;
	/** `data_packets_queued_total` */
	queued: number;
	/** `srtla_ack_entries_total` */
	entries: number;
	/** `last_srtla_ack_age_ms`, `null` before the first ACK of the epoch. */
	ageMs: number | null;
	rttMs: number;
	/** Any flag that means the sender itself is holding the link back. */
	gated: boolean;
	/** Which flag, for logs. */
	gatedBy: string | null;
	/** Per-link capacity estimate, `null` when the sender reports none (0). */
	ccTargetBps: number | null;
	ccLossPermille: number | null;
}>;

/** One `get_stats` snapshot, keyed by radio. */
export type Snapshot = Readonly<{
	at: number;
	/** Links mapped to radios. */
	radios: ReadonlyMap<string, LinkSample>;
	/**
	 * Links with arrival reports that map to no radio (cellular, Ethernet),
	 * keyed by `link_id`, `iface`, `ip` or `conn_id`, in that order.
	 */
	others: ReadonlyMap<string, LinkSample>;
	negotiatedLatencyMs: number | null;
}>;

export type RadioAddresses = Readonly<{
	ifname: string;
	/** The radio's current source addresses, as the IP list writes them. */
	addresses: readonly string[];
}>;

/**
 * Whether a link carries arrival reports. Judged by the epoch or the totals,
 * never by the age, which is absent before the first ACK.
 */
export function hasArrivalReports(link: SenderLinkStats): boolean {
	return (
		link.srtla_ack_epoch !== undefined &&
		link.data_packets_queued_total !== undefined &&
		link.srtla_ack_entries_total !== undefined
	);
}

const GATING_FLAGS = [
	"stall_gated",
	"weak",
	"sole_carrier_excluded",
	"in_flight_cap_active",
] as const;

export function toLinkSample(link: SenderLinkStats): LinkSample | undefined {
	if (!hasArrivalReports(link)) return undefined;
	const gatedBy = GATING_FLAGS.find((flag) => link[flag] === true) ?? null;
	return {
		epoch: link.srtla_ack_epoch as number,
		connected: link.connected,
		timedOut: link.timed_out,
		queued: link.data_packets_queued_total as number,
		entries: link.srtla_ack_entries_total as number,
		ageMs: link.last_srtla_ack_age_ms ?? null,
		rttMs: link.rtt_ms,
		gated: gatedBy !== null,
		gatedBy,
		ccTargetBps:
			link.cc_target_bps !== undefined && link.cc_target_bps > 0
				? link.cc_target_bps
				: null,
		ccLossPermille: link.cc_loss_permille ?? null,
	};
}

function linkKey(link: SenderLinkStats): string {
	return link.link_id ?? link.iface ?? link.ip ?? `conn:${link.conn_id}`;
}

/**
 * Map the sender's links onto radios: by `iface` when the sender reports one,
 * otherwise by the source address. A link that matches two radios, or a radio
 * matched by two links, is left out: a wrong attribution is worse than none.
 * `undefined` when the sender reports no arrival counters at all.
 */
export function snapshotOf(
	stats: SenderStats,
	radios: readonly RadioAddresses[],
	at: number,
): Snapshot | undefined {
	const withReports = stats.links.filter(hasArrivalReports);
	if (withReports.length === 0) return undefined;
	const claims = new Map<string, LinkSample[]>();
	const others = new Map<string, LinkSample>();
	for (const link of withReports) {
		const sample = toLinkSample(link) as LinkSample;
		const owners = radios.filter((r) =>
			link.iface !== undefined
				? link.iface === r.ifname
				: link.ip !== undefined && r.addresses.includes(link.ip),
		);
		if (owners.length === 1) {
			const ifname = (owners[0] as RadioAddresses).ifname;
			claims.set(ifname, [...(claims.get(ifname) ?? []), sample]);
		} else if (owners.length === 0) others.set(linkKey(link), sample);
	}
	const mapped = new Map<string, LinkSample>();
	for (const [ifname, samples] of claims)
		if (samples.length === 1) mapped.set(ifname, samples[0] as LinkSample);
	return {
		at,
		radios: mapped,
		others,
		negotiatedLatencyMs:
			stats.negotiated_latency_ms !== undefined &&
			stats.negotiated_latency_ms > 0
				? stats.negotiated_latency_ms
				: null,
	};
}
