import { advanceHeat, initialHeat } from "./heat-ladder.ts";

/** Producer seam: rates share a unit; loss is a fraction. All windows are
 * measured by the producer, never inferred from interface names or a phone SIM.
 * No production producer or hardware effects are registered here. */
export interface BoxSample {
	now: number;
	soc: number | null;
	session: string;
	carrying: boolean;
	encoder: boolean;
	keepQuality: boolean;
	at: number;
	streamAt: number;
	rate: number;
	rate60: number;
	rtt: number;
	rttMedian: number;
	/** True only when routed phone flows and every owned relay leg are accounted for. */
	pathsComplete: boolean;
	phone: string | null;
	phoneVerified: boolean;
	links: {
		id: string;
		rate: number;
		provenRate: number;
		loss: number;
		rtt: number;
		rttMedian: number;
		recovering: boolean;
		phoneUplink: boolean;
		temperature: number | null;
	}[];
	clients: {
		id: string;
		bound: boolean;
		ipv4Only: boolean;
		joinedAt: number;
		management: boolean;
		streaming: boolean;
		receiverFlow: boolean;
		lastCarryingAt: number;
		trafficKbps: number;
	}[];
}
export interface BoxPlan {
	usb: boolean;
	lend: string | null;
	pause: string[];
}
const positive = (n: number) => Number.isFinite(n) && n > 0;
const nonnegative = (n: number) => Number.isFinite(n) && n >= 0;
const fresh = (now: number, at: number, age: number) =>
	Number.isFinite(at) && now >= at && now - at <= age;

/** Session-only desired state, deliberately separate from confirmed effects.
 * A consumer must re-read under its owner's lock and acknowledge restoration.
 * The existing USB owner and bounded client lease retain their own admission.
 * No timer, persistence, shell command, or hardware source is owned here. */
export class LinkBoxHeatPolicy {
	private heat = initialHeat();
	private session = "";
	private lastAt: number | null = null;
	private candidate = new Map<string, number>();
	private large = new Map<string, number | null>();
	private locked = new Map<string, number>();
	private clientLocked = new Map<string, number>();
	private exempt = new Set<string>();
	private loan: {
		id: string;
		rate: number;
		rtt: number;
		peers: string[];
	} | null = null;
	private paused: string[] = [];
	private badAt: number | null = null;
	private rollbacks = 0;
	private lastPause = -Infinity;
	private unknown = true;
	readonly timeline: { at: number; reason: string }[] = [];

