/**
 * The dead-link window, per access point loss: how long a radio that lost its
 * access point stays in the bond CeraUI publishes for the sender.
 *
 * Read-only and in-process. Every 100 ms, for each watched radio: its kernel
 * carrier (`/sys/class/net/<if>/carrier`; cfg80211 drops it when the station
 * disconnects) and whether one of the radio's addresses is in the IP list on
 * disk (`setup.ips_file`): the file the sender itself reads on reload, so a
 * failed write, a timed-out sidecar or anything else in between is judged by
 * what actually reached it. The radio's addresses are the ones the rounds
 * saw while it was associated, kept through the loss. A loss starts when the
 * carrier goes from up to down and ends when one of these happens first:
 * - `left-bond`: the IP list no longer has the radio's address; the window is
 *   from the loss to that write (the sender applies it on its next reload,
 *   which this does not include);
 * - `recovered`: the carrier came back while the interface was still in the
 *   bond;
 * - `unordered`: the carrier and the bond dropped within the same 100 ms, so
 *   which came first is unknown (the window is under 100 ms either way);
 * - `not-in-bond`: the interface was not in the bond when the loss began;
 * - `radio-replaced`: another physical radio took over the interface name
 *   before the loss ended, or while its carrier was being read (the carrier
 *   then belongs to that radio);
 * - `uncertain`: the IP list could not be read at some point of the loss,
 *   its first look included, so whether and when the interface left is
 *   unknown; the loss is followed until the list is readable again;
 * - `shared-address`: another interface has one of the addresses the watch
 *   keeps for the radio (checked at every look, against the kept addresses),
 *   so the IP list cannot tell whether this one is in it; not measured;
 * - `timeout`: none of these within 30 s.
 *
 * Radios are keyed by the physical radio id. A radio a round no longer lists
 * is removed by the next tick, unless a loss is in progress, which is followed
 * to its end. At most 256 ended losses wait for the runtime; older ones are
 * dropped and counted.
 */

import { readFile } from "node:fs/promises";
import { argMatch, ID_RE } from "../../../helpers/run.ts";
import { setup } from "../../setup.ts";
import { getNetworkInterfaces } from "../network-interfaces.ts";

export const LOSS_TICK_MS = 100;
export const LOSS_TIMEOUT_MS = 30_000;
/** Ended losses that may wait for the runtime; older ones are dropped. */
export const LOSS_MAX_PENDING = 256;

export type LossOutcome =
	| "left-bond"
	| "recovered"
	| "unordered"
	| "not-in-bond"
	| "radio-replaced"
	| "uncertain"
	| "shared-address"
	| "timeout";

export type LossEvent = Readonly<{
	at: number;
	radio: string;
	id: string;
	ifname: string;
	event: "ap-lost";
	/** The access point the radio was on when it was last seen associated. */
	bssid: string | null;
	lostAt: number;
	outcome: LossOutcome;
	/** Loss to the end of the episode, ms. For `left-bond`, the dead-link window. */
	durationMs: number;
}>;

export type WatchedRadio = Readonly<{
	id: string;
	permanentMac: string;
	ifname: string;
	/** The access point the round saw it on, `null` when not associated. */
	bssid: string | null;
	/** Its source addresses as the IP list writes them; empty when it has none. */
	addresses: readonly string[];
}>;

export type LossWatchDeps = Readonly<{
	now(): number;
	/** The kernel carrier, `undefined` when it could not be read. */
	carrier(ifname: string): Promise<boolean | undefined>;
	/**
	 * Whether any of `addresses` is in the IP list on disk; `undefined` when
	 * the list could not be read or there is no address to look for.
	 */
	inBond(addresses: readonly string[]): Promise<boolean | undefined>;
	/** Whether an interface other than `ifname` has one of `addresses`. */
	shared(ifname: string, addresses: readonly string[]): boolean;
}>;

