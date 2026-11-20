/**
 * Station-based coordinated Wi-Fi roaming for the SRTLA bond.
 *
 * Any number of client radios, each with a role (see `Role` in policy.ts).
 * Holders carry the stream and are never disturbed on purpose. One other radio
 * at a time may scan and join another network, chosen for continuity when a
 * holder fades, for uplink diversity while holders have headroom, or for extra
 * capacity when nothing new is around (assist mode).
 *
 * It covers roles, search, join, path verification and learning which uplink
 * a path uses; a verified path rejoins the bond as an assister. When the
 * sender reports per-link arrival counters, it also hands the holder role
 * over (see "Continuity" below); without them it never promotes on its own.
 *
 * Continuity, when the sender reports arrival counters:
 * - A fading holder gets a continuity candidate: a carrying assister on another
 *   BSSID, diverse paths first. The candidate proves itself on the share it
 *   already carries (`proof.ts`), so nothing is withheld for the proof.
 * - Promotion is a relabel through the two-radio reducer's swap rules
 *   (`swap-op.ts`): the candidate becomes a holder and takes the scan
 *   protection; the old holder keeps carrying through the linger and is an
 *   assister afterwards. Leaving the bond stays a separate decision.
 * - A holder the receiver no longer hears from, while another link still gets
 *   ACKs, is relabelled at once: the best currently delivering carrier becomes
 *   holder. No proof, linger or hold-out; the sender already keeps traffic off
 *   the dead path, and the bond's second path is what keeps the stream going.
 *
 * Guarantees, each covered by `coordinator.test.ts`:
 * - No holder or hotspot-reserved radio is named in a scan, join or abandon.
 *   A radio is hotspot-reserved by configuration, or while it or another
 *   interface on its phy is in AP mode. That is read every round and again
 *   under CeraUI's per-adapter Wi-Fi lock right before each scan or join.
 * - CeraUI's own rescans skip every radio that carries traffic or serves the
 *   hotspot.
 * - One interrupting action at a time across all radios; a radio that carries
 *   traffic leaves the bond before it scans. A radio that shares a phy with a
 *   holder never scans.
 * - A searcher returns to the bond only when verified on the chosen BSSID with
 *   a lease and route, or when the attempt is abandoned.
 * - Joins use an owned profile locked to the BSSID: no background scans, no
 *   roaming back. The operator's profiles are untouched.
 * - A scan that overran its budget, or during which a holder moved to another
 *   BSSID, is discarded. A holder that is lost during a search does not cost
 *   the replacement: it is joined, verified and promoted.
 */

import { type Effect, type Epoch, sameEpoch } from "../two-radio/reducer.ts";
import { setCoordinatorOwnedRadios } from "./ownership.ts";
import {
	classifyHolder,
	DEFAULT_SEARCH_POLICY,
	type Diversity,
	diversityAgainst,
	FRESH_SEARCH_CLOCK,
	type HolderCondition,
	type HolderHealth,
	joinCooldownMs,
	normalizeBssid,
	pickCandidate,
	type Role,
	type ScanRow,
	type SearchClock,
	type SearchGoal,
	type SearchPolicy,
	type SignalSample,
	searchDue,
	signalSlope,
	type UplinkIdentity,
} from "./policy.ts";
import {
	evaluateCandidate,
	evaluateHolder,
	independentLinkFailed,
	PROOF_POLICY,
	type ProofPolicy,
	preFadeBondRate,
} from "./proof.ts";
import {
	protectRadiosFromScans,
	type RadioMode,
	setScanGateModeReader,
} from "./scan-gate.ts";
import type { Snapshot } from "./sender-links.ts";
import {
	CANDIDATE,
	HOLDER,
	SWAP_TIMINGS,
	SwapOperation,
	type SwapTimings,
} from "./swap-op.ts";

/** What one read-only look at a radio shows. Never involves a scan. */
export type RadioObservation = Readonly<{
	ifname: string;
	ssid: string | null;
	bssid: string | null;
	/** Link signal in dBm from the association itself. */
	signalDbm: number | null;
	/** IPv4 address with prefix, `null` without a lease. */
	address: string | null;
	gateway: string | null;
	/** A default route through `gateway` on this interface exists. */
	routed: boolean;
	/** UUID of the active NetworkManager profile, `null` when none is active. */
	activation: string | null;
	/**
	 * The active-profile listing was read. When it was not, `activation` is
	 * `null` but says nothing: no decision may treat it as "not active".
	 */
	activationRead: boolean;
	/** The active profile is locked to one BSSID. */
	bssidLocked: boolean;
	/** The wiphy this interface belongs to, when known. */
	phy: string | null;
	/**
	 * This interface, or another one on its phy, is in AP mode. `null` when it
	 * could not be read; no action runs on a radio in that state.
	 */
	apOnPhy: boolean | null;
}>;

export type JoinResult = Readonly<{ activation: string }>;

/** `join` declined to activate because the last check before it said no. */
export const JOIN_REFUSED = "refused";

/** `ok: false` when another CeraUI operation holds the radio's adapter lock. */
export type RadioLockResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false }>;

export type CoordinatorPorts = Readonly<{
	now(): number;
	observe(ifname: string): Promise<RadioObservation | undefined>;
	/** Scan on this radio only; `undefined` is a failed scan. */
	scan(ifname: string): Promise<readonly ScanRow[] | undefined>;
	/** SSIDs this radio has saved, interface-bound profiles for. */
	savedSsids(ifname: string): Promise<ReadonlySet<string>>;
	/**
	 * Activate an owned profile on this radio, locked to `bssid`. `mayActivate`
	 * runs after the profile work, right before activation; when it says no,
	 * the profile is removed and the result is {@link JOIN_REFUSED}.
	 */
	join(
		ifname: string,
		ssid: string,
		bssid: string,
		mayActivate: () => Promise<boolean>,
	): Promise<JoinResult | typeof JOIN_REFUSED | undefined>;
	/**
	 * A dedicated, cheap read of the radio's phy and AP state (`iw dev` only),
	 * taken late: right before a scan, an activation or a cleanup.
	 */
	radioMode(ifname: string): Promise<RadioMode | undefined>;
	/** Remove the owned profile from `join`. */
	abandon(ifname: string, activation: string): Promise<boolean>;
	/** Gateway and egress of an associated radio's path. */
	uplinkOf(
		ifname: string,
		observation: RadioObservation,
	): Promise<UplinkIdentity>;
	/** Receiver-side and encoder signals for a holder's link. */
	holderHealth(ifname: string): HolderHealth;
	/** Links in the bond that are not coordinated Wi-Fi (cellular, Ethernet). */
	otherUplinks(): number;
	/**
	 * The sender's latest per-link arrival reports, mapped onto these radios
	 * (`sender-links.ts`), or `undefined` when the sender reports none. Without
	 * this port the coordinator never promotes a candidate on its own.
	 */
	senderLinks?(): Snapshot | undefined;
	/** What the encoder is producing right now, bits/s, `null` when unknown. */
	encoderRate?(): number | null;
	holdOutOfBond(ifname: string): void;
	releaseBondHold(ifname: string): void;
	/**
	 * Run `fn` under CeraUI's per-adapter Wi-Fi lock for this radio, the one
	 * hotspot start and stop hold. Never waits: a busy radio is `ok: false`.
	 */
	withRadioLock<T>(
		ifname: string,
		fn: () => Promise<T>,
	): Promise<RadioLockResult<T>>;
}>;