	letBackOn(id: string): void {
		this.exempt.add(id);
	}
	private release(now: number, reason: string, rollback: boolean): void {
		if (this.loan || this.paused.length) {
			this.timeline.push({ at: now, reason });
			// Bounded diagnostics, independent of the duration of the show.
			if (this.timeline.length > 100) this.timeline.shift();
		}
		for (const id of this.paused) this.clientLocked.set(id, now + 600000);
		this.paused = [];
		if (this.loan && rollback) {
			this.locked.set(this.loan.id, now + 900000);
			this.rollbacks++;
		}
		this.loan = null;
		this.badAt = null;
		this.candidate.clear();
	}
	tick(s: BoxSample): BoxPlan {
		const now = s.now;
		const result: BoxPlan = { usb: false, lend: null, pause: [] };
		if (!Number.isFinite(now)) {
			this.unknown = true;
			for (const id of this.large.keys()) this.large.set(id, null);
			this.release(this.lastAt ?? 0, "unknown clock", true);
			return result;
		}
		const changed = this.session !== s.session;
		const gap =
			this.lastAt !== null && (now < this.lastAt || now - this.lastAt > 2000);
		this.lastAt = now;
		if (changed) {
			this.release(now, "session changed", false);
			this.heat = initialHeat();
			this.session = s.session;
			this.locked.clear();
			this.clientLocked.clear();
			this.exempt.clear();
			this.large.clear();
			this.rollbacks = 0;
		}
		if (gap) this.candidate.clear();
		if (!s.session || !s.carrying || s.encoder) {
			this.release(now, "carrying ended", false);
			this.heat = initialHeat();
			return result;
		}
		this.heat = advanceHeat(this.heat, { soc: s.soc }, now);
		result.usb = !this.heat.unknown && this.heat.stage >= 1;
		const ids = s.links.map((l) => l.id);
		const valid =
			s.pathsComplete === true &&
			fresh(now, s.at, 2000) &&
			fresh(now, s.streamAt, 3000) &&
			positive(s.rate) &&
			positive(s.rate60) &&
			positive(s.rtt) &&
			positive(s.rttMedian) &&
			ids.every(Boolean) &&
			new Set(ids).size === ids.length &&
			s.links.length >= 3 &&
			s.links.every(
				(l) =>
					nonnegative(l.rate) &&
					nonnegative(l.provenRate) &&
					nonnegative(l.loss) &&
					l.loss <= 1 &&
					positive(l.rtt) &&
					positive(l.rttMedian),
			);
		this.unknown = !valid;
		if (!valid || this.heat.unknown || s.keepQuality || gap) {
			// Unknown time is never observed time below a protection threshold.
			for (const id of this.large.keys()) this.large.set(id, null);
			this.release(
				now,
				s.keepQuality ? "keep quality" : "unknown observations",
				true,
			);
			return result;
		}
		for (const id of this.candidate.keys())
			if (!ids.includes(id)) this.candidate.delete(id);
		const largest = Math.max(...s.links.map((l) => l.rate));
		for (const l of s.links) {
			const share = l.rate / s.rate;
			if (share >= 0.4 || l.rate === largest) this.large.set(l.id, null);
			else if (this.large.has(l.id)) {
				if (share >= 0.3) this.large.set(l.id, null);
				else {
					const since = this.large.get(l.id) ?? now;
					this.large.set(l.id, since);
					if (now - since >= 60000) this.large.delete(l.id);
				}
			}
		}
		let rolledBack = false;
		if (this.loan) {
			const leg = s.links.find((l) => l.id === this.loan?.id);
			const peers = s.links.filter((l) => l.id !== this.loan?.id);
			const missing = this.loan.peers.some(
				(id) => !peers.some((l) => l.id === id),
			);
			const bad =
				s.rtt >= this.loan.rtt * 1.5 ||
				peers.some((l) => l.loss > 0.05 || l.rtt >= l.rttMedian * 2);
			if (bad) this.badAt ??= now;
			else this.badAt = null;
			const unsafe =
				!leg ||
				leg.phoneUplink ||
				leg.recovering ||
				this.large.has(leg.id) ||
				missing ||
				peers.some((l) => l.recovering) ||
				s.rate <= this.loan.rate * 0.85 ||
				(this.badAt !== null && now - this.badAt >= 5000);
			if (unsafe) {
				this.release(now, "stream protection rollback", true);
				rolledBack = true;
			}
		}
		// Cooling sheds restrictions in reverse order; the thermal reducer spaces
		// downward transitions by two minutes after a five-minute minimum hold.
		if (this.heat.stage < 3 && this.paused.length) {
			for (const id of this.paused) this.clientLocked.set(id, now + 600000);
			this.paused = [];
		}
		if (this.heat.stage < 2) this.release(now, "cooled", false);
		if (
			!this.loan &&
			!rolledBack &&
			this.heat.stage >= 2 &&
			this.rollbacks < 2
		) {
			const candidates = s.links
				.filter((l) => {
					const peers = s.links.filter(
						(p) =>
							p.id !== l.id &&
							!p.recovering &&
							p.loss <= 0.02 &&
							p.rtt <= p.rttMedian * 1.5,
					);
					const safe =
						!l.phoneUplink &&
						!l.recovering &&
						!this.large.has(l.id) &&
						l.rate / s.rate <= 0.15 &&
						l.loss <= 0.02 &&
						l.rtt <= l.rttMedian * 1.5 &&
						peers.length >= 2 &&
						peers.reduce(
							(sum, p) => sum + Math.max(0, p.provenRate - p.rate),
							0,
						) >=
							l.rate * 1.3 &&
						s.rate >= s.rate60 * 0.95 &&
						s.rtt <= s.rttMedian * 1.3 &&
						now >= (this.locked.get(l.id) ?? -Infinity);
					if (!safe) {
						this.candidate.delete(l.id);
						return false;
					}
					this.candidate.set(l.id, this.candidate.get(l.id) ?? now);
					return now - (this.candidate.get(l.id) ?? now) >= 60000;
				})
				.sort(
					(a, b) =>
						(Number.isFinite(b.temperature)
							? (b.temperature ?? -Infinity)
							: -Infinity) -
							(Number.isFinite(a.temperature)
								? (a.temperature ?? -Infinity)
								: -Infinity) ||
						a.rate - b.rate ||
						a.id.localeCompare(b.id),
				);
			const leg = candidates[0];
			if (leg) {
				this.loan = {
					id: leg.id,
					rate: s.rate60,
					rtt: s.rtt,
					peers: ids.filter((id) => id !== leg.id),
				};
				this.candidate.clear();
				this.lastPause = now; // one visible step per tick
			}
		}
		const clientIds = s.clients.map((c) => c.id);
		const clientsKnown =
			s.phoneVerified &&
			!!s.phone &&
			clientIds.includes(s.phone) &&
			new Set(clientIds).size === clientIds.length;
		const safeClient = (c: BoxSample["clients"][number]) =>
			clientsKnown &&
			c.id !== s.phone &&
			!!c.id &&
			c.bound &&
			c.ipv4Only &&
			!c.management &&
			!c.streaming &&
			!c.receiverFlow &&
			fresh(now, c.joinedAt, Infinity) &&
			now - c.joinedAt >= 120000 &&
			Number.isFinite(c.lastCarryingAt) &&
			now - c.lastCarryingAt > 120000 &&
			!this.exempt.has(c.id);
		this.paused = this.paused.filter((id) => {
			if (s.clients.some((c) => c.id === id && safeClient(c))) return true;
			this.clientLocked.set(id, now + 600000);
			return false;
		});
		// Conservative single-client limit matches the existing one-target lease.
		// This draft requires an active loan before considering a client pause.
		if (
			this.heat.stage >= 3 &&
			!rolledBack &&
			!this.paused.length &&
			now > this.lastPause &&
			this.loan
		) {
			const c = s.clients
				.filter(
					(c) =>
						safeClient(c) &&
						positive(c.trafficKbps) &&
						c.trafficKbps > 100 &&
						now >= (this.clientLocked.get(c.id) ?? -Infinity),
				)
				.sort(
					(a, b) => b.trafficKbps - a.trafficKbps || a.id.localeCompare(b.id),
				)[0];
			if (c) {
				this.paused = [c.id];
				this.lastPause = now;
			}
		}
		result.lend = this.loan?.id ?? null;
		result.pause = [...this.paused];
		return result;
	}
	status(confirmed: Pick<BoxPlan, "lend" | "pause">): string {
		if (confirmed.pause.length)
			return "Very hot box: paused internet for one other device on its Wi-Fi. Your phone's stream keeps its links. Open the bag or find shade.";
		if (confirmed.lend)
			return "The box is hot, so it stopped using one link for now. Your phone's stream carries on over the other links. Give the box air.";
		if (this.heat.stage >= 2)
			return this.unknown
				? "The box is hot. It can't see how your stream uses its links, so it keeps them all. Give it air."
				: "The box is hot. It keeps all its links for your stream. Give it air.";
		return this.heat.stage ? "The box is warm. Give it air." : "";
	}
}

