import type { InternalCallContext } from "./internal-call-context.ts";
import {
	type InternalCallRetirement,
	withdrawInternalCall,
} from "./internal-call-withdrawal.ts";
import type { CellularControl, CellularControlTarget } from "./modems.ts";
import type { CarrierPolicy } from "./subscription-policy.ts";
import {
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
		operation: "handoff",
		effect: () => Promise<void>,
	) => Promise<boolean>;
	/** Durable per-unit context operations share the existing mutation journal. */
	readonly context: InternalCallContext;
	/** Complete old-index absence, never a failed physical or MM read. */
	readonly physicalGone: () => Promise<boolean>;
	readonly retirement: InternalCallRetirement;
	readonly now: () => number;
}
/** One retained owner per physical USB generation and subscription, not MM index.
 * MM is deliberately absent while its dedicated inhibition connection is held.
 * The global mutation lease is held only for handoff/call/inverse transactions;
 * registration observation never keeps stream admission locked for minutes.
 */
export class InternalCallOwner {
	private control: CellularControl | undefined;
	private removeRevocation: (() => void) | undefined;
	private consecutive = 0;
	private lastRegistration = Number.NEGATIVE_INFINITY;
	private lastGrant = "";
	private busy = false;
	private revoked = false;
	private stopping = false;
	private needsActivation = true;
	private _phase: InternalCallPhase = "idle";
	readonly cid: number;
	constructor(
		readonly target: CellularControlTarget,
		readonly policy: CarrierPolicy,
		readonly roaming: boolean,
		private readonly deps: InternalCallDeps,
	) {
		this.target = Object.freeze({
			...target,
			identity: Object.freeze({ ...target.identity }),
		});
		this.policy = Object.freeze({ ...policy });
		// Slot selection is a transport detail selected AFTER subscription policy.
		// Never touch the IMS/admin contexts of a subscription using context three.
		this.cid = policy.key === "verizon" ? 3 : 1;
	}
	get phase(): InternalCallPhase {
		return this._phase;
	}
	get closing(): boolean {
		return this.stopping;
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
			if (this.stopping || !(await this.deps.current())) return false;
			await this.deps.context.load();
			const admitted = await this.deps.mutate("handoff", async () => {
				if (this.stopping || !(await this.deps.current())) return;
				this.deps.host.withdraw();
				// Persist RA/default suppression and the NM handoff before MM can disappear
				// or the self-registering module can expose a data-plane advertisement.
				await this.deps.host.prepare();
				if (this.stopping || !(await this.deps.current()))
					throw new Error("Internal-call handoff changed its subscription");
				const control = await this.deps.acquire(this.target);
				this.control = control;
				this.removeRevocation = control.onRevoked(() => {
					this.revoked = true;
					this.withdraw();
				});
				if (this.stopping || !(await this.subscriber()))
					throw new Error("Internal-call subscription changed during handoff");
				this._phase = "waiting-registration";
			});
			return admitted && this.phase === "waiting-registration";
		} catch (error) {
			this.withdraw("blocked");
			// Keep inhibition if a partial host handoff cannot yet be reversed.
			// Releasing MM first would permit a second owner over retained state.
			if (!(await this.finish())) this.withdraw("blocked");
			throw error;
		} finally {
			this.busy = false;
		}
	}
	/** A tick performs a bounded set of reads; callers serialize ticks per owner. */
	async observe(): Promise<void> {
		if (
			this.busy ||
			this.stopping ||
			!this.control ||
			["blocked", "closed"].includes(this._phase)
		)
			return;
		this.busy = true;
		try {
			if (!(await this.subscriber()) || !(await this.deps.current())) {
				this.withdraw();
				await this.finish();
				return;
			}
			const now = this.deps.now();
			if (now - this.lastRegistration < 1_000) return;
			this.lastRegistration = now;
			const registration = await this.control.registrationState();
			if (this.stopping) return;
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
			if (this.needsActivation) await this.activate();
			if (this.stopping || this.needsActivation || this._phase === "blocked")
				return;
			const grant = (await this.deps.context.valid(this.control))
				? await this.control.readGrant(this.cid)
				: undefined;
			const dns = grant
				? await this.control.readContextDns(this.cid)
				: undefined;
			if (
				this.stopping ||
				!grant ||
				grant.family === "none" ||
				dns === undefined ||
				!(await this.subscriber()) ||
				!(await this.deps.context.valid(this.control))
			) {
				this.withdraw("waiting-registration");
				return;
			}
			const fingerprint = JSON.stringify([grant, dns]);
			if (fingerprint !== this.lastGrant) {
				this.withdraw();
				if (!(await this.deps.host.clearGrant())) return;
				if (
					this.stopping ||
					!(await this.subscriber()) ||
					!(await this.deps.current()) ||
					!(await this.deps.context.valid(this.control))
				)
					return;
				await this.deps.host.grant(grant, dns);
				if (
					this.stopping ||
					!(await this.subscriber()) ||
					!(await this.deps.current()) ||
					!(await this.deps.context.valid(this.control))
				) {
					this.withdraw();
					await this.finish();
					return;
				}
				this.lastGrant = fingerprint;
			}
			this._phase = "granted";
		} catch (error) {
			this.withdraw("blocked");
			throw error;
		} finally {
			if (this.stopping && this._phase !== "closed") this.withdraw();
			this.busy = false;
		}
	}
	private async activate(): Promise<void> {
		const control = this.control;
		if (
			this.stopping ||
			!control ||
			!(await this.subscriber()) ||
			!(await this.deps.current())
		)
			return;
		if (!this.deps.context.known()) {
			const context = await control.readContext(this.cid),
				active = await control.contextActive(this.cid);
			// A foreign active call is not adopted as a baseline for a new policy.
			if (
				!context ||
				active === undefined ||
				(active &&
					(context.apn !== this.policy.apn ||
						context.family !== this.policy.requestFamily))
			) {
				this.withdraw("blocked");
				return;
			}
		}
		this.withdraw("waiting-registration");
		if (!(await this.deps.host.clearGrant()) || this.stopping) return;
		if (await this.deps.context.activate(control)) this.needsActivation = false;
	}
	/** Health recovery is a new admitted transaction. Never reset USB or radio here. */
	async reconnect(): Promise<boolean> {
		const control = this.control;
		if (
			this.busy ||
			this.stopping ||
			this.needsActivation ||
			!control ||
			["blocked", "closed"].includes(this._phase)
		)
			return false;
		this.busy = true;
		try {
			this.withdraw();
			if (
				!(await this.deps.host.clearGrant()) ||
				this.stopping ||
				!(await this.subscriber()) ||
				!(await this.deps.current()) ||
				!(await this.deps.context.deactivate(control))
			)
				return false;
			this.needsActivation = true;
			this.consecutive = 0;
			this._phase = "waiting-registration";
			return true;
		} finally {
			this.busy = false;
		}
	}
	async close(): Promise<boolean> {
		if (this._phase === "closed") return true;
		// A requested teardown cannot be reversed by a later poll or health tick.
		this.stopping = true;
		this.withdraw();
		if (this.busy) return false;
		this.busy = true;
		try {
			return await this.finish();
		} finally {
			this.busy = false;
		}
	}
	/** Reacquire only for an inverse on this exact USB generation. A fresh MM
	 * index may change; a different unit/link/generation cannot inherit control.
	 * This never resumes old-policy grant publication or changes a new SIM.
	 */
	async recoverControl(target: CellularControlTarget): Promise<boolean> {
		if (
			this.busy ||
			this._phase === "closed" ||
			this.deps.retirement.contextReleased() ||
			(!this.control && !this.stopping)
		)
			return false;
		const captured = Object.freeze({
			...target,
			identity: Object.freeze({ ...target.identity }),
		});
		if (
			[
				"key",
				"equipment",
				"ifname",
				"usbDevice",
				"netDevice",
				"ifindex",
				"generation",
			].some(
				(field) =>
					captured[field as keyof CellularControlTarget] !==
					this.target[field as keyof CellularControlTarget],
			) ||
			resolveTransportQuirk(captured.identity)?.owner !== "internal-call" ||
			(!this.revoked && this.control && (await this.control.valid()))
		)
			return false;
		this.busy = true;
		this.stopping = true;
		this.withdraw();
		try {
			let accepted = false;
			const admitted = await this.deps.mutate("handoff", async () => {
				await this.releaseControl();
				const control = await this.deps.acquire(captured);
				if (!(await this.deps.context.accept(control))) {
					await control.close();
					return;
				}
				this.control = control;
				this.revoked = false;
				this.removeRevocation = control.onRevoked(() => {
					this.revoked = true;
					this.withdraw();
				});
				accepted = !this.revoked && (await control.valid());
			});
			return admitted && accepted;
		} finally {
			this.busy = false;
		}
	}
	private async finish(): Promise<boolean> {
		this.stopping = true;
		const complete = await withdrawInternalCall({
			retirement: this.deps.retirement,
			withdraw: () => this.withdraw(),
			clearGrant: () => this.deps.host.clearGrant(),
			context: async () => {
				await this.deps.context.load();
				if (!this.deps.context.known()) return true;
				const control = this.control;
				return (
					(!!control &&
						!this.revoked &&
						(await this.deps.context.close(control))) ||
					(await this.deps.physicalGone())
				);
			},
			host: () => this.deps.host.cleanup(),
			control: () => this.releaseControl(),
		});
		if (complete) this._phase = "closed";
		return complete;
	}
	private async releaseControl(): Promise<void> {
		const control = this.control;
		await control?.close();
		this.removeRevocation?.();
		this.removeRevocation = undefined;
		this.control = undefined;
	}
}
