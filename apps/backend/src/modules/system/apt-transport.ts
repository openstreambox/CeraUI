import {
	SpawnAbortError,
	SpawnTimeoutError,
} from "../../helpers/bounded-spawn.ts";
import {
	type EffectOwner,
	isOwnerEnded,
	OwnerEndedError,
} from "../../helpers/effect-owner.ts";
import { logger } from "../../helpers/logger.ts";
import type { SpawnWithTimeoutResult } from "../../helpers/spawn-policy.ts";
import type { AptReachability } from "./apt-reachability.ts";
import {
	type AptRoutingOwnership,
	AptRoutingRefusal,
	aptRoutingOwnership,
} from "./apt-routing-ownership.ts";
import {
	type AptTransferAdmission,
	captureAptTransferAdmission,
	trackAptTransfer,
} from "./apt-transfer-abort.ts";
import {
	aptCommandFailure,
	classifyAptFetchFailure,
	familyName,
	forced,
	normalizeAptCommandFailure,
	reachabilityFromSelection,
} from "./apt-transport-result.ts";
import { isStreamConfirmedIdle } from "./stream-liveness-source.ts";
import type { TransportSelection } from "./update-transport/core.ts";

export {
	classifyAptFetchFailure,
	reachabilityFromSelection,
} from "./apt-transport-result.ts";

import { selectUpdateTransport } from "./update-transport/executor.ts";
import {
	UpdatePinError,
	UpdateTransferError,
	updatePinController,
} from "./update-transport/pin.ts";

/** One networked apt run; `reachability.verdict` is this attempt's pinned family. */
export type AptStep = (
	reachability: AptReachability,
	signal: AbortSignal | undefined,
	/** `last`: no other transport would be tried if this run fails. */
	transfer: { readonly last: boolean },
) => Promise<SpawnWithTimeoutResult>;

/**
 * One APT transaction's network authority. A legacy transaction is today's
 * unbound family verdict; a pinned one routes the `apt_uid` sandbox user
 * (apt's fetch methods) through the selected uplink and family.
 */
export type AptTransaction = {
	readonly pinned: boolean;
	readonly reachability: AptReachability;
	/** Local apt work under the winner's rule; `refused` answers a routing refusal. */
	readonly within: <T>(
		work: (attempt: AptReachability) => Promise<T>,
		refused: () => T,
	) => Promise<T>;
	/** A networked apt run; an apt fetch failure fails over to the next pair. */
	readonly transfer: (
		step: AptStep,
		options?: { readonly abortable?: boolean },
	) => Promise<SpawnWithTimeoutResult>;
	readonly aborted: () => boolean;
};

class AptTransferAborted extends Error {
	constructor() {
		super("apt transfer aborted for a stream start");
		this.name = "AptTransferAborted";
	}
}

export type AptTransportDeps = {
	readonly isIdle: () => boolean;
	readonly ownership: AptRoutingOwnership;
	readonly select: (owner?: EffectOwner) => Promise<TransportSelection>;
	readonly pin: Pick<typeof updatePinController, "run">;
};

let overrides: Partial<AptTransportDeps> = {};

export function setAptTransportDepsForTest(
	next: Partial<AptTransportDeps> | null,
): void {
	overrides = next ?? {};
}

// Resolved per call: reading `updatePinController` at module load trips an import cycle.
const pinController = () => overrides.pin ?? updatePinController;
const select = (owner?: EffectOwner) =>
	overrides.select?.(owner) ??
	// The APT profile never names an images.ceralive.tv object, so board and channel are inert.
	selectUpdateTransport(
		{ profile: "apt", board: "apt", channel: "stable" },
		undefined,
		owner,
	);

// The routing layers wrap what stopped them (a refusal's cause, a teardown's
// aggregate): a transaction whose owner has ended is none of their failures.
function ownerEnded(error: unknown): boolean {
	if (isOwnerEnded(error)) return true;
	if (error instanceof AggregateError) return error.errors.some(ownerEnded);
	return error instanceof Error && ownerEnded(error.cause);
}

// A teardown that failed left a rule or a route behind.
const teardownFailed = (error: unknown): boolean =>
	error instanceof AggregateError ||
	(error instanceof AptRoutingRefusal && error.reason === "cleanup-pending");

/**
 * Whether a failed apt run is none of its owner's news any more: the owner
 * has ended, and nothing was left behind. A failed teardown is reported
 * whoever asked for the run.
 */
function endedQuietly(owner: EffectOwner | undefined, error: unknown): boolean {
	return (
		!teardownFailed(error) && (ownerEnded(error) || owner?.ended() === true)
	);
}

const refusedRun = (error: Error): SpawnWithTimeoutResult => ({
	exitCode: 1,
	stdout: "",
	stderr: error.message,
});

