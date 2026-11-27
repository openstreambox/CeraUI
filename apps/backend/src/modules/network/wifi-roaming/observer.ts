/**
 * The roaming observer (level `observe`): it decides, every round, whether a
 * coordinator would nudge a radio, and records why or why not. It acts on
 * nothing. Pure: one round's readings in, a status and journal events out.
 *
 * A radio is a candidate when its own link fades (slice 1's rule: level at or
 * below -70 dBm, a slope of -1 dB/s or steeper over 10 s, or the link's CC
 * loss above 5 %). A nudge would then also need, in the design's order:
 * - the radio admitted (the radio port only lists admitted radios), not
 *   serving a hotspot, activated in NetworkManager as a station, associated;
 * - sender evidence: fresh (the sender's state moved within the last 3 s),
 *   with arrival reports on every link, every link mapped to exactly one
 *   interface of its own, the radio's own link among them;
 * - a stayer: another mapped link that delivered at least 95 % of what it was
 *   offered over a complete, unbroken span;
 * - the sender's standby (`set_link_standby`), without which no hold exists;
 * - no cooldown: after a would-nudge the radio waits 15 s, doubling to
 *   10 min while it stays on the same access point; after it moved, 30 s.
 *
 * State is keyed by the physical radio id, so a radio replugged under the
 * same name starts with nothing. Roams the radio makes by itself are
 * recorded, which is what a walk compares the decisions with.
 *
 * Also recorded, for every round: which access point each radio is on and
 * whether radios share one (an access point that goes then takes all of
 * them), and how many access points each radio's profile has connected to
 * (`seen-bssids`; under two the radio will not scan by itself above -70 dBm).
 */

import {
	classifyHolder,
	DEFAULT_SEARCH_POLICY,
	type HolderCondition,
	type SignalSample,
	signalSlope,
} from "./policy.ts";
import { deliversAtLeast, measureSpan, PROOF_POLICY } from "./proof.ts";
import type { RadioView, SkippedRadio } from "./radio-port.ts";
import { holderFailing, type Snapshot } from "./sender-links.ts";
import type { SenderView } from "./sender-port.ts";

/** A stayer must deliver at least this share of what it was offered. */
export const STAYER_RATIO = 0.95;
export const COOLDOWN_BASE_MS = 15_000;
export const COOLDOWN_MAX_MS = 600_000;
/** After the radio moved by itself, no nudge for this long. */
export const ROAM_DWELL_MS = 30_000;
/** Sender evidence older than this is stale: the sender's state stopped moving. */
export const SENDER_FRESH_MS = 3_000;
/** Sender snapshots kept for the stayer's span (the span plus RTT lag). */
const SNAPSHOT_WINDOW_MS = PROOF_POLICY.maxSpanMs + 5_000;
const MAX_SNAPSHOTS = 64;

export type Decision = "none" | "would-nudge" | "would-wait";

export type Blocker =
	| "hotspot"
	| "hotspot-unknown"
	| "not-a-station"
	| "not-associated"
	| "link-unreadable"
	| "no-sender-evidence"
	| "sender-evidence-stale"
	| "uncounted-sender-link"
	| "unmapped-sender-link"
	| "ambiguous-sender-link"
	| "radio-link-not-mapped"
	| "no-delivering-stayer"
	| "sender-without-standby"
	| "cooldown";

export type RadioStatus = Readonly<{
	/** The physical radio id the observer keys its state by. */
	id: string;
	permanentMac: string;
	ifname: string;
	ssid: string | null;
	bssid: string | null;
	signalDbm: number | null;
	slopeDbPerS: number | null;
	condition: HolderCondition | null;
	decision: Decision;
	blockers: readonly Blocker[];
	stayers: readonly string[];
	wouldNudges: number;
	lastWouldNudgeAt: number | null;
	roams: number;
	/** Other radios associated to the same access point. */
	sharesAccessPointWith: readonly string[];
	/** Access points the active profile has connected to; `null` unknown. */
	seenBssids: number | null;
	/**
	 * Fewer than two: for a profile without a fixed BSSID or 802.1X,
	 * NetworkManager scans this network only once a day above -70 dBm, so the
	 * radio will not move by itself. It describes the profile at its next
	 * activation, not the running association. `null` unknown.
	 */
	rareBackgroundScan: boolean | null;
}>;

export type SharedAccessPoint = Readonly<{
	bssid: string;
	radios: readonly string[];
}>;

export type ObserverStatus = Readonly<{
	at: number;
	sender: SenderView;
	radios: readonly RadioStatus[];
	/** Access points more than one radio is associated to. */
	sharedAccessPoints: readonly SharedAccessPoint[];
	skipped: readonly SkippedRadio[];
}>;

