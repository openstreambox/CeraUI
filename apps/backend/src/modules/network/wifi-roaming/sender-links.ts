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
	/** What the sender put on the link lately, bits/s (`bitrate_bytes_per_sec` × 8). */
	bitrateBps: number;
	/** Held out by the stall gate: probes only. */
	stallGated: boolean;
	soleCarrierExcluded: boolean;
	/** The weak-link classifier flags it; `weakReason` says why. */
	weak: boolean;
	weakReason: string | null;
	/**
	 * In flight above 1.5 × BDP at the snapshot: a per-tick queueing bound that
	 * flips on any loaded link. Kept for logs only; it is not "held back".
	 */
	inFlightCapActive: boolean;
	ccLossDegraded: boolean;
	/** Per-link capacity estimate, `null` when the sender reports none (0). */
	ccTargetBps: number | null;
	/**
	 * The per-link CC's state (`bootstrap`, `climbing`, `holding`,
	 * `backing_off`, `drain`), `null` when not reported. A target below the
	 * load says "no headroom" only once the CC has stopped climbing.
	 */
	ccState: string | null;
	ccLossPermille: number | null;
}>;

/**
 * Why the sender is keeping a candidate from carrying its share, or `null`.
 * Such a span can't prove anything.
 */
export function heldBack(s: LinkSample): string | null {
	if (s.stallGated) return "stall_gated";
	if (s.soleCarrierExcluded) return "sole_carrier_excluded";
	if (s.weak) return `weak: ${s.weakReason ?? "unknown"}`;
	return null;
}

/**
 * Why the sender has given up on a holder's path, or `null`: the stall gate,
 * the sole-carrier election, a high-RTT weak flag, or degraded CC loss.
 */
export function holderFailing(s: LinkSample): string | null {
	if (s.stallGated) return "stall_gated";
	if (s.soleCarrierExcluded) return "sole_carrier_excluded";
	if (s.weak && s.weakReason === "high_rtt") return "weak: high_rtt";
	if (s.ccLossDegraded) return "cc_loss_degraded";
	return null;
}

/**
 * The sender prefers a sibling for now (weak with `low_share`, `no_traffic`
 * or any reason other than `high_rtt`): the holder is offered too little to
 * judge, which says nothing about its path.
 */
export function holderSidelined(s: LinkSample): string | null {
	if (s.weak && s.weakReason !== "high_rtt")
		return `weak: ${s.weakReason ?? "unknown"}`;
	return null;
}

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
	/** Radios some link claimed, mapped or left out as ambiguous. */
	claimed: ReadonlySet<string>;
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

export function toLinkSample(link: SenderLinkStats): LinkSample | undefined {
	if (!hasArrivalReports(link)) return undefined;
	return {
		epoch: link.srtla_ack_epoch as number,
		connected: link.connected,
		timedOut: link.timed_out,
		queued: link.data_packets_queued_total as number,
		entries: link.srtla_ack_entries_total as number,
		ageMs: link.last_srtla_ack_age_ms ?? null,
		rttMs: link.rtt_ms,
		bitrateBps: link.bitrate_bytes_per_sec * 8,
		stallGated: link.stall_gated === true,
		soleCarrierExcluded: link.sole_carrier_excluded === true,
		weak: link.weak === true,
		weakReason: link.weak_reason ?? null,
		inFlightCapActive: link.in_flight_cap_active === true,
		ccLossDegraded: link.cc_loss_degraded === true,
		ccTargetBps:
			link.cc_target_bps !== undefined && link.cc_target_bps > 0
				? link.cc_target_bps
				: null,
		ccState: link.cc_state ?? null,
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
	const claimed = new Set<string>();
	for (const link of withReports) {
		const sample = toLinkSample(link) as LinkSample;
		const owners = radios.filter((r) =>
			link.iface !== undefined
				? link.iface === r.ifname
				: link.ip !== undefined && r.addresses.includes(link.ip),
		);
		for (const owner of owners) claimed.add(owner.ifname);
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
		claimed,
	};
}

/** How long a hold-out may take to show in `get_stats` (the IP-list reload). */
export const HOLD_OUT_EVIDENCE_MS = 5_000;
/** How long a re-added link may take to register again and get a first ACK. */
export const RESTORE_EVIDENCE_MS = 10_000;

/**
 * The sender no longer carries the radio: no link it reports maps to it, not
 * even ambiguously.
 */
export function holdOutConfirmed(snap: Snapshot, ifname: string): boolean {
	return !snap.claimed.has(ifname);
}

/**
 * The radio is back in the bond under a new connection (an epoch other than
 * the one it was held out with), registered, and the receiver has answered on
 * it at least once.
 */
export function restoreConfirmed(
	snap: Snapshot,
	ifname: string,
	heldOutEpoch: number,
): boolean {
	const s = snap.radios.get(ifname);
	return (
		s !== undefined &&
		s.epoch !== heldOutEpoch &&
		s.connected &&
		!s.timedOut &&
		s.ageMs !== null
	);
}