/** There are intentionally no native defaults. A host owner must check safe()
 * again under its mutation lock. returnLink resolves true only after identity,
 * tunnel and ACK confirmation; a failed or timed-out return is retried. The
 * pause owner uses the existing five-second kernel lease, never AP shutdown. */
export interface BoxHeatEffects {
	spareUsb(eligible: boolean): Promise<void>;
	lend(id: string, safe: () => boolean): Promise<boolean>;
	returnLink(id: string): Promise<boolean>;
	pause(id: string | null, safe: () => boolean): Promise<boolean>;
}
export class LinkBoxHeatSession {
	private readonly policy = new LinkBoxHeatPolicy();
	private confirmed: Pick<BoxPlan, "lend" | "pause"> = {
		lend: null,
		pause: [],
	};
	private returning: string | null = null;
	private lastSample: BoxSample | null = null;
	private tail: Promise<unknown> = Promise.resolve();
	constructor(private readonly effects: BoxHeatEffects) {}
	letBackOn(id: string): void {
		this.policy.letBackOn(id);
	}
	update(read: () => BoxSample) {
		const next = this.tail.then(() => this.apply(read));
		this.tail = next.catch(() => {
			// Keep serialization usable while returning the original rejection to the caller.
		});
		return next;
	}
	private async apply(read: () => BoxSample) {
		let sample: BoxSample;
		try {
			sample = structuredClone(read());
			this.lastSample = sample;
		} catch {
			if (!this.lastSample) return this.snapshot();
			sample = { ...this.lastSample, pathsComplete: false, soc: null };
		}
		const plan = this.policy.tick(
			this.returning ? { ...sample, keepQuality: true } : sample,
		);
		const safe = (kind: "lend" | "pause", id: string) => () => {
			let current: BoxSample;
			try {
				current = read();
			} catch {
				return false;
			}
			if (
				current.session !== sample.session ||
				current.now < sample.now ||
				current.now - sample.now > 1000
			)
				return false;
			const latest = this.policy.tick(current);
			return kind === "lend" ? latest.lend === id : latest.pause.includes(id);
		};
		// Withdraw in reverse order and block new restrictions until restoration is
		// confirmed. A rejected write keeps ownership so the next update retries.
		if (this.confirmed.lend && this.confirmed.lend !== plan.lend)
			this.returning = this.confirmed.lend;
		if (this.confirmed.pause.some((id) => !plan.pause.includes(id))) {
			if (!(await this.effects.pause(null, () => true))) return this.snapshot();
			this.confirmed.pause = [];
		}
		if (this.returning) {
			if (!(await this.effects.returnLink(this.returning)))
				return this.snapshot();
			this.returning = null;
			this.confirmed.lend = null;
			return this.snapshot();
		}
		await this.effects.spareUsb(plan.usb);
		if (
			plan.lend &&
			!this.confirmed.lend &&
			(await this.effects.lend(plan.lend, safe("lend", plan.lend)))
		)
			this.confirmed.lend = plan.lend;
		const client = plan.pause[0];
		if (
			client &&
			this.confirmed.lend === plan.lend &&
			(await this.effects.pause(client, safe("pause", client)))
		)
			this.confirmed.pause = [client];
		return this.snapshot();
	}
	private snapshot() {
		return {
			...this.confirmed,
			pause: [...this.confirmed.pause],
			returning: this.returning,
			status: this.returning
				? "One link hasn't come back yet. The box keeps trying. Your phone's stream uses the other links."
				: this.policy.status(this.confirmed),
		};
	}
}
