import type { CellularControl, CellularControlTarget } from "./modems.ts";
import type { CarrierPolicy } from "./subscription-policy.ts";
import {
	type InternalContext,
	type InternalGrant,
	resolveTransportQuirk,
} from "./transport-policy.ts";

export type InternalCallPhase =
	| "idle"
	| "waiting-registration"
	| "granted"
	| "withdrawn"
	| "blocked"
	| "closed";
export interface InternalCallBaseline {
	readonly context: InternalContext;
	readonly active: boolean;
	readonly cid: number;
	readonly desired: InternalContext;
}
export interface InternalCallHost {
	/** Stop publication synchronously, including when a control connection dies. */
	withdraw(): void;
	/** Durable host baseline and RA-default guard, before any call is submitted. */
	prepare(): Promise<void>;
	/** Bring up the exact host link after stable registration, before CGACT. */
	prepareCall(): Promise<void>;
	/** Install only this generation's grant; this does not declare traffic ready. */
	grant(grant: InternalGrant, dns: readonly string[]): Promise<void>;
	/** Exact inverse; a failed cleanup retains ownership and its durable record. */
	clearGrant(): Promise<boolean>;
	cleanup(): Promise<boolean>;
}
export interface InternalCallDeps {
	readonly acquire: (target: CellularControlTarget) => Promise<CellularControl>;
	/** Resolves the same profile, automatic intent, subscription, USB and SIM. */
	readonly current: () => Promise<boolean>;
	readonly host: InternalCallHost;
	/** Existing identity/lifecycle lease and durable journal, never a parallel lock. */
	readonly mutate: (
		operation: "handoff" | "activate" | "restore",
		effect: () => Promise<void>,
	) => Promise<boolean>;
	/** Must commit before the first definition or activation effect. */
	readonly baseline: (baseline: InternalCallBaseline) => Promise<void>;
	readonly now: () => number;
}
const sameFullContext = (a: InternalContext, b: InternalContext) =>
	sameContext(a, b) &&
	JSON.stringify(a.settings ?? []) === JSON.stringify(b.settings ?? []);
const sameContext = (a: InternalContext, b: InternalContext) =>
	a.apn === b.apn && a.family === b.family;

/** One retained owner per physical USB generation and subscription, not MM index.
 * MM is deliberately absent while its dedicated inhibition connection is held.
 * The global mutation lease is held only for handoff/call/inverse transactions;
 * registration observation never keeps stream admission locked for minutes.
 */