export type RadioConfig = Readonly<{
	ifname: string;
	/** Serves the phone hotspot; the coordinator never touches it. */
	reserved?: "hotspot";
}>;

export type CoordinatorConfig = Readonly<{
	radios: readonly RadioConfig[];
	policy?: SearchPolicy;
	/** Budget for one scan. A scan that overruns it is discarded. */
	operationMs?: number;
	/** How long a joined radio may take to show the BSSID, lease and route. */
	verifyMs?: number;
	/** Signal spread over the window below which a holder is not moving. */
	stableSpreadDb?: number;
	stableWindowMs?: number;
	proofPolicy?: ProofPolicy;
	swapTimings?: SwapTimings;
	/** How much sender history the proof keeps. */
	historyMs?: number;
}>;

export type RadioStatus = Readonly<{
	ifname: string;
	role: Role;
	bssid: string | null;
	ssid: string | null;
	/** This radio's path compared with the holders' paths. */
	diversity: Diversity | null;
	/** Owned join in progress or verified, with what it was for. */
	joined: Readonly<{ ssid: string; bssid: string; goal: SearchGoal }> | null;
	verified: boolean;
	/** The active profile is locked to its BSSID, so it gets no background scan. */
	bssidLocked: boolean;
}>;

export type SwapStatus = Readonly<{
	holder: string;
	candidate: string;
	/** `proving` until promotion, then the reducer's phase. */
	phase: string;
}>;

export type CoordinatorStatus = Readonly<{
	radios: readonly RadioStatus[];
	searches: number;
	lastSearchAt: number | null;
	lastOutcome: string | null;
	/** The handover in progress, `null` when none. */
	swap: SwapStatus | null;
	/** How the last handover attempt ended. */
	lastSwapOutcome: string | null;
}>;

type Owned = {
	ssid: string;
	bssid: string;
	activation: string;
	goal: SearchGoal;
	verifyUntil: number;
	verified: boolean;
};

type RadioRecord = {
	ifname: string;
	/** Hotspot-reserved by configuration, whatever its mode. */
	reserved: boolean;
	role: Role;
	obs: RadioObservation | undefined;
	uplink: UplinkIdentity | null;
	diversity: Diversity | null;
	owned: Owned | null;
	/** When `uplink.gatewayMac` was last really observed, `null` if never. */
	uplinkMacAt: number | null;
	samples: SignalSample[];
	heldOut: boolean;
	/** When this radio last started a search; idle radios take turns. */
	searchedAt: number;
	/** Failed scans in a row, and no search on this radio before `restUntil`. */
	scanFailures: number;
	restUntil: number;
};

type Departure = {
	ifname: string;
	deadline: number;
	/** Each holder's BSSID when the action started. */
	holders: ReadonlyMap<string, string | null>;
};

/** Why an action did not run or was discarded. */
type ActStop = "aborted" | "radio-busy" | "radio-in-ap-mode";

type Learned = {
	uplink: UplinkIdentity;
	/** When this BSSID was last associated. */
	at: number;
	/** When its gateway MAC was last really observed, `null` if never. */
	macAt: number | null;
};

type Swap = {
	op: SwapOperation;
	holder: RadioRecord;
	candidate: RadioRecord;
	/** Sender epochs the open proof span was started under, `null` between spans. */
	span: { candidate: string; holder: string | null } | null;
	/** The bond's packet rate before the fade, for the proof's load floor. */
	preFade: number | null;
	promoted: boolean;
};

/** Continuity candidates, best first: a separate uplink fixes more. */
const DIVERSITY_RANK: Record<Diversity, number> = {
	diverse: 0,
	"distinct-gateway": 1,
	"same-uplink": 2,
	unknown: 3,
};

/** Cool-down after a candidate fails a proof: 10 s, then doubling to 120 s. */
const SWAP_COOLDOWN_MS = [10_000, 20_000, 40_000, 80_000, 120_000] as const;

const CONDITION_RANK: Record<HolderCondition, number> = {
	fade: 0,
	steady: 1,
	headroom: 2,
};

export class RoamingCoordinator {
	readonly #ports: CoordinatorPorts;
	readonly #policy: SearchPolicy;
	readonly #operationMs: number;
	readonly #verifyMs: number;
	readonly #stableSpreadDb: number;
	readonly #stableWindowMs: number;
	readonly #radios: RadioRecord[];
	/** Absolute uplink identity per BSSID, judged against holders at use. */
	readonly #learned = new Map<string, Learned>();
	/** Recent failed joins or verifications per BSSID. */
	readonly #failed = new Map<string, { count: number; at: number }>();
	/** Owned clones whose removal had to wait (busy lock, or still carrying). */
	readonly #pendingAbandon = new Map<string, string>();
	#clock: SearchClock = FRESH_SEARCH_CLOCK;
	#joinFailures = 0;
	#searches = 0;
	#lastOutcome: string | null = null;
	#departure: Departure | null = null;
	readonly #proofPolicy: ProofPolicy;
	readonly #swapTimings: SwapTimings;
	readonly #historyMs: number;
	/** Sender snapshots, oldest first, kept for `historyMs`. */
	#history: Snapshot[] = [];
	#swap: Swap | null = null;
	/** Recent failed proofs per BSSID. */
	readonly #swapCooldown = new Map<string, { count: number; until: number }>();
	#lastSwapOutcome: string | null = null;
	#busy = false;
	#started = false;
	#stopped = false;

