import { type RunOpts, run } from "../../../helpers/run.ts";
import type {
	Holder,
	Identity,
	Intent,
	NetworkOwner,
	OperationRecord,
} from "./effect-adapter.ts";
import { type Radio, sameEpoch } from "./reducer.ts";

export type NmStep = Readonly<{
	args: readonly string[];
	radio: Radio;
	identity: Identity;
}>;
/** Bind to existing owner state/transactions. Plans contain nmcli argv, never
 * shell commands. They must address exact activation/profile IDs and carry the
 * supplied scope on every created resource. No runtime is started here. */
export interface OwnerBinding {
	run<T>(work: () => Promise<T>): Promise<T>;
	identity(radio: Radio, signal: AbortSignal): Promise<Identity | null>;
	plan(
		intent: Intent,
		scope: string,
		signal: AbortSignal,
	): Promise<readonly NmStep[]>;
	restorePlan(holder: Holder, signal: AbortSignal): Promise<readonly NmStep[]>;
	restored(holder: Holder, signal: AbortSignal): Promise<boolean>;
	/** NM-side quiescence, not just local process exit. False/unknown retains token. */
	drain(record: OperationRecord, signal: AbortSignal): Promise<boolean>;
	removeOwned(scope: string, signal: AbortSignal): Promise<boolean>;
}
export function bindNetworkOwner(
	owner: OwnerBinding,
	runner: (bin: string, args: string[], opts: RunOpts) => Promise<string> = run,
	ioMs = 5_000,
): NetworkOwner {
	if (!Number.isFinite(ioMs) || ioMs <= 0) throw new Error("Invalid IO budget");
	const controllers = new Map<number, Set<AbortController>>();
	const children = new Map<number, Set<Promise<unknown>>>();
	const steps = async (plan: readonly NmStep[], signal: AbortSignal) => {
		if (plan.length > 32) throw new Error("Oversize effect plan");
		for (const step of plan) {
			signal.throwIfAborted();
			const current = await owner.identity(step.radio, signal);
			if (
				!current ||
				current.physical !== step.identity.physical ||
				current.permanentMac !== step.identity.permanentMac ||
				!sameEpoch(current.epoch, step.identity.epoch)
			)
				throw new Error("Stale NM step");
			signal.throwIfAborted();
			await runner("nmcli", [...step.args], {
				signal,
				timeout: ioMs,
				maxBuffer: 65_536,
			});
		}
		return true;
	};
	return {
		run: (work) => owner.run(work),
		identity: (radio, signal) => owner.identity(radio, signal),
		async apply(intent, scope, signal) {
			const operation = intent.effect.operation;
			const controller = new AbortController();
			const abort = () => controller.abort();
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			const active = controllers.get(operation) ?? new Set<AbortController>();
			controllers.set(operation, active);
			active.add(controller);
			const pending = children.get(operation) ?? new Set<Promise<unknown>>();
			children.set(operation, pending);
			const child = (async () => {
				const plan = await owner.plan(intent, scope, controller.signal);
				// A plan may not smuggle an effect onto another physical adapter.
				if (
					plan.some(
						(s) =>
							s.radio !== intent.effect.radio ||
							s.identity.physical !== intent.identity.physical ||
							!sameEpoch(s.identity.epoch, intent.identity.epoch),
					)
				)
					throw new Error("Foreign plan");
				return steps(plan, controller.signal);
			})();
			pending.add(child);
			try {
				return await child;
			} finally {
				pending.delete(child);
				active.delete(controller);
				signal.removeEventListener("abort", abort);
			}
		},
		async cancelAndDrain(record, signal) {
			for (const controller of controllers.get(record.operation) ?? [])
				controller.abort();
			await Promise.allSettled(children.get(record.operation) ?? []);
			signal.throwIfAborted();
			return owner.drain(record, signal);
		},
		async restore(holder, signal) {
			const plan = await owner.restorePlan(holder, signal);
			if (
				plan.some(
					(s) =>
						s.radio !== holder.radio ||
						s.identity.physical !== holder.identity.physical ||
						!sameEpoch(s.identity.epoch, holder.identity.epoch),
				)
			)
				return false;
			await steps(plan, signal);
			return owner.restored(holder, signal);
		},
		removeOwned: (scope, signal) => owner.removeOwned(scope, signal),
	};
}
