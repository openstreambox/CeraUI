/**
 * Station-based coordinated Wi-Fi roaming for the SRTLA bond.
 *
 * Any number of client radios, each with a role (see `Role` in policy.ts).
 * Holders carry the stream and are never disturbed on purpose. One other radio
 * at a time may scan and join another network, chosen for continuity when a
 * holder fades, for uplink diversity while holders have headroom, or for extra
 * capacity when nothing new is around (assist mode).
 *
 * This first part covers roles, search, join, path verification and learning
 * which uplink a path uses. A verified path rejoins the bond as an assister.
 * Proof at the stream rate, promotion to holder, linger and release follow in
 * the next part.
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
import { protectRadiosFromScans } from "./scan-gate.ts";

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
	/** UUID of the active NetworkManager profile. */
	activation: string | null;
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
	/** Activate an owned profile on this radio, locked to `bssid`. */
	join(
		ifname: string,
		ssid: string,
		bssid: string,
	): Promise<JoinResult | undefined>;
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

export type CoordinatorStatus = Readonly<{
	radios: readonly RadioStatus[];
	searches: number;
	lastSearchAt: number | null;
	lastOutcome: string | null;
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

type Learned = { uplink: UplinkIdentity; at: number };

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
	#clock: SearchClock = FRESH_SEARCH_CLOCK;
	#joinFailures = 0;
	#searches = 0;
	#lastOutcome: string | null = null;
	#departure: Departure | null = null;
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
		this.#radios = config.radios.map((r) => ({
			ifname: r.ifname,
			reserved: r.reserved === "hotspot",
			role: r.reserved === "hotspot" ? "hotspot-reserved" : "searcher",
			obs: undefined,
			uplink: null,
			diversity: null,
			owned: null,
			samples: [],
			heldOut: false,
			searchedAt: Number.NEGATIVE_INFINITY,
			scanFailures: 0,
			restUntil: 0,
		}));
		this.#publishOwnership();
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
		};
	}

	/** Release every gate. Radios keep whatever association they have. */
	stop(): void {
		this.#stopped = true;
		for (const r of this.#radios) this.#release(r);
		protectRadiosFromScans([]);
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
			if (r.role === "hotspot-reserved") r.role = "searcher";
			r.uplink =
				r.obs && this.#associated(r)
					? this.#withKnownMac(
							r.obs,
							await this.#ports.uplinkOf(r.ifname, r.obs),
						)
					: null;
			if (r.obs?.signalDbm != null)
				r.samples.push({ at: now, dbm: r.obs.signalDbm });
			r.samples = r.samples.filter(
				(s) =>
					now - s.at <=
					Math.max(this.#policy.slopeWindowMs, this.#stableWindowMs),
			);
		}
	}

	/** A radio that became a hotspot: drop any search state, never act on it. */
	async #reserve(r: RadioRecord): Promise<void> {
		if (r.role === "holder") this.#lastOutcome = `holder-lost:${r.ifname}`;
		r.role = "hotspot-reserved";
		r.uplink = null;
		r.diversity = null;
		r.samples = [];
		const owned = r.owned;
		r.owned = null;
		this.#release(r);
		// Deleting the owned clone touches only that profile, never the AP's.
		if (owned) await this.#ports.abandon(r.ifname, owned.activation);
	}

	/**
	 * Keep a gateway MAC learned earlier for the same BSSID, gateway and subnet.
	 * Right after a join the neighbour entry is often missing, and without it
	 * two factory-default routers would look alike.
	 */
	#withKnownMac(obs: RadioObservation, uplink: UplinkIdentity): UplinkIdentity {
		if (uplink.gatewayMac !== null || !obs.bssid) return uplink;
		const prev = this.#learned.get(normalizeBssid(obs.bssid))?.uplink;
		return prev?.gatewayMac &&
			prev.gateway === uplink.gateway &&
			prev.subnet === uplink.subnet
			? { ...uplink, gatewayMac: prev.gatewayMac }
			: uplink;
	}

	/**
	 * CeraUI's own rescans skip every radio that carries traffic, serves the
	 * hotspot or is in the middle of an owned join. Only idle searchers remain.
	 */
	#protectFromScans(): void {
		protectRadiosFromScans(
			this.#radios
				.filter((r) => r.role !== "searcher" || r.owned !== null)
				.map((r) => r.ifname),
		);
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
			if (r.role === "holder" && !this.#associated(r)) {
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
			if (now - e.at > this.#policy.learnedTtlMs) this.#learned.delete(bssid);
			else out.set(bssid, diversityAgainst(e.uplink, holders));
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
		this.#assignRoles();
		this.#started = true;
		for (const r of this.#radios) {
			// A verified owned join whose association went away is just gone.
			if (r.owned?.verified && !this.#associated(r)) {
				const gone = r.owned;
				r.owned = null;
				await this.#ports.abandon(r.ifname, gone.activation);
			}
		}
		const now = this.#ports.now();

		if (this.#holders().length === 0) {
			// Every holder is gone. A replacement that is joining is now the best
			// path there is: verify it at once and promote it, never discard it.
			for (const r of this.#radios)
				if (r.owned && !r.owned.verified) await this.#verify(r, now);
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
			this.#lastOutcome = "no-holder";
			return;
		}

		for (const r of this.#radios)
			if (r.owned && !r.owned.verified) await this.#verify(r, now);
		if (
			this.#departure ||
			this.#radios.some((r) => r.owned && !r.owned.verified)
		)
			return;

		const condition = this.#worstHolderCondition(now);
		// Two interfaces on one phy share its radio: scanning one stalls the other.
		const holderPhys = new Set(
			this.#holders()
				.map((h) => h.obs?.phy)
				.filter((p): p is string => !!p),
		);
		const mayAct = (r: RadioRecord) =>
			r.obs !== undefined &&
			r.obs.apOnPhy === false &&
			now >= r.restUntil &&
			!(r.obs.phy && holderPhys.has(r.obs.phy));
		// Idle radios take turns, least recently searched first, so one radio
		// whose scans fail or find nothing cannot take every search.
		const idle = this.#radios
			.filter((r) => r.role === "searcher" && !this.#associated(r) && mayAct(r))
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
			this.#ports.join(radio.ifname, pick.ssid, bssid),
		);
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
		radio.owned = {
			ssid: pick.ssid,
			bssid,
			activation: joined.value.activation,
			goal,
			verifyUntil: this.#ports.now() + this.#verifyMs,
			verified: false,
		};
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
		if (owned) await this.#ports.abandon(r.ifname, owned.activation);
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
	}

	#release(r: RadioRecord): void {
		if (!r.heldOut) return;
		r.heldOut = false;
		this.#ports.releaseBondHold(r.ifname);
	}

	/** Back to the bond; an associated radio carries again as an assister. */
	#settle(r: RadioRecord): void {
		this.#release(r);
		if (r.role === "searcher" && this.#associated(r)) r.role = "assister";
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
				const fresh = await this.#ports.observe(r.ifname);
				if (fresh?.apOnPhy !== false) return { refused: true as const };
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