	constructor(ports: CoordinatorPorts, config: CoordinatorConfig) {
		const names = config.radios.map((r) => r.ifname);
		if (new Set(names).size !== names.length)
			throw new Error("Each radio may be listed once");
		this.#ports = ports;
		this.#policy = config.policy ?? DEFAULT_SEARCH_POLICY;
		this.#operationMs = config.operationMs ?? 15_000;
		this.#verifyMs = config.verifyMs ?? 15_000;
		this.#stableSpreadDb = config.stableSpreadDb ?? 3;
		this.#stableWindowMs = config.stableWindowMs ?? 60_000;
		this.#proofPolicy = config.proofPolicy ?? PROOF_POLICY;
		this.#swapTimings = config.swapTimings ?? SWAP_TIMINGS;
		this.#historyMs = config.historyMs ?? 70_000;
		this.#radios = config.radios.map((r) => ({
			ifname: r.ifname,
			reserved: r.reserved === "hotspot",
			role: r.reserved === "hotspot" ? "hotspot-reserved" : "searcher",
			obs: undefined,
			uplink: null,
			diversity: null,
			owned: null,
			uplinkMacAt: null,
			samples: [],
			heldOut: false,
			searchedAt: Number.NEGATIVE_INFINITY,
			scanFailures: 0,
			restUntil: 0,
		}));
		this.#publishOwnership();
		this.#protectFromScans();
		setScanGateModeReader((ifname) => ports.radioMode(ifname));
	}

	#publishOwnership(): void {
		setCoordinatorOwnedRadios(
			this.#radios
				.filter((r) => r.role !== "hotspot-reserved")
				.map((r) => r.ifname),
		);
	}

	status(): CoordinatorStatus {
		return {
			radios: this.#radios.map((r) => ({
				ifname: r.ifname,
				role: r.role,
				bssid: r.obs?.bssid ?? null,
				ssid: r.obs?.ssid ?? null,
				diversity: r.diversity,
				joined: r.owned
					? { ssid: r.owned.ssid, bssid: r.owned.bssid, goal: r.owned.goal }
					: null,
				verified: r.owned?.verified ?? false,
				bssidLocked: r.obs?.bssidLocked ?? false,
			})),
			searches: this.#searches,
			lastSearchAt: this.#clock.lastSearchAt,
			lastOutcome: this.#lastOutcome,
			swap: this.#swap
				? {
						holder: this.#swap.holder.ifname,
						candidate: this.#swap.candidate.ifname,
						phase: this.#swap.promoted ? this.#swap.op.phase : "proving",
					}
				: null,
			lastSwapOutcome: this.#lastSwapOutcome,
		};
	}

	/** Release every gate. Radios keep whatever association they have. */
	stop(): void {
		this.#stopped = true;
		this.#dropSwap("stopped");
		this.#history = [];
		for (const r of this.#radios) this.#release(r);
		protectRadiosFromScans([]);
		setScanGateModeReader(null);
		setCoordinatorOwnedRadios([]);
	}

	/** One control round. Rounds never overlap; a call during one is a no-op. */
	async step(): Promise<void> {
		if (this.#busy || this.#stopped) return;
		this.#busy = true;
		try {
			await this.#round();
		} finally {
			this.#busy = false;
		}
	}

	#holders(): RadioRecord[] {
		return this.#radios.filter((r) => r.role === "holder");
	}

	#associated(r: RadioRecord): boolean {
		return !!r.obs?.bssid && !!r.obs.address;
	}

	async #observeAll(): Promise<void> {
		const now = this.#ports.now();
		for (const r of this.#radios) {
			if (r.reserved) continue;
			r.obs = await this.#ports.observe(r.ifname);
			// The operator can turn a client radio into a hotspot at any time, or
			// add an AP leg on its phy. Unknown mode keeps the last classification.
			const ap =
				r.obs?.apOnPhy === true ||
				(r.obs?.apOnPhy === null && r.role === "hotspot-reserved");
			if (ap) {
				await this.#reserve(r);
				continue;
			}
			if (r.role === "hotspot-reserved")
				r.role = r.owned?.verified ? "assister" : "searcher";
			if (r.obs && this.#associated(r)) {
				const known = this.#withKnownMac(
					r.obs,
					await this.#ports.uplinkOf(r.ifname, r.obs),
					now,
				);
				r.uplink = known.uplink;
				r.uplinkMacAt = known.macAt;
			} else {
				r.uplink = null;
				r.uplinkMacAt = null;
			}
			if (r.obs?.signalDbm != null)
				r.samples.push({ at: now, dbm: r.obs.signalDbm });
			r.samples = r.samples.filter(
				(s) =>
					now - s.at <=
					Math.max(this.#policy.slopeWindowMs, this.#stableWindowMs),
			);
		}
	}

	/**
	 * A radio that became a hotspot, or gained an AP leg on its phy: no search
	 * state, no action. A phy that runs AP and station at once keeps its
	 * station: an owned clone that is still the active connection (carrying or
	 * verifying) is left exactly as it is, hold included, and picked up again
	 * when the AP goes. Only a clone the AP has already replaced is removed.
	 */
	async #reserve(r: RadioRecord): Promise<void> {
		if (r.role === "holder") this.#lastOutcome = `holder-lost:${r.ifname}`;
		r.role = "hotspot-reserved";
		r.uplink = null;
		r.uplinkMacAt = null;
		r.diversity = null;
		r.samples = [];
		const owned = r.owned;
		// Only a readable listing that shows another activation proves the AP
		// replaced the clone; an unreadable one keeps everything as it is.
		if (
			owned &&
			r.obs?.activationRead === true &&
			r.obs.activation !== owned.activation
		) {
			r.owned = null;
			await this.#abandon(r, owned.activation);
		}
		// An unverified station stays out of the bond; nothing else changes.
		if (!r.owned) this.#release(r);
		this.#protectFromScans();
	}

	/**
	 * Remove an owned clone, under the radio's adapter lock and after a fresh
	 * look. Nothing is removed while the active-profile listing cannot be read.
	 * On a protected radio (a holder, a reserved radio, or one with an AP on
	 * its phy or an unreadable mode) the clone is removed only on positive
	 * evidence that it is no longer the active connection. Anything that waits
	 * is retried in a later round.
	 */
	async #abandon(r: RadioRecord, activation: string): Promise<void> {
		const done = await this.#ports.withRadioLock(r.ifname, async () => {
			const mode = await this.#ports.radioMode(r.ifname);
			const now = await this.#ports.observe(r.ifname);
			if (!now?.activationRead) return false;
			const protectedRadio =
				r.role === "holder" ||
				r.role === "hotspot-reserved" ||
				mode?.apOnPhy !== false;
			if (protectedRadio && now.activation === activation) return false;
			await this.#ports.abandon(r.ifname, activation);
			return true;
		});
		if (done.ok && done.value) this.#pendingAbandon.delete(r.ifname);
		else this.#pendingAbandon.set(r.ifname, activation);
	}

	/** Retry removals that had to wait, unless the clone is in use again. */
	async #retryAbandons(): Promise<void> {
		for (const [ifname, activation] of [...this.#pendingAbandon]) {
			const r = this.#radios.find((x) => x.ifname === ifname);
			if (!r || r.owned?.activation === activation) {
				this.#pendingAbandon.delete(ifname);
				continue;
			}
			await this.#abandon(r, activation);
		}
	}

	/**
	 * Keep a gateway MAC observed earlier for the same BSSID, gateway and
	 * subnet. Right after a join the neighbour entry is often missing, and
	 * without it two factory-default routers would look alike. The MAC keeps
	 * the time it was really seen, and a backfill never makes it younger, so
	 * the learned lifetime holds for it too.
	 */
	#withKnownMac(
		obs: RadioObservation,
		uplink: UplinkIdentity,
		now: number,
	): { uplink: UplinkIdentity; macAt: number | null } {
		if (uplink.gatewayMac !== null) return { uplink, macAt: now };
		if (!obs.bssid) return { uplink, macAt: null };
		const prev = this.#learned.get(normalizeBssid(obs.bssid));
		return prev?.uplink.gatewayMac &&
			prev.macAt !== null &&
			now - prev.macAt <= this.#policy.learnedTtlMs &&
			prev.uplink.gateway === uplink.gateway &&
			prev.uplink.subnet === uplink.subnet
			? {
					uplink: { ...uplink, gatewayMac: prev.uplink.gatewayMac },
					macAt: prev.macAt,
				}
			: { uplink, macAt: null };
	}

	/**
	 * CeraUI's own rescans skip every radio that carries traffic, serves the
	 * hotspot, is out of the bond for a search or in the middle of an owned
	 * join, and every radio on the phys those use. Only idle searchers remain.
	 * Published on every change of role, hold or ownership, not once a round.
	 */
	#protectFromScans(): void {
		const prot = this.#radios.filter(
			(r) => r.role !== "searcher" || r.owned !== null || r.heldOut,
		);
		protectRadiosFromScans(
			prot.map((r) => r.ifname),
			prot.map((r) => r.obs?.phy).filter((p): p is string => !!p),
		);
	}

	#holderPhys(): Set<string> {
		return new Set(
			this.#holders()
				.map((h) => h.obs?.phy)
				.filter((p): p is string => !!p),
		);
	}

	/**
	 * The last check before a scan or an activation: a fresh `iw dev` read,
	 * failing closed. The radio and its phy must not be in AP mode, and the
	 * phy must not be a holder's.
	 */
	async #mayActNow(r: RadioRecord): Promise<boolean> {
		let mode: RadioMode | undefined;
		try {
			mode = await this.#ports.radioMode(r.ifname);
		} catch {
			return false;
		}
		if (mode?.apOnPhy !== false) return false;
		return !(mode.phy !== null && this.#holderPhys().has(mode.phy));
	}

	#assignRoles(): void {
		const clients = this.#radios.filter((r) => r.role !== "hotspot-reserved");
		for (const r of clients) {
			if (
				(r.role === "assister" || r.role === "standby") &&
				!this.#associated(r) &&
				!r.heldOut
			)
				r.role = "searcher";
			// A holder keeps its role while it holds its BSSID, even through a
			// lease renewal without an address: losing the role would make it a
			// scan target.
			if (r.role === "holder" && !r.obs?.bssid) {
				r.role = "searcher";
				r.samples = [];
				this.#lastOutcome = `holder-lost:${r.ifname}`;
			}
			// A radio NetworkManager connected on its own is in the bond already.
			if (
				r.role === "searcher" &&
				!r.owned &&
				!r.heldOut &&
				this.#associated(r)
			)
				r.role = "assister";
		}
		if (this.#holders().length > 0) return;
		// No holder: the first round, or every holder lost its AP. Promote the
		// strongest carrying radio. Its traffic is already in the bond, so this
		// changes protection, not the data path.
		const carrying = clients
			.filter(
				(r) =>
					(r.role === "assister" || r.role === "standby") &&
					this.#associated(r) &&
					!r.heldOut,
			)
			.sort((a, b) => (b.obs?.signalDbm ?? -200) - (a.obs?.signalDbm ?? -200));
		const best = carrying[0];
		if (best) {
			best.role = "holder";
			if (this.#started) this.#lastOutcome = `promoted:${best.ifname}`;
		}
		this.#protectFromScans();
	}

	#holderUplinks(): UplinkIdentity[] {
		return this.#holders()
			.map((h) => h.uplink)
			.filter((u): u is UplinkIdentity => u !== null);
	}

	/**
	 * Remember each associated path's uplink by BSSID, as an identity rather
	 * than a relation: the holders change, and a BSSID that shared the old
	 * holder's router may be the diverse path for the next one.
	 */
	#refreshDiversity(now: number): void {
		const holders = this.#holderUplinks();
		for (const r of this.#radios) {
			if (r.uplink && r.obs?.bssid)
				this.#learned.set(normalizeBssid(r.obs.bssid), {
					uplink: r.uplink,
					at: now,
					macAt: r.uplinkMacAt,
				});
			r.diversity =
				r.role === "holder" || !r.uplink
					? null
					: diversityAgainst(r.uplink, holders);
		}
	}

	/** Learned BSSIDs judged against the current holders; expired ones dropped. */
	#learnedDiversity(now: number): Map<string, Diversity> {
		const holders = this.#holderUplinks();
		const out = new Map<string, Diversity>();
		for (const [bssid, e] of this.#learned) {
			if (now - e.at > this.#policy.learnedTtlMs) {
				this.#learned.delete(bssid);
				continue;
			}
			const macFresh =
				e.macAt !== null && now - e.macAt <= this.#policy.learnedTtlMs;
			const uplink = macFresh ? e.uplink : { ...e.uplink, gatewayMac: null };
			out.set(bssid, diversityAgainst(uplink, holders));
		}
		return out;
	}

	#recentFailures(now: number): Map<string, number> {
		const out = new Map<string, number>();
		for (const [bssid, f] of this.#failed) {
			if (now - f.at > this.#policy.failureMemoryMs) this.#failed.delete(bssid);
			else out.set(bssid, f.count);
		}
		return out;
	}

	#noteFailure(bssid: string): void {
		const prev = this.#failed.get(bssid);
		this.#failed.set(bssid, {
			count: (prev?.count ?? 0) + 1,
			at: this.#ports.now(),
		});
	}

	async #round(): Promise<void> {
		await this.#observeAll();
		this.#publishOwnership();
		await this.#retryAbandons();
		this.#assignRoles();
		this.#started = true;
		for (const r of this.#radios) {
			// A verified owned join whose association went away is just gone.
			// Gone means the BSSID or the activation changed, not a missing
			// address: a lease renewal must not tear down a working station.
			const o = r.owned;
			if (
				o?.verified &&
				r.role !== "hotspot-reserved" &&
				r.obs !== undefined &&
				(r.obs.bssid === null ||
					normalizeBssid(r.obs.bssid) !== o.bssid ||
					(r.obs.activationRead && r.obs.activation !== o.activation))
			) {
				r.owned = null;
				this.#protectFromScans();
				await this.#abandon(r, o.activation);
			}
		}
		const now = this.#ports.now();

		if (this.#holders().length === 0) {
			// Every holder is gone. A replacement that is joining is now the best
			// path there is: verify it at once and promote it, never discard it.
			for (const r of this.#radios)
				if (r.owned && !r.owned.verified && r.role !== "hotspot-reserved")
					await this.#verify(r, now);
			this.#assignRoles();
		}
		this.#protectFromScans();
		this.#refreshDiversity(now);

		if (this.#holders().length === 0) {
			// Nothing carries. Recovery belongs to NetworkManager and the bond:
			// every radio back in the bond, except a replacement still inside its
			// verify window, which joins the bond when it verifies.
			for (const r of this.#radios)
				if (!(r.owned && !r.owned.verified)) this.#release(r);
			this.#protectFromScans();
			this.#lastOutcome = "no-holder";
			this.#dropSwap("no-holder");
			return;
		}

		this.#continuity(now);

		for (const r of this.#radios)
			if (r.owned && !r.owned.verified && r.role !== "hotspot-reserved")
				await this.#verify(r, now);
		// A station frozen on a reserved radio waits for its AP to go; it must
		// not stop the other radios from searching meanwhile.
		if (
			this.#departure ||
			this.#radios.some(
				(r) => r.owned && !r.owned.verified && r.role !== "hotspot-reserved",
			)
		)
			return;

		const condition = this.#worstHolderCondition(now);
		// Two interfaces on one phy share its radio: scanning one stalls the other.
		const holderPhys = this.#holderPhys();
		const mayAct = (r: RadioRecord) =>
			r.obs !== undefined &&
			r.obs.apOnPhy === false &&
			now >= r.restUntil &&
			!(r.obs.phy && holderPhys.has(r.obs.phy));
		// Idle radios take turns, least recently searched first, so one radio
		// whose scans fail or find nothing cannot take every search.
		// Idle means no association at all: a radio that holds a BSSID without
		// an address (a lease renewal, an IPv6-only network) is not scanned.
		const idle = this.#radios
			.filter(
				(r) => r.role === "searcher" && !r.obs?.bssid && !r.owned && mayAct(r),
			)
			.sort((a, b) => a.searchedAt - b.searchedAt)[0];
		// A carrying radio is recalled only when its path adds nothing the
		// holders lack: on a fade, one sharing a holder's BSSID; otherwise one
		// on the same uplink. A diverse assister keeps carrying.
		const holderBssids = new Set(
			this.#holders().map((h) => normalizeBssid(h.obs?.bssid ?? "")),
		);
		const recallable = this.#radios.find(
			(r) =>
				(r.role === "assister" || r.role === "searcher") &&
				this.#associated(r) &&
				mayAct(r) &&
				(condition === "fade"
					? holderBssids.has(normalizeBssid(r.obs?.bssid ?? ""))
					: r.diversity === "same-uplink" || r.diversity === "unknown"),
		);
		const radio = idle ?? recallable;
		if (!radio) return;
		// Withdrawing a carrying radio needs proven headroom, or a fade that makes
		// it necessary. An idle radio costs the bond nothing to scan with.
		const effective: HolderCondition =
			radio === idle && condition === "steady" ? "headroom" : condition;
		if (!searchDue(now, effective, this.#clock, this.#policy)) return;
		await this.#search(
			radio,
			condition === "fade" ? "continuity" : "diversity",
		);
	}

	/**
	 * Continuity on the sender's arrival reports: record the snapshot, relabel
	 * a dead holder at once, then advance the handover in progress or start one
	 * for a fading holder. Without arrival reports nothing here acts.
	 */
	#continuity(now: number): void {
		const snap = this.#ports.senderLinks?.();
		if (!snap) {
			this.#history = [];
			this.#dropSwap("no-arrival-reports");
			return;
		}
		this.#history.push(snap);
		while (
			this.#history.length > 0 &&
			(this.#history[0] as Snapshot).at < snap.at - this.#historyMs
		)
			this.#history.shift();
		for (const h of this.#holders()) {
			const judged = evaluateHolder(this.#history, h.ifname, this.#proofPolicy);
			if (judged.dead) this.#abruptLoss(h, now);
		}
		if (this.#swap) this.#driveSwap(now);
		else this.#maybeStartSwap(now);
	}

	/** The reducer's view of a radio's path; `null` when it has none. */
	#epochOf(r: RadioRecord): Epoch | null {
		const o = r.obs;
		if (!o?.bssid || !o.address || !o.activation) return null;
		return {
			bssid: normalizeBssid(o.bssid),
			lease: o.address,
			routeGeneration: o.routed ? 1 : 0,
			activation: o.activation,
		};
	}

	/** Losing ACKs while delivering is a fade, as is the sender giving up on it. */
	#holderFading(h: RadioRecord, now: number): boolean {
		const condition = classifyHolder(
			this.#ports.holderHealth(h.ifname),
			signalSlope(h.samples, now, this.#policy.slopeWindowMs),
			this.#policy,
		);
		if (condition === "fade") return true;
		const judged = evaluateHolder(this.#history, h.ifname, this.#proofPolicy);
		return judged.fading || judged.verdict === "fail";
	}

	#swapCooledDown(r: RadioRecord, now: number): boolean {
		const bssid = r.obs?.bssid;
		if (!bssid) return true;
		const c = this.#swapCooldown.get(normalizeBssid(bssid));
		return c !== undefined && now < c.until;
	}

	#coolDown(r: RadioRecord, now: number): void {
		const bssid = r.obs?.bssid;
		if (!bssid) return;
		const key = normalizeBssid(bssid);
		const count = (this.#swapCooldown.get(key)?.count ?? 0) + 1;
		const step =
			SWAP_COOLDOWN_MS[Math.min(count, SWAP_COOLDOWN_MS.length) - 1] ??
			SWAP_COOLDOWN_MS[0];
		this.#swapCooldown.set(key, { count, until: now + step });
	}

	/**
	 * A carrying assister on another BSSID than the holder (an assister on the
	 * holder's own AP shares its fade), diverse paths first, then signal.
	 * `distinct-gateway` only orders candidates here: a promotion still needs a
	 * fading holder and a proof.
	 */
	#continuityCandidate(h: RadioRecord, now: number): RadioRecord | undefined {
		const holderBssid = normalizeBssid(h.obs?.bssid ?? "");
		return this.#radios
			.filter(
				(r) =>
					(r.role === "assister" || r.role === "standby") &&
					this.#associated(r) &&
					!r.heldOut &&
					normalizeBssid(r.obs?.bssid ?? "") !== holderBssid &&
					!this.#swapCooledDown(r, now),
			)
			.sort(
				(a, b) =>
					DIVERSITY_RANK[a.diversity ?? "unknown"] -
						DIVERSITY_RANK[b.diversity ?? "unknown"] ||
					(b.obs?.signalDbm ?? -200) - (a.obs?.signalDbm ?? -200),
			)[0];
	}

	#maybeStartSwap(now: number): void {
		const fading = this.#holders().find((h) => this.#holderFading(h, now));
		if (!fading) return;
		const candidate = this.#continuityCandidate(fading, now);
		if (!candidate) return;
		const holderEpoch = this.#epochOf(fading);
		const candidateEpoch = this.#epochOf(candidate);
		if (!holderEpoch || !candidateEpoch) return;
		this.#swap = {
			op: new SwapOperation({
				holder: fading.ifname,
				candidate: candidate.ifname,
				holderEpoch,
				candidateEpoch,
				target: "receiver",
				now,
				timings: this.#swapTimings,
			}),
			holder: fading,
			candidate,
			span: null,
			preFade: preFadeBondRate(this.#history, now, this.#proofPolicy),
			promoted: false,
		};
		this.#lastSwapOutcome = `proving:${candidate.ifname}`;
	}

	/** Links carrying in the bond right now, for the candidate's fair share. */
	#carryingLinks(snap: Snapshot | undefined): number {
		if (!snap) return 1;
		let n = 0;
		for (const l of [...snap.radios.values(), ...snap.others.values()])
			if (l.connected && !l.timedOut) n++;
		return Math.max(1, n);
	}

	#driveSwap(now: number): void {
		const s = this.#swap as Swap;
		const op = s.op;
		// The old holder gone mid-handover: the candidate keeps what it has (a
		// promoted one stays holder), and the slice-1 path handles the rest.
		if (this.#epochOf(s.holder) === null || s.holder.role !== "holder") {
			this.#dropSwap(`holder-gone:${s.holder.ifname}`);
			return;
		}
		if (
			!s.promoted &&
			(!this.#holderFading(s.holder, now) ||
				s.candidate.role !== "assister" ||
				s.candidate.heldOut)
		) {
			this.#dropSwap(`not-needed:${s.candidate.ifname}`);
			return;
		}
		const effects: Effect[] = [];
		const candidateEpoch = this.#epochOf(s.candidate);
		if (!sameEpoch(candidateEpoch, op.state.paths[CANDIDATE].epoch))
			effects.push(...op.identity(now, CANDIDATE, candidateEpoch));
		const holderEpoch = this.#epochOf(s.holder);
		if (!sameEpoch(holderEpoch, op.state.paths[HOLDER].epoch))
			effects.push(...op.identity(now, HOLDER, holderEpoch));
		effects.push(...op.tick(now));
		const latest = this.#history.at(-1);
		const cl = latest?.radios.get(s.candidate.ifname);
		const hl = latest?.radios.get(s.holder.ifname);
		const candidateSocket = cl ? String(cl.epoch) : null;
		const holderSocket = hl ? String(hl.epoch) : null;
		if (!op.ended && !s.promoted) {
			if (s.span === null) {
				if (candidateSocket !== null) {
					effects.push(...op.startSpan(now, candidateSocket, holderSocket));
					s.span = { candidate: candidateSocket, holder: holderSocket };
				}
			} else {
				const proof = evaluateCandidate(
					this.#history,
					s.candidate.ifname,
					{
						carrying: this.#carryingLinks(latest),
						encoderBps: this.#ports.encoderRate?.() ?? null,
						preFadeBondPacketsPerS: s.preFade,
					},
					this.#proofPolicy,
				);
				if (proof.verdict !== "open") {
					const holder = evaluateHolder(
						this.#history,
						s.holder.ifname,
						this.#proofPolicy,
					);
					const step = op.endSpan(
						now,
						{
							candidate: proof.verdict,
							holder: holder.verdict,
							independentFailed: independentLinkFailed(
								this.#history,
								new Set([s.holder.ifname, s.candidate.ifname]),
								this.#proofPolicy,
							),
						},
						s.span.candidate,
						s.span.holder,
					);
					s.span = null;
					effects.push(...step.effects);
					if (step.conclusion === "proven") effects.push(...op.swap(now));
					else if (step.conclusion === "candidate-failed") {
						this.#coolDown(s.candidate, now);
						this.#dropSwap(
							`candidate-failed:${s.candidate.ifname}:${proof.reason}`,
						);
						return;
					} else if (step.conclusion === "common-target") {
						this.#dropSwap("common-target");
						return;
					}
				}
			}
		} else if (!op.ended) {
			// Through traffic and linger the new holder is judged like a holder:
			// delivery, continuity and age, never the headroom estimate, which
			// lags while its share jumps.
			const judged = evaluateHolder(
				this.#history,
				s.candidate.ifname,
				this.#proofPolicy,
			);
			if (judged.verdict === "fail") {
				// The new holder failing is the candidate's failure: undo, and
				// keep its BSSID out of the next attempts for a while.
				this.#coolDown(s.candidate, now);
				effects.push(...op.cancel(now));
			} else if (judged.verdict === "pass" && candidateSocket !== null)
				effects.push(...op.renew(now, candidateSocket));
		}
		this.#applySwapEffects(now, effects);
		// Traffic before demotion: as soon as the promoted candidate is seen
		// carrying (registered, ACKs coming back), in the same round.
		if (
			!op.ended &&
			s.promoted &&
			op.phase === "traffic" &&
			candidateEpoch !== null &&
			cl?.connected &&
			cl.ageMs !== null
		)
			this.#applySwapEffects(now, op.traffic(now, candidateEpoch));
		if (op.ended && this.#swap === s) {
			this.#swap = null;
			this.#lastSwapOutcome = `${op.endReason ?? "ended"}:${s.candidate.ifname}`;
		}
	}

	/**
	 * Carry out the reducer's commands. Promotion, demotion and release are
	 * relabels of this coordinator's own roles (mode R): the bond membership
	 * does not change, so each is confirmed as soon as the roles and the scan
	 * protection are republished.
	 */
	#applySwapEffects(now: number, effects: readonly Effect[]): void {
		const s = this.#swap;
		if (!s) return;
		const queue = [...effects];
		for (let e = queue.shift(); e !== undefined; e = queue.shift()) {
			switch (e.action) {
				case "promote":
					s.candidate.role = "holder";
					s.promoted = true;
					this.#lastOutcome = `promoted:${s.candidate.ifname}`;
					break;
				case "demote":
					// The old holder keeps carrying through the linger.
					break;
				case "disconnect":
					// Release: the old holder carries on as an assister.
					if (s.holder.role === "holder")
						s.holder.role = this.#associated(s.holder)
							? "assister"
							: "searcher";
					this.#lastOutcome = `released:${s.holder.ifname}`;
					break;
				case "cancel-drain-restore":
					if (s.candidate.role === "holder")
						s.candidate.role = this.#associated(s.candidate)
							? "assister"
							: "searcher";
					s.promoted = false;
					this.#lastOutcome = `restored:${s.holder.ifname}`;
					break;
				default:
					// The swap never asks a radio to depart.
					continue;
			}
			this.#protectFromScans();
			queue.push(...s.op.ack(now, e.command, true));
		}
	}

	/**
	 * A holder the receiver no longer hears from while another link still gets
	 * ACKs. Any handover involving it ends first (a dead radio has nothing to
	 * restore). Then the best currently delivering carrier becomes holder: a
	 * proven candidate first, then the most diverse, then signal. The dead
	 * radio stays in the bond as an assister: the sender already keeps traffic
	 * off it, and its probes see a recovery.
	 */
	#abruptLoss(h: RadioRecord, now: number): void {
		const proven = this.#swap?.op.candidateProven
			? this.#swap.candidate
			: undefined;
		if (this.#swap && (this.#swap.holder === h || this.#swap.candidate === h)) {
			this.#swap.op.identity(
				now,
				this.#swap.holder === h ? HOLDER : CANDIDATE,
				null,
			);
			this.#dropSwap(`holder-dead:${h.ifname}`);
		}
		const delivering = (r: RadioRecord) =>
			r !== h &&
			(r.role === "assister" || r.role === "standby" || r.role === "holder") &&
			this.#associated(r) &&
			!r.heldOut &&
			evaluateHolder(this.#history, r.ifname, this.#proofPolicy).verdict ===
				"pass";
		const next =
			(proven && proven !== h && delivering(proven) ? proven : undefined) ??
			this.#radios
				.filter(delivering)
				.sort(
					(a, b) =>
						DIVERSITY_RANK[a.diversity ?? "unknown"] -
							DIVERSITY_RANK[b.diversity ?? "unknown"] ||
						(b.obs?.signalDbm ?? -200) - (a.obs?.signalDbm ?? -200),
				)[0];
		if (!next) return;
		next.role = "holder";
		h.role = this.#associated(h) ? "assister" : "searcher";
		h.samples = [];
		this.#lastOutcome = `holder-dead:${h.ifname}>${next.ifname}`;
		this.#protectFromScans();
	}

	/** Forget the handover in progress, recording why. Roles stay as they are. */
	#dropSwap(outcome: string): void {
		if (!this.#swap) return;
		this.#swap.op.end();
		this.#swap = null;
		this.#lastSwapOutcome = outcome;
	}

	#worstHolderCondition(now: number): HolderCondition {
		let worst: HolderCondition = "headroom";
		for (const h of this.#holders()) {
			const c = classifyHolder(
				this.#ports.holderHealth(h.ifname),
				signalSlope(h.samples, now, this.#policy.slopeWindowMs),
				this.#policy,
			);
			if (CONDITION_RANK[c] < CONDITION_RANK[worst]) worst = c;
		}
		return worst;
	}

	/** Every holder on one BSSID with a steady signal: the box is not moving. */
	#holdersStable(now: number): boolean {
		return this.#holders().every((h) => {
			const recent = h.samples.filter(
				(s) => now - s.at <= this.#stableWindowMs,
			);
			if (recent.length < 3) return false;
			const span = (recent.at(-1)?.at ?? 0) - (recent[0]?.at ?? 0);
			const dbm = recent.map((s) => s.dbm);
			return (
				span >= this.#stableWindowMs / 2 &&
				Math.max(...dbm) - Math.min(...dbm) <= this.#stableSpreadDb
			);
		});
	}

	async #search(radio: RadioRecord, goal: SearchGoal): Promise<void> {
		const started = this.#ports.now();
		this.#clock = { ...this.#clock, lastSearchAt: started };
		this.#searches++;
		radio.searchedAt = started;
		// A holder lost during the scan was on a dying AP: keep avoiding it.
		const holderBssids = new Set(
			this.#holders()
				.map((h) => h.obs?.bssid)
				.filter((b): b is string => !!b),
		);
		this.#withdraw(radio);
		const scan = await this.#act(radio, "scan", () =>
			this.#ports.scan(radio.ifname),
		);
		const rows = scan.value;
		if (scan.stop !== null || rows === undefined) {
			if (scan.stop === null) {
				radio.scanFailures++;
				radio.restUntil =
					this.#ports.now() + joinCooldownMs(radio.scanFailures);
			}
			this.#settle(radio);
			this.#lastOutcome =
				scan.stop === "aborted" ? "scan-aborted" : (scan.stop ?? "scan-failed");
			return;
		}
		radio.scanFailures = 0;
		for (const h of this.#holders())
			if (h.obs?.bssid) holderBssids.add(h.obs.bssid);
		const now = this.#ports.now();
		const ctx = {
			holderBssids,
			savedSsids: await this.#ports.savedSsids(radio.ifname),
			learned: this.#learnedDiversity(now),
			failures: this.#recentFailures(now),
		};
		let pick = pickCandidate(rows, { ...ctx, goal }, this.#policy);
		if (
			pick &&
			normalizeBssid(pick.bssid) === normalizeBssid(radio.obs?.bssid ?? "")
		)
			pick = undefined;
		if (!pick) {
			this.#clock = {
				...this.#clock,
				emptySearches: this.#clock.emptySearches + 1,
			};
			// Assist mode: nothing new around, the box is not moving and the bond
			// has no other uplink. A spare radio adds capacity instead of idling.
			if (
				goal === "diversity" &&
				!this.#associated(radio) &&
				this.#ports.otherUplinks() === 0 &&
				this.#holdersStable(now)
			) {
				const assist = pickCandidate(
					rows,
					{ ...ctx, goal: "capacity" },
					this.#policy,
				);
				if (assist) return this.#join(radio, assist, "capacity");
			}
			this.#settle(radio);
			this.#lastOutcome = `no-candidate:${goal}`;
			return;
		}
		await this.#join(radio, pick, goal);
	}

	async #join(
		radio: RadioRecord,
		pick: ScanRow,
		goal: SearchGoal,
	): Promise<void> {
		const bssid = normalizeBssid(pick.bssid);
		const joined = await this.#act(radio, "join", () =>
			this.#ports.join(radio.ifname, pick.ssid, bssid, () =>
				this.#mayActNow(radio),
			),
		);
		if (joined.stop === null && joined.value === JOIN_REFUSED) {
			this.#settle(radio);
			this.#lastOutcome = "radio-in-ap-mode";
			return;
		}
		if (joined.stop !== null) {
			// The join never ran: the radio is busy or became a hotspot.
			this.#settle(radio);
			this.#lastOutcome = joined.stop;
			return;
		}
		if (joined.value === undefined) {
			this.#noteFailure(bssid);
			await this.#giveUp(radio, "join-failed");
			return;
		}
		if (joined.value === JOIN_REFUSED) return;
		radio.owned = {
			ssid: pick.ssid,
			bssid,
			activation: joined.value.activation,
			goal,
			verifyUntil: this.#ports.now() + this.#verifyMs,
			verified: false,
		};
		this.#protectFromScans();
		this.#lastOutcome = `joining:${goal}`;
	}

	async #verify(r: RadioRecord, now: number): Promise<void> {
		const o = r.owned;
		const obs = r.obs;
		if (!o) return;
		const holderOnIt = this.#holders().some(
			(h) => h.obs?.bssid && normalizeBssid(h.obs.bssid) === o.bssid,
		);
		if (
			obs !== undefined &&
			obs.bssid !== null &&
			normalizeBssid(obs.bssid) === o.bssid &&
			(o.goal === "capacity" || !holderOnIt) &&
			obs.bssidLocked &&
			obs.activation === o.activation &&
			obs.address !== null &&
			obs.gateway !== null &&
			obs.routed
		) {
			o.verified = true;
			r.role = "assister";
			this.#joinFailures = 0;
			this.#failed.delete(o.bssid);
			if (o.goal !== "capacity")
				this.#clock = { ...this.#clock, emptySearches: 0 };
			this.#release(r);
			this.#protectFromScans();
			this.#lastOutcome = `verified:${o.goal}:${r.diversity ?? "unknown"}`;
			return;
		}
		if (now >= o.verifyUntil) {
			this.#noteFailure(o.bssid);
			await this.#giveUp(r, "verify-timeout");
		}
	}

	async #giveUp(r: RadioRecord, outcome: string): Promise<void> {
		const owned = r.owned;
		r.owned = null;
		r.role = "searcher";
		this.#joinFailures++;
		this.#clock = {
			...this.#clock,
			notBefore: this.#ports.now() + joinCooldownMs(this.#joinFailures),
		};
		if (owned) await this.#abandon(r, owned.activation);
		this.#release(r);
		this.#lastOutcome = outcome;
	}

	#withdraw(r: RadioRecord): void {
		if (r.role === "holder" || r.role === "hotspot-reserved")
			throw new Error(`Refusing to withdraw ${r.role} ${r.ifname}`);
		r.role = "searcher";
		if (!r.heldOut) {
			r.heldOut = true;
			this.#ports.holdOutOfBond(r.ifname);
		}
		this.#protectFromScans();
	}

	#release(r: RadioRecord): void {
		if (!r.heldOut) return;
		r.heldOut = false;
		this.#ports.releaseBondHold(r.ifname);
		this.#protectFromScans();
	}

	/** Back to the bond; an associated radio carries again as an assister. */
	#settle(r: RadioRecord): void {
		this.#release(r);
		if (r.role === "searcher" && this.#associated(r)) r.role = "assister";
		this.#protectFromScans();
	}

	/**
	 * Run one interrupting action under the departure token and CeraUI's
	 * adapter lock for the radio. Only a withdrawn searcher may act, and only
	 * while neither it nor its phy is in AP mode, checked again under the lock
	 * because a hotspot start holds that lock while it activates.
	 *
	 * A scan is discarded when it overran its budget or a holder moved to
	 * another BSSID meanwhile, because its candidates were chosen against the
	 * old holder. A holder that was lost does not discard anything: that is when
	 * the search matters most. A join is bounded by its own NetworkManager wait
	 * and kept; verification decides whether it is usable.
	 */
	async #act<T>(
		r: RadioRecord,
		kind: "scan" | "join",
		action: () => Promise<T>,
	): Promise<{ value: T | undefined; stop: ActStop | null }> {
		if (this.#departure) throw new Error("A departure is already in flight");
		if (r.role !== "searcher" || !r.heldOut)
			throw new Error(`Refusing an action on ${r.role} ${r.ifname}`);
		const departure: Departure = {
			ifname: r.ifname,
			deadline: this.#ports.now() + this.#operationMs,
			holders: new Map(
				this.#holders().map((h) => [h.ifname, h.obs?.bssid ?? null]),
			),
		};
		this.#departure = departure;
		try {
			const locked = await this.#ports.withRadioLock(r.ifname, async () => {
				if (!(await this.#mayActNow(r))) return { refused: true as const };
				return { refused: false as const, value: await action() };
			});
			if (!locked.ok) return { value: undefined, stop: "radio-busy" };
			if (locked.value.refused)
				return { value: undefined, stop: "radio-in-ap-mode" };
			const value = locked.value.value;
			if (kind === "join") return { value, stop: null };
			let moved = false;
			for (const h of this.#holders()) {
				h.obs = await this.#ports.observe(h.ifname);
				const before = departure.holders.get(h.ifname);
				const after = h.obs?.bssid ?? null;
				if (before && after && normalizeBssid(before) !== normalizeBssid(after))
					moved = true;
			}
			const aborted = this.#ports.now() > departure.deadline || moved;
			return { value, stop: aborted ? "aborted" : null };
		} finally {
			this.#departure = null;
		}
	}
}
