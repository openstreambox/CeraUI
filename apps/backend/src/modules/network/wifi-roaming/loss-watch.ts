/**
 * The dead-link window, per access point loss: how long a radio that lost its
 * access point stays in the bond CeraUI publishes for the sender.
 *
 * Read-only and in-process. Every 100 ms, for each watched radio: its kernel
 * carrier (`/sys/class/net/<if>/carrier`; cfg80211 drops it when the station
 * disconnects) and whether the interface is in the last bond CeraUI
 * published (`getLastPublishedBond`). A loss starts when the carrier goes from
 * up to down and ends when one of these happens first:
 * - `left-bond`: the published bond no longer has the interface; the window
 *   is from the loss to that publication (the sender applies it on its next
 *   reload, which this does not include);
 * - `recovered`: the carrier came back while the interface was still in the
 *   bond;
 * - `not-in-bond`: the interface was not in the bond when the loss began;
 * - `timeout`: neither within 30 s.
 *
 * Radios are keyed by the physical radio id; a radio stays watched until a
 * loss in progress has ended, even when a round no longer lists it.
 */

import { readFile } from "node:fs/promises";
import { argMatch, ID_RE } from "../../../helpers/run.ts";
import { getLastPublishedBond } from "../../streaming/srtla.ts";

export const LOSS_TICK_MS = 100;
export const LOSS_TIMEOUT_MS = 30_000;

export type LossOutcome = "left-bond" | "recovered" | "not-in-bond" | "timeout";

export type LossEvent = Readonly<{
	at: number;
	radio: string;
	id: string;
	ifname: string;
	event: "ap-lost";
	lostAt: number;
	outcome: LossOutcome;
	/** Loss to the end of the episode, ms. For `left-bond`, the dead-link window. */
	durationMs: number;
}>;

export type WatchedRadio = Readonly<{
	id: string;
	permanentMac: string;
	ifname: string;
}>;

export type LossWatchDeps = Readonly<{
	now(): number;
	/** The kernel carrier, `undefined` when it could not be read. */
	carrier(ifname: string): Promise<boolean | undefined>;
	/** In the last published bond; `undefined` when nothing was published. */
	inBond(ifname: string): boolean | undefined;
}>;

type State = {
	radio: WatchedRadio;
	carrier: boolean | undefined;
	lostAt: number | null;
	/** Listed by the last round; an unlisted radio is kept only mid-loss. */
	listed: boolean;
	last: LossEvent | null;
	losses: number;
};

export type LossStatus = Readonly<{
	losses: number;
	last: LossEvent | null;
	/** A loss in progress, since. */
	lostSince: number | null;
}>;

export class LossWatch {
	readonly #deps: LossWatchDeps;
	readonly #radios = new Map<string, State>();
	#events: LossEvent[] = [];
	#ticking: Promise<void> | null = null;

	constructor(deps: LossWatchDeps) {
		this.#deps = deps;
	}

	/** The radios to watch, from a round: every admitted client radio. */
	watch(radios: readonly WatchedRadio[]): void {
		const listed = new Set(radios.map((r) => r.id));
		for (const r of radios) {
			const state = this.#radios.get(r.id);
			if (state) {
				state.radio = r;
				state.listed = true;
			} else
				this.#radios.set(r.id, {
					radio: r,
					carrier: undefined,
					lostAt: null,
					listed: true,
					last: null,
					losses: 0,
				});
		}
		for (const [id, state] of this.#radios)
			if (!listed.has(id)) {
				state.listed = false;
				if (state.lostAt === null) this.#radios.delete(id);
			}
	}

	/** One look at every watched radio; ticks never overlap. */
	tick(): Promise<void> {
		this.#ticking ??= this.#once().finally(() => {
			this.#ticking = null;
		});
		return this.#ticking;
	}

	async #once(): Promise<void> {
		for (const [id, state] of [...this.#radios]) {
			const carrier = await this.#deps.carrier(state.radio.ifname);
			const now = this.#deps.now();
			const inBond = this.#deps.inBond(state.radio.ifname);
			if (state.lostAt === null) {
				if (state.carrier === true && carrier === false) {
					if (inBond === true) state.lostAt = now;
					else this.#end(state, now, now, "not-in-bond");
				}
			} else if (inBond === false || inBond === undefined)
				this.#end(state, state.lostAt, now, "left-bond");
			else if (carrier === true)
				this.#end(state, state.lostAt, now, "recovered");
			else if (now - state.lostAt >= LOSS_TIMEOUT_MS)
				this.#end(state, state.lostAt, now, "timeout");
			if (carrier !== undefined) state.carrier = carrier;
			if (!state.listed && state.lostAt === null) this.#radios.delete(id);
		}
	}

	#end(state: State, lostAt: number, now: number, outcome: LossOutcome): void {
		const event: LossEvent = {
			at: now,
			radio: state.radio.permanentMac,
			id: state.radio.id,
			ifname: state.radio.ifname,
			event: "ap-lost",
			lostAt,
			outcome,
			durationMs: now - lostAt,
		};
		state.lostAt = null;
		state.last = event;
		state.losses++;
		this.#events.push(event);
	}

	/** The losses that ended since the last call. */
	drain(): LossEvent[] {
		const out = this.#events;
		this.#events = [];
		return out;
	}

	/** Per physical radio id. */
	status(id: string): LossStatus | null {
		const state = this.#radios.get(id);
		if (!state) return null;
		return { losses: state.losses, last: state.last, lostSince: state.lostAt };
	}
}

/** The production reads: sysfs carrier and the last published bond. */
export function defaultLossWatchDeps(now: () => number): LossWatchDeps {
	return {
		now,
		carrier: async (ifname) => {
			try {
				const v = (
					await readFile(
						`/sys/class/net/${argMatch(ID_RE, ifname)}/carrier`,
						"utf8",
					)
				).trim();
				return v === "1" ? true : v === "0" ? false : undefined;
			} catch {
				// An interface that is down has no readable carrier.
				return undefined;
			}
		},
		inBond: (ifname) => {
			const bond = getLastPublishedBond();
			return bond ? bond.entries.some((e) => e.iface === ifname) : undefined;
		},
	};
}
