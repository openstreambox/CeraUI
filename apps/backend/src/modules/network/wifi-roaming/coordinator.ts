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
 * - CeraUI's own rescans skip every holder.
 * - One interrupting action at a time across all radios; a radio that carries
 *   traffic leaves the bond before it scans.
 * - A searcher returns to the bond only when verified on the chosen BSSID with
 *   a lease and route, or when the attempt is abandoned.
 * - Joins use an owned profile locked to the BSSID: no background scans, no
 *   roaming back. The operator's profiles are untouched.
 * - A deadline or a holder change during an action aborts it and cleans up.
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
}>;

export type JoinResult = Readonly<{ activation: string }>;

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
}>;

export type RadioConfig = Readonly<{
	ifname: string;
	/** Serves the phone hotspot; the coordinator never touches it. */
	reserved?: "hotspot";
}>;

export type CoordinatorConfig = Readonly<{
	radios: readonly RadioConfig[];
	policy?: SearchPolicy;
	/** Budget for one scan or one join. */
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
	role: Role;
	obs: RadioObservation | undefined;
	uplink: UplinkIdentity | null;
	diversity: Diversity | null;
	owned: Owned | null;
	samples: SignalSample[];
	heldOut: boolean;
};

type Departure = { ifname: string; deadline: number; holders: string };

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
	readonly #learned = new Map<string, Diversity>();
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
			role: r.reserved === "hotspot" ? "hotspot-reserved" : "searcher",
			obs: undefined,
			uplink: null,
			diversity: null,
			owned: null,
			samples: [],
			heldOut: false,
		}));
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
			if (r.role === "hotspot-reserved") continue;
			r.obs = await this.#ports.observe(r.ifname);
			r.uplink =
				r.obs && this.#associated(r)
					? await this.#ports.uplinkOf(r.ifname, r.obs)
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

	#protectHolders(): void {
		protectRadiosFromScans(this.#holders().map((r) => r.ifname));
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

	#refreshDiversity(): void {
		const holders = this.#holders()
			.map((h) => h.uplink)
			.filter((u): u is UplinkIdentity => u !== null);
		for (const r of this.#radios) {
			if (r.role === "holder" || !r.uplink) {
				r.diversity = null;
				continue;
			}
			r.diversity = diversityAgainst(r.uplink, holders);
			if (r.obs?.bssid)
				this.#learned.set(normalizeBssid(r.obs.bssid), r.diversity);
		}
	}

	async #round(): Promise<void> {
		await this.#observeAll();
		this.#assignRoles();
		this.#started = true;
		this.#protectHolders();
		this.#refreshDiversity();
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
			// Nothing carries. Recovery belongs to NetworkManager and the bond:
			// every radio back in the bond, no scan gate.
			for (const r of this.#radios) {
				if (r.owned && !r.owned.verified) await this.#giveUp(r, "no-holder");
				this.#release(r);
			}
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
		const idle = this.#radios.find(
			(r) => r.role === "searcher" && !this.#associated(r),
		);
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
		this.#clock = { ...this.#clock, lastSearchAt: this.#ports.now() };
		this.#searches++;
		this.#withdraw(radio);
		const scan = await this.#act(radio, () => this.#ports.scan(radio.ifname));
		const rows = scan.value;
		if (scan.aborted || rows === undefined) {
			this.#settle(radio);
			this.#lastOutcome = scan.aborted ? "scan-aborted" : "scan-failed";
			return;
		}
		const holders = this.#holders();
		const ctx = {
			holderBssids: new Set(
				holders.map((h) => h.obs?.bssid).filter((b): b is string => !!b),
			),
			holderSsids: new Set(
				holders.map((h) => h.obs?.ssid).filter((s): s is string => !!s),
			),
			savedSsids: await this.#ports.savedSsids(radio.ifname),
			learned: this.#learned,
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
			const now = this.#ports.now();
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
		const joined = await this.#act(radio, () =>
			this.#ports.join(radio.ifname, pick.ssid, bssid),
		);
		if (joined.value !== undefined)
			radio.owned = {
				ssid: pick.ssid,
				bssid,
				activation: joined.value.activation,
				goal,
				verifyUntil: this.#ports.now() + this.#verifyMs,
				verified: false,
			};
		if (joined.aborted || joined.value === undefined) {
			await this.#giveUp(
				radio,
				joined.aborted ? "join-aborted" : "join-failed",
			);
			return;
		}
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
			if (o.goal !== "capacity")
				this.#clock = { ...this.#clock, emptySearches: 0 };
			this.#release(r);
			this.#lastOutcome = `verified:${o.goal}:${r.diversity ?? "unknown"}`;
			return;
		}
		if (now >= o.verifyUntil) await this.#giveUp(r, "verify-timeout");
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

	#holderKey(): string {
		return this.#holders()
			.map((h) => `${h.ifname}@${h.obs?.bssid ?? "-"}`)
			.join(",");
	}

	/**
	 * Run one interrupting action under the departure token. Only a withdrawn
	 * searcher may act. The action is aborted if it overran its budget or a
	 * holder changed while it ran.
	 */
	async #act<T>(
		r: RadioRecord,
		action: () => Promise<T>,
	): Promise<{ value: T; aborted: boolean }> {
		if (this.#departure) throw new Error("A departure is already in flight");
		if (r.role !== "searcher" || !r.heldOut)
			throw new Error(`Refusing an action on ${r.role} ${r.ifname}`);
		const departure: Departure = {
			ifname: r.ifname,
			deadline: this.#ports.now() + this.#operationMs,
			holders: this.#holderKey(),
		};
		this.#departure = departure;
		try {
			const value = await action();
			for (const h of this.#holders())
				h.obs = await this.#ports.observe(h.ifname);
			const aborted =
				this.#ports.now() > departure.deadline ||
				this.#holderKey() !== departure.holders;
			return { value, aborted };
		} finally {
			this.#departure = null;
		}
	}
}
