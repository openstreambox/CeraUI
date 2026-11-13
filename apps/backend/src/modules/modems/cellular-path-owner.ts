import type { CellularProbePath } from "../network/cellular-path-probe.ts";
import type { CellularSourceBinding } from "../network/cellular-source-state.ts";
import {
	claimCellularSource,
	setCellularSourceBinding,
	setCellularSourceReady,
	withdrawCellularSource,
} from "../network/cellular-source-state.ts";
import {
	initialPathHealth,
	observeAvailability,
	observePathProbe,
	type PathAvailability,
	type PathHealthState,
	reservePathProbe,
} from "./path-health-policy.ts";

export interface CellularPathSession {
	readonly binding: CellularSourceBinding;
	readonly dns: CellularProbePath;
	readonly valid: () => Promise<boolean>;
	/** Open only bounded probes when unready; retain an already-ready fence. */
	readonly prepareProbe: () => Promise<boolean>;
	/** A positive fence readback precedes ready publication; false denies traffic. */
	readonly setReady: (ready: boolean) => Promise<boolean>;
	/** Cancel the current probe, not future probes on an unchanged valid session. */
	readonly cancelProbe: () => void;
	/** Withdraw/reload acknowledgement precedes the kernel inverse. */
	readonly cleanup: () => Promise<boolean>;
}
export interface CellularPathOwnerDeps<Grant> {
	readonly now: () => number;
	readonly reserve: (
		bytes: number,
	) => Promise<{ readonly remaining: number } | undefined>;
	readonly capable: () => Promise<boolean>;
	readonly install: (grant: Grant) => Promise<CellularPathSession | undefined>;
	readonly probe: (
		session: CellularPathSession,
	) => Promise<"ok" | "failed" | "unavailable">;
	readonly reconnect: () => Promise<boolean>;
	readonly passiveHealthy: (session: CellularPathSession) => boolean;
}
export interface CellularPathObservation<Grant> {
	/** USB/ifindex/subscription/bearer fingerprint; absent means availability loss. */
	readonly generation?: string;
	readonly grant?: Grant;
}
/** The data-plane owner is independent of MM's object roster. A USB loss clears
 * source readiness immediately but never enters carrier-failure hysteresis.
 * Probe reservations are durable and pair-scoped, not reset with this object.
 */
export class CellularPathOwner<Grant> {
	private state: PathHealthState = initialPathHealth(0);
	private session: CellularPathSession | undefined;
	private sessionGeneration: string | undefined;
	private reconnectPending = false;
	private busy = false;
	private revision = 0;
	private observedGeneration: string | undefined;
	private observedGrantPresent = false;
	private closing = false;
	private lastSuccess = Number.NEGATIVE_INFINITY;
	private installAfter = 0;
	private _availability: PathAvailability = "usb-wait";
	constructor(
		readonly owner: string,
		readonly epoch: string,
		readonly iface: string,
		private readonly deps: CellularPathOwnerDeps<Grant>,
	) {
		claimCellularSource(owner, epoch, iface);
	}
	get availability(): PathAvailability {
		return this._availability;
	}
	get health(): Readonly<PathHealthState> {
		return { ...this.state };
	}
	withdraw(): void {
		this.session?.cancelProbe();
		this.state = { ...this.state, ready: false };
		withdrawCellularSource(this.owner, this.epoch, this.iface);
	}
	private async publish(ready: boolean): Promise<void> {
		const session = this.session,
			binding = session?.binding,
			revision = this.revision;
		if (!session || !binding) return;
		const publish = (value: boolean) =>
			setCellularSourceReady(
				this.owner,
				this.epoch,
				this.iface,
				binding.generation,
				value,
			);
		if (!ready) {
			publish(false);
			this.state = { ...this.state, ready: false };
		}
		let confirmed = false;
		try {
			confirmed = await session.setReady(ready);
		} catch {
			/* Host state stays unready. */
		}
		let valid = false;
		if (
			ready &&
			confirmed &&
			this.session === session &&
			revision === this.revision &&
			!this.closing
		) {
			try {
				valid = await session.valid();
			} catch {
				/* Unknown identity cannot publish. */
			}
		}
		if (valid && revision === this.revision && !this.closing) {
			publish(true);
			return;
		}
		publish(false);
		this.state = { ...this.state, ready: false };
		if (ready) {
			try {
				await session.setReady(false);
			} catch {
				/* Cleanup retains the inverse. */
			}
		}
	}

