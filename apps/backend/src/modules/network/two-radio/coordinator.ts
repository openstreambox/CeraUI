import {
	EffectAdapter,
	type Identity,
	type Journal,
	type NetworkOwner,
} from "./effect-adapter.ts";
import { Ingress, type IngressAuthority } from "./ingress.ts";
import {
	initialState,
	reduce,
	type State,
	sameEpoch,
	type TraceEvent,
} from "./reducer.ts";

/** Serialized policy ingress. The effect adapter separately enters the existing
 * owner's transaction; never hold that transaction while awaiting an ACK. */
export class TwoRadioCoordinator {
	private state: State;
	private readonly adapter: EffectAdapter;
	private readonly ingress: Ingress;
	private tail: Promise<unknown> = Promise.resolve();
	private ready = false;
	private started = false;
	private readonly identities = new Map<string, Identity>();
	constructor(
		private readonly owner: NetworkOwner,
		journal: Journal,
		private readonly authority: IngressAuthority,
		session: string,
		private readonly now: () => number,
		config = { operationMs: 16_640, lingerMs: 3_000, emergencyMs: 4_160 },
	) {
		this.state = initialState(config);
		this.adapter = new EffectAdapter(owner, journal, session, 4_160);
		this.ingress = new Ingress(authority);
	}
	private serialize<T>(work: () => Promise<T>): Promise<T> {
		const result = this.tail.then(work);
		this.tail = result.catch(() => undefined);
		return result;
	}
	/** Restart closes admission first and never replays retained mutations. */
	start(): Promise<boolean> {
		return this.serialize(async () => {
			if (this.started)
				throw new Error("Start requires a fresh coordinator session");
			this.ready = false;
			this.ready = await this.adapter.reconcile();
			if (this.ready) {
				const holder = this.adapter.designatedHolder();
				if (holder) {
					const current = await this.owner.run(() =>
						this.owner.identity(holder.radio, AbortSignal.timeout(4_160)),
					);
					if (
						!current ||
						current.physical !== holder.identity.physical ||
						current.permanentMac !== holder.identity.permanentMac ||
						!sameEpoch(current.epoch, holder.identity.epoch)
					) {
						this.ready = false;
					} else {
						this.state.holder = holder.radio;
					}
				}
			}
			this.started = this.ready;
			return this.ready;
		});
	}
	view(): State {
		return structuredClone(this.state);
	}
	/** Only normalized, independently attested ingress. External ACKs are rejected. */
	submit(json: string): Promise<State> {
		return this.serialize(async () => {
			if (!this.ready) throw new Error("Coordinator reconciliation required");
			const row = this.ingress.parse(json);
			if (row.event.type === "identity") {
				const physical = JSON.parse(json).physical;
				const binding = this.authority.resolve(physical);
				if (row.event.epoch && binding)
					this.identities.set(
						row.event.radio,
						structuredClone(binding.identity),
					);
				else this.identities.delete(row.event.radio);
			}
			try {
				await this.advance(row);
			} catch (error) {
				this.ready = false;
				throw error;
			}
			return this.view();
		});
	}
	private async advance(row: TraceEvent): Promise<void> {
		const transition = reduce(this.state, row);
		this.state = transition.state;
		for (const effect of transition.effects) {
			const holderRadio = this.state.holder;
			const identity = await this.owner.run(() =>
				this.owner.identity(holderRadio, AbortSignal.timeout(4_160)),
			);
			const expected = this.identities.get(holderRadio);
			if (
				!expected ||
				!identity ||
				identity.physical !== expected.physical ||
				identity.permanentMac !== expected.permanentMac ||
				!sameEpoch(identity.epoch, this.state.paths[holderRadio].epoch)
			) {
				this.ready = false;
				return;
			}
			const ack = await this.adapter.execute(effect, {
				radio: holderRadio,
				identity,
			});
			if (!ack) {
				this.ready = false;
				return;
			}
			await this.advance({
				version: 1,
				at: Math.max(this.state.now, this.now()),
				event: ack,
			});
		}
	}
}

/** The disabled branch does not construct dependencies, read the journal, query
 * NM or install any event source. Missing/false is deliberately identical. */
export async function startTwoRadioCoordinator(
	enabled: boolean | undefined,
	create: () => TwoRadioCoordinator,
): Promise<TwoRadioCoordinator | null> {
	if (enabled !== true) return null;
	const coordinator = create();
	if (!(await coordinator.start()))
		throw new Error("Two-radio startup reconciliation failed");
	return coordinator;
}