export type JournalEvent = Readonly<
	{ at: number; radio: string; id: string; ifname: string } & (
		| { event: "fade-start" | "fade-end"; signalDbm: number | null }
		| { event: "would-nudge"; bssid: string | null; stayers: string[] }
		| { event: "blocked"; blockers: Blocker[] }
		| { event: "roamed"; from: string; to: string; signalDbm: number | null }
		| { event: "radio-added" | "radio-gone" }
		| { event: "ap-shared" | "ap-split"; bssid: string; with: string[] }
		| { event: "seen-bssids"; count: number | null }
	)
>;

export type RoundInput = Readonly<{
	at: number;
	radios: readonly RadioView[];
	skipped: readonly SkippedRadio[];
	snapshot: Snapshot | undefined;
	sender: SenderView;
}>;

type RadioState = {
	id: string;
	permanentMac: string;
	ifname: string;
	samples: SignalSample[];
	lastBssid: string | null;
	condition: HolderCondition | null;
	blockerKey: string;
	wouldNudges: number;
	lastWouldNudgeAt: number | null;
	lastWouldNudgeBssid: string | null;
	cooldownMs: number;
	roamedAt: number | null;
	roams: number;
	/** The access point and partners the last round found it sharing. */
	shared: { bssid: string; with: string } | null;
	seenBssids: number | null | undefined;
};

/** The delivering stayers for `ifname`: other mapped links proven over a span. */
export function deliveringStayers(
	snaps: readonly Snapshot[],
	ifname: string,
): string[] {
	const latest = snaps.at(-1);
	if (!latest) return [];
	const out: string[] = [];
	for (const name of latest.radios.keys()) {
		if (name === ifname) continue;
		const m = measureSpan(snaps, (s) => s.radios.get(name));
		if (
			m.status === "measured" &&
			!m.continuityBreak &&
			deliversAtLeast(m, STAYER_RATIO) &&
			holderFailing(m.latest) === null
		)
			out.push(name);
	}
	return out.sort();
}

/** Why the sender's evidence cannot back a hold on `ifname`, if it cannot. */
function senderBlockers(
	snap: Snapshot | undefined,
	sender: SenderView,
	ifname: string,
	at: number,
): Blocker[] {
	if (!snap) return ["no-sender-evidence"];
	const out: Blocker[] = [];
	if (at - snap.at > SENDER_FRESH_MS) out.push("sender-evidence-stale");
	// The mapping of every link, counted or not, from the same reply.
	const mapping = sender.mapping;
	if (!mapping) out.push("no-sender-evidence");
	else {
		if (mapping.uncounted > 0) out.push("uncounted-sender-link");
		if (mapping.unmapped > 0) out.push("unmapped-sender-link");
		if (mapping.ambiguous > 0) out.push("ambiguous-sender-link");
	}
	if (snap.others.size > 0) out.push("unmapped-sender-link");
	for (const name of snap.claimed)
		if (!snap.radios.has(name)) {
			out.push("ambiguous-sender-link");
			break;
		}
	if (!snap.radios.has(ifname)) out.push("radio-link-not-mapped");
	return out;
}

export class RoamingObserver {
	readonly #radios = new Map<string, RadioState>();
	#snaps: Snapshot[] = [];
	#mappingKey: string | null = null;
	#status: ObserverStatus | null = null;

	status(): ObserverStatus | null {
		return this.#status;
	}