type State = {
	radio: WatchedRadio;
	carrier: boolean | undefined;
	/** In the written bond at the previous look. */
	inBond: boolean | undefined;
	/** Last access point seen; frozen while a loss is in progress. */
	bssid: string | null;
	/** Last addresses seen; kept through a loss, when the radio has none. */
	addresses: readonly string[];
	/** What the rounds saw during a loss, taken over when it ends. */
	seenDuringLoss: { bssid: string | null; addresses: readonly string[] };
	/** The IP list could not be read at some look during this loss. */
	uncertain: boolean;
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
	#dropped = 0;
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
				// During a loss the record keeps the access point that went, and
				// the addresses the sender was given.
				if (state.lostAt === null) {
					if (r.bssid !== null) state.bssid = r.bssid;
					if (r.addresses.length > 0) state.addresses = r.addresses;
				} else {
					if (r.bssid !== null) state.seenDuringLoss.bssid = r.bssid;
					if (r.addresses.length > 0)
						state.seenDuringLoss.addresses = r.addresses;
				}
			} else
				this.#radios.set(r.id, {
					radio: r,
					carrier: undefined,
					inBond: undefined,
					bssid: r.bssid,
					addresses: r.addresses,
					seenDuringLoss: { bssid: null, addresses: [] },
					uncertain: false,
					lostAt: null,
					listed: true,
					last: null,
					losses: 0,
				});
		}
		// Unlisted radios are only marked here; a tick in flight may be using
		// them, so the tick removes them once no loss is in progress.
		for (const [id, state] of this.#radios)
			if (!listed.has(id)) state.listed = false;
	}

	/** The tick in flight, if any, settled. */
	settled(): Promise<void> {
		return this.#ticking ?? Promise.resolve();
	}

	/** One look at every watched radio; ticks never overlap. */
	tick(): Promise<void> {
		this.#ticking ??= this.#once().finally(() => {
			this.#ticking = null;
		});
		return this.#ticking;
	}

	/** Another, listed physical radio now has this radio's interface name. */
	#replaced(state: State): boolean {
		for (const other of this.#radios.values())
			if (
				other !== state &&
				other.listed &&
				other.radio.ifname === state.radio.ifname
			)
				return true;
		return false;
	}

	async #once(): Promise<void> {
		for (const [id, state] of [...this.#radios]) {
			if (state.lostAt !== null && !state.listed && this.#replaced(state)) {
				const now = this.#deps.now();
				this.#end(state, state.lostAt, now, "radio-replaced");
			} else if (state.listed || state.lostAt !== null) {
				const carrier = await this.#deps.carrier(state.radio.ifname);
				const inBond = await this.#deps.inBond(state.addresses);
				const now = this.#deps.now();
				// The reads awaited: if another radio took the name meanwhile, the
				// sample is that radio's, not this one's.
				if (!state.listed && this.#replaced(state)) {
					if (state.lostAt !== null)
						this.#end(state, state.lostAt, now, "radio-replaced");
					this.#radios.delete(id);
					continue;
				}
				// Another interface has one of the kept addresses: the list cannot
				// tell this radio's entry from that one.
				const shared = this.#deps.shared(state.radio.ifname, state.addresses);
				if (state.lostAt === null) {
					if (state.carrier === true && carrier === false) {
						if (shared) this.#end(state, now, now, "shared-address");
						else if (inBond === true) state.lostAt = now;
						// Unreadable at the first look: follow it as uncertain.
						else if (inBond === undefined) {
							state.lostAt = now;
							state.uncertain = true;
						}
						// Both dropped since the last look: the order is unknown.
						else if (state.inBond === true)
							this.#end(state, now, now, "unordered");
						else this.#end(state, now, now, "not-in-bond");
					}
				} else {
					if (inBond === undefined) state.uncertain = true;
					const late = now - state.lostAt >= LOSS_TIMEOUT_MS;
					if (shared) this.#end(state, state.lostAt, now, "shared-address");
					// Nothing is concluded while the list cannot be read.
					else if (inBond === undefined) {
						if (late) this.#end(state, state.lostAt, now, "timeout");
					} else if (state.uncertain)
						this.#end(state, state.lostAt, now, "uncertain");
					// A conclusive look wins over the deadline it arrives at.
					else if (inBond === false)
						this.#end(state, state.lostAt, now, "left-bond");
					else if (carrier === true)
						this.#end(state, state.lostAt, now, "recovered");
					else if (late) this.#end(state, state.lostAt, now, "timeout");
				}
				if (carrier !== undefined) state.carrier = carrier;
				state.inBond = inBond;
			}
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
			bssid: state.bssid,
			lostAt,
			outcome,
			durationMs: now - lostAt,
		};
		state.lostAt = null;
		state.uncertain = false;
		// What the rounds saw during the loss is the radio's state now.
		if (state.seenDuringLoss.bssid !== null)
			state.bssid = state.seenDuringLoss.bssid;
		if (state.seenDuringLoss.addresses.length > 0)
			state.addresses = state.seenDuringLoss.addresses;
		state.seenDuringLoss = { bssid: null, addresses: [] };
		state.last = event;
		state.losses++;
		this.#events.push(event);
		if (this.#events.length > LOSS_MAX_PENDING) {
			this.#events.shift();
			this.#dropped++;
		}
	}

	/** The losses that ended since the last call. */
	drain(): LossEvent[] {
		const out = this.#events;
		this.#events = [];
		return out;
	}

	/** Ended losses dropped because nobody drained them in time. */
	dropped(): number {
		return this.#dropped;
	}

	/** Per physical radio id. */
	status(id: string): LossStatus | null {
		const state = this.#radios.get(id);
		if (!state) return null;
		return { losses: state.losses, last: state.last, lostSince: state.lostAt };
	}
}

/** The addresses an IP list file names, one per line. */
export function ipListAddresses(text: string): Set<string> {
	return new Set(
		text
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l !== ""),
	);
}

/** The production reads: sysfs carrier, the IP list on disk and the registry. */
export function defaultLossWatchDeps(now: () => number): LossWatchDeps {
	return {
		now,
		shared: (ifname, addresses) =>
			Object.entries(getNetworkInterfaces()).some(
				([name, int]) =>
					name !== ifname &&
					addresses.some((a) => a === int?.ip || a === int?.ipv6),
			),
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
		inBond: async (addresses) => {
			const file = setup.ips_file;
			if (!file || addresses.length === 0) return undefined;
			try {
				const listed = ipListAddresses(await readFile(file, "utf8"));
				return addresses.some((a) => listed.has(a));
			} catch (error) {
				// No list on disk (no stream yet): nothing is in the bond. Any
				// other failure leaves it unknown.
				return (error as NodeJS.ErrnoException).code === "ENOENT"
					? false
					: undefined;
			}
		},
	};
}