function isRoutingRefusal(error: unknown): error is Error {
	return (
		error instanceof UpdatePinError ||
		error instanceof AptRoutingRefusal ||
		error instanceof AggregateError ||
		error instanceof AptTransferAborted
	);
}

export function legacyAptTransaction(
	reachability: AptReachability,
): AptTransaction {
	return {
		pinned: false,
		reachability,
		within: (work) => work(reachability),
		transfer: (step) => step(reachability, undefined, { last: true }),
		aborted: () => false,
	};
}

/** Probe every (uplink, family), then pin each apt run to the ranked winner. */
export async function openPinnedAptTransaction(
	admission: AptTransferAdmission = captureAptTransferAdmission(),
): Promise<AptTransaction> {
	let selection: TransportSelection;
	const owner = admission.owner;
	try {
		selection = await select(owner);
	} catch (error) {
		// The transaction's owner has ended: nothing to report, nothing to open.
		if (isOwnerEnded(error) || owner?.ended())
			throw new OwnerEndedError("an apt run");
		logger.warn("APT transport selection failed", { error });
		return legacyAptTransaction({
			ipv4: "probe_unavailable",
			ipv6: "probe_unavailable",
			used: "none",
			verdict: "probe_unavailable",
			detail: [],
		});
	}
	if (selection.status === "none") {
		logger.warn("No healthy update transport", {
			profile: "apt",
			findings: selection.ranked.map((row) => ({
				ifname: row.candidate.ifname,
				family: row.family,
				reason: row.reason,
			})),
		});
	}
	const controller = new AbortController();
	const cancelled = () => {
		if (admission.cancelled()) controller.abort();
		if (controller.signal.aborted) throw new AptTransferAborted();
	};
	// The pin's commands and its routing lease are run for the owner too.
	const owned = owner ? { owner } : {};
	let reachability = reachabilityFromSelection(selection);
	return {
		pinned: true,
		get reachability() {
			return reachability;
		},
		aborted: () => controller.signal.aborted || admission.cancelled(),
		async within(work, refused) {
			// With no winner the verdict already refuses every networked step; local work stays local.
			if (selection.status === "none") return work(reachability);
			try {
				// Box the outcome so an arbitrary coded error is never mistaken for a transfer failure.
				const boxed = await pinController().run(
					"apt",
					selection,
					async ({ family }) => {
						reachability = {
							...reachability,
							verdict: forced(family),
							used: familyName(family),
						};
						try {
							return { ok: true as const, value: await work(reachability) };
						} catch (error) {
							return { ok: false as const, error };
						}
					},
					{
						aptOwnership: overrides.ownership ?? aptRoutingOwnership,
						...owned,
					},
				);
				if (!boxed.ok) throw boxed.error;
				return boxed.value;
			} catch (error) {
				if (endedQuietly(owner, error)) throw new OwnerEndedError("an apt run");
				if (!isRoutingRefusal(error)) throw error;
				logger.warn("APT transaction refused by update routing", { error });
				return refused();
			}
		},
		async transfer(step, options = {}) {
			let last: SpawnWithTimeoutResult | undefined;
			const release = options.abortable
				? trackAptTransfer(controller, admission)
				: () => undefined;
			try {
				return await pinController().run(
					"apt",
					selection,
					async ({ family }, _flags, attempt) => {
						reachability = {
							...reachability,
							verdict: forced(family),
							used: familyName(family),
						};
						if (
							options.abortable &&
							!(overrides.isIdle ?? isStreamConfirmedIdle)()
						)
							controller.abort();
						cancelled();
						try {
							last = await step(
								{
									...reachability,
									verdict: forced(family),
									used: familyName(family),
								},
								options.abortable ? controller.signal : undefined,
								attempt,
							);
						} catch (error) {
							if (!(error instanceof SpawnTimeoutError)) throw error;
							last = normalizeAptCommandFailure(error);
						}
						const failure = aptCommandFailure(last);
						if (failure instanceof SpawnAbortError) controller.abort();
						cancelled();
						const reason = classifyAptFetchFailure(last);
						if (failure)
							last = {
								exitCode: last.exitCode,
								stdout: failure.partialStdout,
								stderr: failure.partialStderr || failure.message,
							};
						if (reason) throw new UpdateTransferError(reason);
						return last;
					},
					{
						checkCancelled: cancelled,
						aptOwnership: overrides.ownership ?? aptRoutingOwnership,
						...owned,
					},
				);
			} catch (error) {
				if (endedQuietly(owner, error)) throw new OwnerEndedError("an apt run");
				if (error instanceof UpdateTransferError && last) return last;
				if (!isRoutingRefusal(error)) throw error;
				logger.warn("APT transfer refused by update routing", { error });
				return refusedRun(error);
			} finally {
				release();
			}
		},
	};
}