	round(input: RoundInput): JournalEvent[] {
		const { at } = input;
		const events: JournalEvent[] = [];
		this.#keepSnapshot(input.snapshot, input.sender.mapping?.key ?? null, at);

		const seen = new Set<string>();
		const statuses: RadioStatus[] = [];
		for (const radio of input.radios) {
			seen.add(radio.id);
			let state = this.#radios.get(radio.id);
			if (!state) {
				state = {
					id: radio.id,
					permanentMac: radio.permanentMac,
					ifname: radio.ifname,
					samples: [],
					lastBssid: null,
					condition: null,
					blockerKey: "",
					wouldNudges: 0,
					lastWouldNudgeAt: null,
					lastWouldNudgeBssid: null,
					cooldownMs: COOLDOWN_BASE_MS,
					roamedAt: null,
					roams: 0,
					shared: null,
					seenBssids: undefined,
				};
				this.#radios.set(radio.id, state);
				events.push(this.#event(at, state, { event: "radio-added" }));
			}
			state.ifname = radio.ifname;
			statuses.push(this.#judge(radio, state, input, events));
		}

		// Which radios share an access point, and what changed since last round.
		const byBssid = new Map<string, string[]>();
		for (const r of input.radios)
			if (r.link)
				byBssid.set(r.link.bssid, [
					...(byBssid.get(r.link.bssid) ?? []),
					r.ifname,
				]);
		const sharedAccessPoints: SharedAccessPoint[] = [...byBssid]
			.filter(([, names]) => names.length > 1)
			.map(([bssid, names]) => ({ bssid, radios: [...names].sort() }))
			.sort((a, b) => a.bssid.localeCompare(b.bssid));
		const unreadable = new Set(
			input.radios.filter((r) => r.link === undefined).map((r) => r.ifname),
		);
		input.radios.forEach((radio, i) => {
			const state = this.#radios.get(radio.id) as RadioState;
			const bssid = radio.link?.bssid ?? null;
			const partners =
				bssid === null
					? []
					: (byBssid.get(bssid) ?? []).filter((n) => n !== radio.ifname).sort();
			const now =
				bssid !== null && partners.length > 0
					? { bssid, with: partners.join(",") }
					: null;
			const before = state.shared;
			// An unreadable link, its own or a partner's, says nothing about
			// sharing: keep what was known.
			const unknown =
				radio.link === undefined ||
				(before?.with.split(",").some((n) => unreadable.has(n)) ?? false);
			if (unknown) {
				/* no change */
			} else if (
				now &&
				(before?.bssid !== now.bssid || before.with !== now.with)
			)
				events.push(
					this.#event(at, state, {
						event: "ap-shared",
						bssid: now.bssid,
						with: partners,
					}),
				);
			else if (!now && before)
				events.push(
					this.#event(at, state, {
						event: "ap-split",
						bssid: before.bssid,
						with: before.with.split(","),
					}),
				);
			if (!unknown) state.shared = now;
			if (radio.seenBssids !== state.seenBssids) {
				if (radio.seenBssids !== null || state.seenBssids !== undefined)
					events.push(
						this.#event(at, state, {
							event: "seen-bssids",
							count: radio.seenBssids,
						}),
					);
				state.seenBssids = radio.seenBssids;
			}
			const st = statuses[i] as RadioStatus;
			statuses[i] = {
				...st,
				sharesAccessPointWith: partners,
				seenBssids: radio.seenBssids,
				rareBackgroundScan:
					radio.seenBssids === null ? null : radio.seenBssids < 2,
			};
		});
		for (const [id, state] of this.#radios)
			if (!seen.has(id)) {
				this.#radios.delete(id);
				events.push(this.#event(at, state, { event: "radio-gone" }));
			}

		this.#status = {
			at,
			sender: input.sender,
			radios: statuses,
			sharedAccessPoints,
			skipped: input.skipped,
		};
		return events;
	}

	#keepSnapshot(
		snap: Snapshot | undefined,
		mappingKey: string | null,
		at: number,
	): void {
		// A missing read breaks every span: spans must be contiguous.
		if (!snap || mappingKey === null) {
			this.#snaps = [];
			this.#mappingKey = null;
			return;
		}
		// So does a change of which link (connection and epoch) is whose: a span
		// measured under the old mapping says nothing about the links now.
		if (mappingKey !== this.#mappingKey) this.#snaps = [];
		this.#mappingKey = mappingKey;
		const kept = this.#snaps.at(-1);
		if (kept?.at === snap.at) this.#snaps[this.#snaps.length - 1] = snap;
		else this.#snaps.push(snap);
		this.#snaps = this.#snaps
			.filter((s) => at - s.at <= SNAPSHOT_WINDOW_MS)
			.slice(-MAX_SNAPSHOTS);
	}

	#event(
		at: number,
		state: RadioState,
		body: Record<string, unknown>,
	): JournalEvent {
		return {
			at,
			radio: state.permanentMac,
			id: state.id,
			ifname: state.ifname,
			...body,
		} as JournalEvent;
	}

	#judge(
		radio: RadioView,
		state: RadioState,
		input: RoundInput,
		events: JournalEvent[],
	): RadioStatus {
		const { at } = input;
		const link = radio.link;
		const policy = DEFAULT_SEARCH_POLICY;

		// Signal history and roams the radio made by itself.
		const bssid = link ? link.bssid : null;
		if (link?.signalDbm !== null && link?.signalDbm !== undefined)
			state.samples.push({ at, dbm: link.signalDbm });
		if (
			bssid !== null &&
			state.lastBssid !== null &&
			bssid !== state.lastBssid
		) {
			state.roams++;
			state.roamedAt = at;
			state.samples =
				link?.signalDbm != null ? [{ at, dbm: link.signalDbm }] : [];
			events.push(
				this.#event(at, state, {
					event: "roamed",
					from: state.lastBssid,
					to: bssid,
					signalDbm: link?.signalDbm ?? null,
				}),
			);
		}
		if (bssid !== null) state.lastBssid = bssid;
		state.samples = state.samples.filter(
			(s) => at - s.at <= policy.slopeWindowMs * 2,
		);

		const slope = signalSlope(state.samples, at, policy.slopeWindowMs);
		const own = input.snapshot?.radios.get(radio.ifname);
		const condition: HolderCondition | null = link
			? classifyHolder(
					{
						signalDbm: link.signalDbm,
						// A radio carries a share of the bond, never the encoder's whole
						// rate, so the share is no fade signal here.
						attributedBps: null,
						encoderBps: null,
						nakRatio:
							own?.ccLossPermille != null ? own.ccLossPermille / 1_000 : null,
					},
					slope,
					policy,
				)
			: null;

		if ((condition === "fade") !== (state.condition === "fade"))
			events.push(
				this.#event(at, state, {
					event: condition === "fade" ? "fade-start" : "fade-end",
					signalDbm: link?.signalDbm ?? null,
				}),
			);
		state.condition = condition;

		let decision: Decision = "none";
		let blockers: Blocker[] = [];
		let stayers: string[] = [];
		if (condition === "fade") {
			if (radio.reserved === true) blockers.push("hotspot");
			else if (radio.reserved === null) blockers.push("hotspot-unknown");
			if (!radio.station) blockers.push("not-a-station");
			if (link === undefined) blockers.push("link-unreadable");
			else if (link === null) blockers.push("not-associated");
			blockers.push(
				...senderBlockers(input.snapshot, input.sender, radio.ifname, at),
			);
			stayers = blockers.includes("sender-evidence-stale")
				? []
				: deliveringStayers(this.#snaps, radio.ifname);
			if (stayers.length === 0) blockers.push("no-delivering-stayer");
			if (input.sender.standby !== true)
				blockers.push("sender-without-standby");
			if (this.#coolingDown(state, bssid, at)) blockers.push("cooldown");
			blockers = [...new Set(blockers)];
			if (blockers.length === 0) {
				decision = "would-nudge";
				this.#noteWouldNudge(state, bssid, at);
				events.push(
					this.#event(at, state, { event: "would-nudge", bssid, stayers }),
				);
			} else decision = "would-wait";
		}

		const blockerKey = decision === "would-wait" ? blockers.join(",") : "";
		if (blockerKey !== state.blockerKey && blockerKey !== "")
			events.push(this.#event(at, state, { event: "blocked", blockers }));
		state.blockerKey = blockerKey;

		// A radio without a link is no nudge candidate; say why it has none.
		if (condition === null)
			blockers = link === undefined ? ["link-unreadable"] : ["not-associated"];

		return {
			id: radio.id,
			permanentMac: radio.permanentMac,
			ifname: radio.ifname,
			ssid: link?.ssid ?? null,
			bssid,
			signalDbm: link?.signalDbm ?? null,
			slopeDbPerS: slope === null ? null : Math.round(slope * 100) / 100,
			condition,
			decision,
			blockers,
			stayers,
			wouldNudges: state.wouldNudges,
			lastWouldNudgeAt: state.lastWouldNudgeAt,
			roams: state.roams,
			sharesAccessPointWith: [],
			seenBssids: radio.seenBssids,
			rareBackgroundScan: null,
		};
	}

	#coolingDown(state: RadioState, bssid: string | null, at: number): boolean {
		if (state.roamedAt !== null && at - state.roamedAt < ROAM_DWELL_MS)
			return true;
		if (state.lastWouldNudgeAt === null) return false;
		// The radio moved since: only the roam dwell applies.
		if (bssid !== null && bssid !== state.lastWouldNudgeBssid) return false;
		return at - state.lastWouldNudgeAt < state.cooldownMs;
	}

	#noteWouldNudge(state: RadioState, bssid: string | null, at: number): void {
		// A nudge after which the radio stayed where it was doubles the wait.
		if (state.lastWouldNudgeAt !== null && bssid === state.lastWouldNudgeBssid)
			state.cooldownMs = Math.min(state.cooldownMs * 2, COOLDOWN_MAX_MS);
		else state.cooldownMs = COOLDOWN_BASE_MS;
		state.wouldNudges++;
		state.lastWouldNudgeAt = at;
		state.lastWouldNudgeBssid = bssid;
	}
}