export class InternalCallOwner {
	private control: CellularControl | undefined;
	private removeRevocation: (() => void) | undefined;
	private saved: InternalCallBaseline | undefined;
	private consecutive = 0;
	private lastRegistration = Number.NEGATIVE_INFINITY;
	private lastGrant = "";
	private busy = false;
	private revoked = false;
	private contextChanged = false;
	private callStarted = false;
	private needsActivation = true;
	private _phase: InternalCallPhase = "idle";
	readonly cid: number;
	constructor(
		readonly target: CellularControlTarget,
		readonly policy: CarrierPolicy,
		readonly roaming: boolean,
		private readonly deps: InternalCallDeps,
	) {
		// Slot selection is a transport detail selected AFTER subscription policy.
		// Never touch the IMS/admin contexts of a subscription using context three.
		this.cid = policy.key === "verizon" ? 3 : 1;
	}
	get phase(): InternalCallPhase {
		return this._phase;
	}
	private withdraw(phase: InternalCallPhase = "withdrawn") {
		this.deps.host.withdraw();
		this.lastGrant = "";
		this._phase = phase;
	}
	private async subscriber(): Promise<boolean> {
		return (
			!!this.control &&
			!this.revoked &&
			(await this.control.valid()) &&
			(await this.control.verifySubscriber())
		);
	}
	async start(): Promise<boolean> {
		if (
			this.busy ||
			this._phase !== "idle" ||
			!this.policy.qualified ||
			resolveTransportQuirk(this.target.identity)?.owner !== "internal-call"
		)
			return false;
		this.busy = true;
		try {
			if (!(await this.deps.current())) return false;
			const admitted = await this.deps.mutate("handoff", async () => {
				if (!(await this.deps.current())) return;
				this.deps.host.withdraw();
				// Persist RA/default suppression and the NM handoff before MM can disappear
				// or the self-registering module can expose a data-plane advertisement.
				await this.deps.host.prepare();
				if (!(await this.deps.current()))
					throw new Error("Internal-call handoff changed its subscription");
				const control = await this.deps.acquire(this.target);
				this.control = control;
				this.removeRevocation = control.onRevoked(() => {
					this.revoked = true;
					this.withdraw();
				});
				if (!(await this.subscriber()))
					throw new Error("Internal-call subscription changed during handoff");
				this._phase = "waiting-registration";
			});
			return admitted && this.phase === "waiting-registration";
		} catch (error) {
			this.withdraw("blocked");
			// Keep inhibition if a partial host handoff cannot yet be reversed.
			// Releasing MM first would permit a second owner over retained state.
			if (await this.deps.host.cleanup()) await this.releaseControl();
			throw error;
		} finally {
			this.busy = false;
		}
	}
	/** A tick performs a bounded set of reads; callers serialize ticks per owner. */
	async observe(): Promise<void> {
		if (
			this.busy ||
			!this.control ||
			["blocked", "closed"].includes(this._phase)
		)
			return;
		this.busy = true;
		try {
			if (!(await this.subscriber()) || !(await this.deps.current())) {
				this.withdraw();
				// Host cleanup cannot run until consumers have stopped using the source.
				if (await this.deps.host.cleanup()) await this.releaseControl();
				return;
			}
			const now = this.deps.now();
			if (now - this.lastRegistration < 1_000) return;
			this.lastRegistration = now;
			const registration = await this.control.registrationState();
			if (
				registration !== "home" &&
				!(registration === "roaming" && this.roaming)
			) {
				this.consecutive = 0;
				this.withdraw("waiting-registration");
				return;
			}
			this.consecutive = Math.min(this.consecutive + 1, 4);
			if (this.consecutive < 4) return;
			if (!this.saved || this.needsActivation) await this.activate();
			if (!this.saved || this.needsActivation || this._phase === "blocked")
				return;
			const active = await this.control.contextActive(this.cid);
			const grant =
				active === true ? await this.control.readGrant(this.cid) : undefined;
			const dns = grant
				? await this.control.readContextDns(this.cid)
				: undefined;
			if (
				!grant ||
				grant.family === "none" ||
				dns === undefined ||
				!(await this.subscriber())
			) {
				this.withdraw("waiting-registration");
				return;
			}
			const fingerprint = JSON.stringify([grant, dns]);
			if (fingerprint !== this.lastGrant) {
				this.withdraw();
				if (!(await this.deps.host.clearGrant())) return;
				await this.deps.host.grant(grant, dns);
				if (!(await this.subscriber()) || !(await this.deps.current())) {
					this.withdraw();
					await this.deps.host.cleanup();
					return;
				}
				this.lastGrant = fingerprint;
			}
			this._phase = "granted";
		} catch (error) {
			this.withdraw("blocked");
			throw error;
		} finally {
			this.busy = false;
		}
	}
	private async activate(): Promise<void> {
		const control = this.control;
		if (!control) return;
		await this.deps.mutate("activate", async () => {
			if (!(await this.subscriber()) || !(await this.deps.current())) return;
			const context = await control.readContext(this.cid),
				active = await control.contextActive(this.cid);
			// Missing/malformed baseline or a foreign active context is never overwritten.
			const desired: InternalContext = {
				apn: this.policy.apn,
				family: this.policy.requestFamily,
				...(context?.settings ? { settings: context.settings } : {}),
			};
			if (
				!context ||
				active === undefined ||
				(active && !sameContext(context, desired))
			) {
				this.withdraw("blocked");
				return;
			}
			if (this.saved && !sameFullContext(context, this.saved.desired))
				throw new Error("Internal context changed before recovery");
			if (!this.saved) {
				const baseline = { context, active, desired, cid: this.cid };
				await this.deps.baseline(baseline);
				this.saved = baseline;
			}
			await this.deps.host.prepareCall();
			if (!(await this.subscriber()) || !(await this.deps.current()))
				throw new Error("Internal-call activation lost its subscription");
			if (!sameContext(context, desired)) {
				this.contextChanged = true; // Lost replies remain owned by the durable baseline.
				await control.defineContext(
					this.cid,
					desired.apn,
					desired.family,
					context.settings,
				);
				const verified = await control.readContext(this.cid);
				if (!verified || !sameFullContext(verified, desired))
					throw new Error("Internal context definition did not verify");
			}
			if (!active) {
				this.callStarted = true;
				await control.activateContext(this.cid, true);
			}
			if ((await control.contextActive(this.cid)) !== true)
				throw new Error("Internal context activation did not verify");
			this.needsActivation = false;
		});
	}
	/** Health recovery is a new admitted transaction. Never reset USB or radio here. */
	async reconnect(): Promise<boolean> {
		const control = this.control;
		if (this.busy || !this.saved || !control) return false;
		this.busy = true;
		try {
			this.withdraw();
			if (!(await this.deps.host.clearGrant())) return false;
			const admitted = await this.deps.mutate("activate", async () => {
				if (!(await this.subscriber()) || !(await this.deps.current())) return;
				// An adopted active call belongs to the baseline; leave it to its owner.
				if (!this.callStarted) return;
				await control.activateContext(this.cid, false);
				if ((await control.contextActive(this.cid)) !== false)
					throw new Error("Internal context withdrawal did not verify");
				this.needsActivation = true;
				this.consecutive = 0;
				this._phase = "waiting-registration";
			});
			return admitted && this._phase === "waiting-registration";
		} finally {
			this.busy = false;
		}
	}
	async close(): Promise<boolean> {
		if (this.busy) return false;
		this.busy = true;
		try {
			this.withdraw();
			if (!(await this.deps.host.clearGrant())) return false;
			const control = this.control;
			if (this.saved && control && !this.revoked) {
				const saved = this.saved;
				const admitted = await this.deps.mutate("restore", async () => {
					if (!(await this.subscriber()))
						throw new Error("Cannot restore a different subscription");
					const current = await control.readContext(this.cid),
						active = await control.contextActive(this.cid);
					if (
						current &&
						sameFullContext(current, saved.context) &&
						active === saved.active
					) {
						this.saved = undefined;
						return;
					}
					if (
						!current ||
						active === undefined ||
						!sameFullContext(current, saved.desired)
					)
						throw new Error("Internal context changed outside its owner");
					if (this.callStarted && active) {
						await control.activateContext(this.cid, false);
						if ((await control.contextActive(this.cid)) !== false)
							throw new Error("Internal context still active");
					}
					if (this.contextChanged) {
						await control.defineContext(
							this.cid,
							saved.context.apn,
							saved.context.family,
							saved.context.settings,
						);
						const restored = await control.readContext(this.cid);
						if (!restored || !sameFullContext(restored, saved.context))
							throw new Error("Internal context restore did not verify");
					}
					this.saved = undefined;
				});
				if (!admitted || this.saved) return false;
			} else if (this.saved) {
				// Bus/USB loss drops inhibition but cannot certify the modem inverse.
				// Recovery retains the durable baseline for the returning exact pair.
				await this.releaseControl();
				return false;
			}
			if (!(await this.deps.host.cleanup())) return false;
			await this.releaseControl();
			this._phase = "closed";
			return true;
		} finally {
			this.busy = false;
		}
	}
	private async releaseControl(): Promise<void> {
		this.removeRevocation?.();
		this.removeRevocation = undefined;
		const control = this.control;
		this.control = undefined;
		await control?.close();
	}
}