	async observe(observation: CellularPathObservation<Grant>): Promise<void> {
		// Availability withdrawal cannot wait behind a slow probe or installation.
		const hasGrant = observation.grant !== undefined;
		if (
			observation.generation !== this.observedGeneration ||
			hasGrant !== this.observedGrantPresent
		) {
			if (observation.generation !== this.observedGeneration)
				this.reconnectPending = false;
			this.observedGeneration = observation.generation;
			this.observedGrantPresent = hasGrant;
			this.revision++;
		}
		if (this.closing) {
			this.withdraw();
			return;
		}
		if (
			!observation.generation ||
			!hasGrant ||
			observation.generation !== this.sessionGeneration
		)
			this.withdraw();
		if (this.busy) return;
		this.busy = true;
		const revision = this.revision;
		try {
			const now = this.deps.now();
			const observed = observeAvailability(
				this.state,
				observation.generation,
				now,
			);
			this.state = observed.state;
			this._availability = observed.availability;
			if (
				this.session &&
				(!hasGrant ||
					this.sessionGeneration !== observation.generation ||
					!(await this.session.valid()))
			) {
				this.withdraw();
				if (!(await this.session.cleanup())) return;
				this.session = undefined;
				this.sessionGeneration = undefined;
				this.lastSuccess = Number.NEGATIVE_INFINITY;
				if (this.state.failures === 0 && !this.reconnectPending)
					this.state = { ...this.state, nextProbe: now };
			}
			if (
				observed.availability !== "present" ||
				!observation.generation ||
				observation.grant === undefined
			)
				return;
			const generation = observation.generation;
			if (this.reconnectPending) {
				if (now < this.state.nextProbe) return;
				this.withdraw();
				if (this.session && !(await this.session.cleanup())) return;
				this.session = undefined;
				this.sessionGeneration = undefined;
				if (await this.deps.reconnect()) {
					this.reconnectPending = false;
					this.session = undefined;
					this.sessionGeneration = undefined;
				} else {
					// Refused recovery is not permission to reset the device, and it
					// cannot suppress fresh bounded traffic proof forever either.
					this.reconnectPending = false;
					this.state = { ...this.state, nextProbe: now + 60_000 };
				}
				return;
			}
			if (!this.session) {
				if (
					now < this.installAfter ||
					now < this.state.nextProbe ||
					!(await this.deps.capable())
				)
					return;
				this.installAfter = now + 60_000;
				const session = await this.deps.install(observation.grant);
				if (!session) return;
				this.session = session;
				this.sessionGeneration = generation;
				if (revision !== this.revision || !(await session.valid())) {
					this.withdraw();
					return;
				}
				setCellularSourceBinding(
					this.owner,
					this.epoch,
					this.iface,
					session.binding,
				);
			}
			const session = this.session;
			if (revision !== this.revision || !(await session.valid())) {
				this.withdraw();
				return;
			}
			setCellularSourceBinding(
				this.owner,
				this.epoch,
				this.iface,
				session.binding,
			);
			const reserved = reservePathProbe(
				{ ...this.state, budgetRemaining: 32 * 1024 },
				generation,
				now,
				32 * 1024,
			);
			if (!reserved) return;
			const allowance = await this.deps.reserve(32 * 1024);
			if (allowance === undefined) {
				// Lack of a probe allowance is unknown, not a failed carrier. Fresh sender
				// traffic can retain readiness; an old idle verdict cannot live forever.
				if (
					!this.deps.passiveHealthy(session) &&
					now - this.lastSuccess > 600_000
				) {
					await this.publish(false);
					this.state = { ...this.state, ready: false };
				}
				this.state = { ...this.state, nextProbe: now + 300_000 };
				return;
			}
			if (revision !== this.revision || !(await session.valid())) {
				this.withdraw();
				return;
			}
			this.state = { ...reserved, budgetRemaining: allowance.remaining };
			let prepared = false;
			try {
				prepared = await session.prepareProbe();
			} catch {
				/* No network operation follows a failed fence. */
			}
			if (!prepared || revision !== this.revision || !(await session.valid())) {
				await this.publish(false);
				this.state = { ...this.state, nextProbe: this.deps.now() + 60_000 };
				return;
			}
			const result = await this.deps.probe(session);
			if (
				!(await session.valid()) ||
				revision !== this.revision ||
				this.state.generation !== generation ||
				this.session !== session
			) {
				this.withdraw();
				return;
			}
			if (result === "unavailable") {
				await this.publish(false);
				this.state = {
					...this.state,
					ready: false,
					nextProbe: this.deps.now() + 300_000,
				};
				return;
			}
			const health = observePathProbe(
				this.state,
				generation,
				this.deps.now(),
				result === "ok",
			);
			this.state = health.state;
			this.reconnectPending = health.reconnect;
			if (result === "ok") this.lastSuccess = this.deps.now();
			// A concurrent availability observation may have withdrawn during this await.
			// The session's physical generation check is mandatory before publication.
			await this.publish(health.state.ready);
		} catch (error) {
			this.withdraw();
			await this.publish(false);
			this.state = { ...this.state, nextProbe: this.deps.now() + 60_000 };
			throw error;
		} finally {
			this.busy = false;
		}
	}
	async close(): Promise<boolean> {
		this.closing = true;
		this.revision++;
		this.withdraw();
		if (this.busy) return false;
		this.busy = true;
		try {
			if (this.session && !(await this.session.cleanup())) return false;
			this.session = undefined;
			this.sessionGeneration = undefined;
			return true;
		} finally {
			this.busy = false;
		}
	}
}
