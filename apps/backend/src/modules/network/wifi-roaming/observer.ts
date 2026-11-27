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
 * - sender evidence: arrival reports, every sender link mapped to exactly one
 *   interface, the radio's own link among them;
 * - a stayer: another mapped link that delivers at least 95 % of what it was
 *   offered over a complete span;
 * - the sender's standby (`set_link_standby`), without which no hold exists;
 * - no cooldown: after a would-nudge the radio waits 15 s, doubling to
 *   10 min while it stays on the same access point; after it moved, 30 s.
 *
 * State is keyed by the physical radio id, so a radio replugged under the
 * same name starts with nothing. Roams the radio makes by itself are
 * recorded, which is what a walk compares the decisions with.
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
	| "unmapped-sender-link"
	| "ambiguous-sender-link"
	| "radio-link-not-mapped"
	| "no-delivering-stayer"
	| "sender-without-standby"
	| "cooldown";

export type RadioStatus = Readonly<{
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
}>;

export type ObserverStatus = Readonly<{
	at: number;
	sender: SenderView;
	radios: readonly RadioStatus[];
	skipped: readonly SkippedRadio[];
}>;

export type JournalEvent = Readonly<
	{ at: number; radio: string; ifname: string } & (
		| { event: "fade-start" | "fade-end"; signalDbm: number | null }
		| { event: "would-nudge"; bssid: string | null; stayers: string[] }
		| { event: "blocked"; blockers: Blocker[] }
		| { event: "roamed"; from: string; to: string; signalDbm: number | null }
		| { event: "radio-added" | "radio-gone" }
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
			deliversAtLeast(m, STAYER_RATIO) &&
			holderFailing(m.latest) === null
		)
			out.push(name);
	}
	return out.sort();
}

/** Why the sender's evidence cannot back a hold on `ifname`, if it cannot. */
function senderBlockers(snap: Snapshot | undefined, ifname: string): Blocker[] {
	if (!snap) return ["no-sender-evidence"];
	const out: Blocker[] = [];
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
	#status: ObserverStatus | null = null;

	status(): ObserverStatus | null {
		return this.#status;
	}

	round(input: RoundInput): JournalEvent[] {
		const { at } = input;
		const events: JournalEvent[] = [];
		this.#keepSnapshot(input.snapshot, at);

		const seen = new Set<string>();
		const statuses: RadioStatus[] = [];
		for (const radio of input.radios) {
			seen.add(radio.id);
			let state = this.#radios.get(radio.id);
			if (!state) {
				state = {
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
				};
				this.#radios.set(radio.id, state);
				events.push(this.#event(at, state, { event: "radio-added" }));
			}
			state.ifname = radio.ifname;
			statuses.push(this.#judge(radio, state, input, events));
		}
		for (const [id, state] of this.#radios)
			if (!seen.has(id)) {
				this.#radios.delete(id);
				events.push(this.#event(at, state, { event: "radio-gone" }));
			}

		this.#status = {
			at,
			sender: input.sender,
			radios: statuses,
			skipped: input.skipped,
		};
		return events;
	}

	#keepSnapshot(snap: Snapshot | undefined, at: number): void {
		// A missing read breaks every span: spans must be contiguous.
		if (!snap) {
			this.#snaps = [];
			return;
		}
		if (this.#snaps.at(-1)?.at !== snap.at) this.#snaps.push(snap);
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
			blockers.push(...senderBlockers(input.snapshot, radio.ifname));
			stayers = deliveringStayers(this.#snaps, radio.ifname);
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

		return {
			permanentMac: radio.permanentMac,
			ifname: radio.ifname,
			ssid: link?.ssid ?? null,
			bssid,
			signalDbm: link?.signalDbm ?? null,
			slopeDbPerS: slope === null ? null : Math.round(slope * 100) / 100,
			condition,
			decision,
			blockers: decision === "none" ? [] : blockers,
			stayers,
			wouldNudges: state.wouldNudges,
			lastWouldNudgeAt: state.lastWouldNudgeAt,
			roams: state.roams,
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
