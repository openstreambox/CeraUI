/**
 * LifecycleInterlock — the single mutual-exclusion guard between STREAMING
 * ADMISSION and MODEM LIFECYCLE mutations (modem-stack Phase B).
 *
 * Two operations must never run concurrently against a bonded modem link:
 *
 *  - `"streaming"` — a stream is being ADMITTED. The lease is held only across
 *    the admission window (`stream-session-orchestrator.ts` `start()`, from the
 *    moment the attempt is admitted until the launch settles), because once the
 *    stream is live the LIVE guard (`getIsStreaming()`) takes over. For
 *    engine-less forwarding, `isForwardActive()` supplies that live exclusion
 *    after the admission lease ends at relay acceptance. It is
 *    released in that admission's `finally`, so a throw mid-launch can never
 *    strand it.
 *  - `"modem-transition"` — a USB-composition-mode switch (`modems.setUsbMode`),
 *    a dead-bearer reconnect while it takes its link down
 *    (`tryAcquireLinkTeardown`), or a future, DEFAULT-DISABLED USB-reset
 *    action. Each tears a bond link down mid-flight.
 *
 * Letting either start while the other is mid-flight breaks the bond math — a
 * link vanishing during admission, or an admitted stream losing a link to a
 * reset — so the two are mutually exclusive in BOTH race orders. A bare
 * `getIsStreaming()` cannot express that: it is false for the whole admission
 * window, which is precisely the window a transition must not land in.
 *
 * Acquisition is FAIL-FAST: there is no queue and no scheduler. A caller that
 * cannot acquire is refused IMMEDIATELY and maps the refusal onto its own typed
 * wire value (`leaseRefusal` below is the one table both sides read, so the two
 * refusals can never drift apart). Release is idempotent, so an outer `finally`
 * may release after the body already did, and a stale lease can never free a
 * later holder. The one exception is outside this primitive: a Stream Start
 * waits, for a bounded time, for a dead-bearer link teardown to release
 * (`linkTeardownSettled`) before it asks.
 *
 * SCOPE: this module is the PRIMITIVE plus its streaming-side wiring, GENERALIZED
 * from the single `"modem-transition"` holder to a PER-PHYSICAL-DEVICE mutation
 * lease that every mutating modem path takes — MM/NM config, SIM PIN/PUK/PIN2, a
 * network scan, a router-admin write, the remote `modem.reconfig` op, and the
 * USB-mode switch alike. Two devices may be mutated concurrently (their leases are
 * independent), but a stream admission is refused while ANY of them is held, and
 * every mutation is refused while an admission holds the interlock. That
 * reciprocity is why the generalization lives here rather than in a second guard
 * beside `getIsStreaming()` — a parallel lease would reopen the admission-window
 * race this module exists to close.
 */

import type { ModemMutationRefusal } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { noteStartLeaseEnded } from "../system/idle-state.ts";
import { isForwardActive } from "./forward-activity.ts";

import {
	isHelperRecoveryPending,
	isRecoveryPending,
} from "./recovery-barrier.ts";

export const LIFECYCLE_HOLDERS = ["streaming", "modem-transition"] as const;
export type LifecycleHolder = (typeof LIFECYCLE_HOLDERS)[number];

/**
 * The typed refusal a caller reports when the OTHER side holds the interlock.
 * Wire-stable machine tokens, never rendered raw:
 *
 *  - `MODEM_TRANSITION_ACTIVE` — what a `streaming.start` answers when a modem
 *    transition holds the lease.
 *  - `STREAMING_ACTIVE` — what a modem transition answers when an admission
 *    holds it. Deliberately the SAME token `modems.setUsbMode` already returns
 *    for a LIVE stream (`streaming_active`), because from the operator's side
 *    "a stream is starting" and "a stream is running" call for the same action.
 */
export const MODEM_TRANSITION_ACTIVE = "MODEM_TRANSITION_ACTIVE";
export const STREAMING_ACTIVE = "streaming_active";

export type LifecycleRefusal =
	| typeof MODEM_TRANSITION_ACTIVE
	| typeof STREAMING_ACTIVE;

/**
 * The refusal a requester reports, keyed on WHO holds the interlock. One table
 * for both directions: a per-caller mapping is how the two halves of a mutual
 * exclusion drift into disagreeing about what happened.
 */
export function leaseRefusal(heldBy: LifecycleHolder): LifecycleRefusal {
	return heldBy === "streaming" ? STREAMING_ACTIVE : MODEM_TRANSITION_ACTIVE;
}

/** A held interlock. `release()` is idempotent — safe to call from a `finally`. */
export interface LifecycleLease {
	readonly holder: LifecycleHolder;
	release(): void;
}

/** The outcome of an acquisition attempt. A refusal NAMES the current holder. */
export type LifecycleAdmission =
	| { readonly admitted: true; readonly lease: LifecycleLease }
	| {
			readonly admitted: false;
			readonly heldBy: LifecycleHolder;
			readonly refusal: LifecycleRefusal;
	  };

/** The result of a guarded run: the operation's value, or a contention miss. */
export type LifecycleOutcome<T> =
	| { readonly acquired: true; readonly result: T }
	| { readonly acquired: false; readonly refusal: LifecycleRefusal };

type HeldLease = { readonly holder: LifecycleHolder; readonly token: number };

let held: HeldLease | undefined;
let nextToken = 0;

/**
 * Try to acquire the interlock for `who`. NEVER blocks: a held interlock is
 * refused on the spot, naming its holder and the caller's typed refusal.
 *
 * The lease is EXCLUSIVE, not re-entrant — a second `"streaming"` acquisition
 * while one is outstanding is refused exactly like a cross-holder one. Callers
 * that have their own concurrency guard (the orchestrator's `state !== "idle"`
 * duplicate-start rejection) run it FIRST, so a genuine duplicate keeps its own
 * specific error instead of decaying into a generic lease-busy one.
 */
export function tryAcquireLifecycle(who: LifecycleHolder): LifecycleAdmission {
	if (isForwardActive())
		return { admitted: false, heldBy: "streaming", refusal: STREAMING_ACTIVE };
	if (isHelperRecoveryPending()) {
		return {
			admitted: false,
			heldBy: "modem-transition",
			refusal: leaseRefusal("modem-transition"),
		};
	}
	// A per-device mutation lease is the SAME exclusion as the legacy
	// `"modem-transition"` holder, so it has to refuse a requester here too —
	// otherwise a stream admission could slip past a mutation that took the
	// generalized path.
	const devices = [...activeMutations.values()].filter(
		(holder) => !holder.journalOnly,
	).length;
	if (devices > 0) {
		logger.debug("lifecycle interlock refused: a modem mutation is held", {
			module: "streaming",
			requested: who,
			devices,
		});
		return {
			admitted: false,
			heldBy: "modem-transition",
			refusal: leaseRefusal("modem-transition"),
		};
	}
	const current = held;
	if (current !== undefined) {
		logger.debug("lifecycle interlock refused a concurrent operation", {
			module: "streaming",
			heldBy: current.holder,
			requested: who,
		});
		return {
			admitted: false,
			heldBy: current.holder,
			refusal: leaseRefusal(current.holder),
		};
	}

	nextToken += 1;
	const token = nextToken;
	held = { holder: who, token };
	if (who === "streaming") streamingAdmissions += 1;
	return {
		admitted: true,
		lease: {
			holder: who,
			release: () => releaseToken(token),
		},
	};
}

/**
 * Release by TOKEN, not by holder. A lease that has already been released (or
 * superseded by a later acquisition) frees nothing, so a double-release and a
 * stale `finally` are both no-ops rather than a way to steal the interlock from
 * whoever holds it now.
 */
function releaseToken(token: number): void {
	if (held?.token !== token) return;
	if (held.holder === "streaming") noteStartLeaseEnded();
	held = undefined;
}

/**
 * Run `operation` while holding the interlock for `who`, releasing in a
 * `finally` on ANY exit — return OR throw. A throw propagates to the caller
 * AFTER the release, which is the no-deadlock guarantee. When the other side
 * holds the interlock, `operation` is NOT run and the typed refusal is returned.
 */
export async function withLifecycleLock<T>(
	who: LifecycleHolder,
	operation: () => Promise<T>,
): Promise<LifecycleOutcome<T>> {
	const admission = tryAcquireLifecycle(who);
	if (!admission.admitted) {
		return { acquired: false, refusal: admission.refusal };
	}
	try {
		return { acquired: true, result: await operation() };
	} finally {
		admission.lease.release();
	}
}

/**
 * Every `"streaming"` admission so far: Start, restoration and engine-less
 * forwarding alike. The dead-bearer reconnect compares it with the value it
 * saw when an outage began, so a stream that came and went between two polls
 * still restarts the outage hold.
 */
let streamingAdmissions = 0;

export function streamingAdmissionCount(): number {
	return streamingAdmissions;
}

/**
 * The longest a link teardown holds the interlock. A Stream Start waits for
 * the hold rather than failing, so this plus the launch's 60 s retry budget
 * has to stay inside the 75 s Start RPC deadline. A teardown that has not
 * settled by then keeps its link out of the bond instead
 * (`link-teardown-pending.ts`).
 */
export const LINK_TEARDOWN_MAX_HOLD_MS = 6_000;

/**
 * How long a Start waits for a link teardown before it is admitted or refused
 * as usual. Longer than one hold, and no new teardown begins while a Start
 * waits, so the wait ends because the hold ended.
 */
export const START_LINK_TEARDOWN_WAIT_MS = 8_000;

/**
 * A dead-bearer reconnect taking one modem's link down: the interlock held as
 * `"modem-transition"` from just before the `down` until NetworkManager shows
 * the device has left the connection, at most `maxHoldMs`, so neither a stream
 * admission nor engine-less forwarding can begin while the link is being taken
 * away. The reconnect itself runs under a journal-only key, which the count
 * above deliberately ignores, so without this hold a Start admitted during its
 * owner reads would launch onto a link that goes down a moment later.
 *
 * Undefined when the interlock is held (a Start is being admitted, another
 * transition runs, an operator mutation holds a device), forwarding is active,
 * or a Start is waiting for an earlier teardown: the reconnect then does not
 * happen this poll. The hold releases itself at `maxHoldMs` whatever its
 * holder is still awaiting.
 */
export function tryAcquireLinkTeardown(
	maxHoldMs: number = LINK_TEARDOWN_MAX_HOLD_MS,
): LifecycleLease | undefined {
	if (startsWaiting > 0) return undefined;
	const admission = tryAcquireLifecycle("modem-transition");
	if (!admission.admitted) return undefined;
	const current = Promise.withResolvers<void>();
	linkTeardown = current;
	const release = () => {
		clearTimeout(expiry);
		admission.lease.release();
		if (linkTeardown !== current) return;
		linkTeardown = undefined;
		current.resolve();
	};
	const expiry = setTimeout(release, maxHoldMs);
	teardownExpiry = expiry;
	return { holder: "modem-transition", release };
}

/**
 * Why `tryAcquireLinkTeardown` would refuse now: `"stream"` for a Start being
 * admitted or waiting, or forwarding; `"transition"` for another modem change
 * (a USB switch, an operator mutation, another modem's teardown); undefined
 * when it would not refuse.
 */
export function linkTeardownRefusal(): "stream" | "transition" | undefined {
	if (startsWaiting > 0 || isForwardActive() || held?.holder === "streaming")
		return "stream";
	if (
		held !== undefined ||
		[...activeMutations.values()].some((holder) => !holder.journalOnly)
	)
		return "transition";
	return undefined;
}

let linkTeardown: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let teardownExpiry: ReturnType<typeof setTimeout> | undefined;
let startsWaiting = 0;

/**
 * Resolves when the link teardown holding the interlock releases; undefined
 * when none does. A Stream Start waits on this instead of failing with
 * `modem_transition_active`, because none of the start origins retries that
 * refusal (restoration would lose the stream it exists to bring back). The
 * waiter holds nothing and must ask again after waking, synchronously before
 * it admits.
 */
export function linkTeardownSettled(): Promise<void> | undefined {
	return linkTeardown?.promise;
}

/**
 * Mark a Start as waiting for a link teardown; no new teardown begins until
 * the returned function runs. Idempotent, so a `finally` may call it twice.
 */
export function beginLinkTeardownWait(): () => void {
	startsWaiting += 1;
	let ended = false;
	return () => {
		if (ended) return;
		ended = true;
		startsWaiting = Math.max(0, startsWaiting - 1);
	};
}

/** True while either lifecycle operation holds the interlock. */
export function isLifecycleHeld(): boolean {
	return held !== undefined;
}

/** The current holder, or `undefined` when the interlock is free (diagnostics). */
export function currentLifecycleHolder(): LifecycleHolder | undefined {
	return held?.holder;
}

/**
 * Test-only: force-release the interlock so a suite starts from a free state.
 * NEVER call this from production code — it would free a lease its holder is
 * still relying on.
 */
export function resetLifecycleInterlock(): void {
	held = undefined;
	const teardown = linkTeardown;
	linkTeardown = undefined;
	startsWaiting = 0;
	clearTimeout(teardownExpiry);
	teardown?.resolve();
	activeMutations.clear();
	mutationBlocks.clear();
	for (const key of [...releaseWaiters.keys()]) wakeReleaseWaiters(key);
}

/** A held per-physical-device mutation lease. `release()` is idempotent. */
export interface ModemMutationLease {
	readonly stableKey: string;
	release(): void;
}

export interface ModemJournalLease extends ModemMutationLease {
	/** Atomically exclude Start on this same token before a disruptive command. */
	tryUpgrade(): boolean;
}

export type ModemMutationAdmission =
	| { readonly admitted: true; readonly lease: ModemMutationLease }
	| { readonly admitted: false; readonly refusal: ModemMutationRefusal };

/** Why one physical identity is currently refusing mutations, from the journal. */
export interface MutationBlock {
	readonly stableKey: string;
	readonly unitLinkId?: string;
	readonly deviceVidPid?: string;
	readonly matchUsbVendor?: true;
	readonly refusal: ModemMutationRefusal;
	/** Whether it ALSO holds global stream autostart (a decommission does not). */
	readonly blocksStreaming: boolean;
}

/** journalOnly: an operator/recovery journal owner, which never touches the stream. */
const activeMutations = new Map<
	string,
	{ readonly token: number; readonly journalOnly: boolean }
>();
const mutationBlocks = new Map<string, MutationBlock>();
let nextMutationToken = 0;

/**
 * Try to take the mutation lease for one physical device.
 *
 * The refusal order is the contract. Replay first, because a device that has not
 * finished recovering cannot yet prove anything about itself; then the journal's
 * fail-closed blocks; then this device's own in-flight mutation; and only then the
 * reciprocal streaming check. Reordering it would let a blocked device answer
 * "a stream is running" — true, but not the fact the operator has to act on.
 */
function modemMutationRefusal(
	stableKey: string,
	ownToken?: number,
): ModemMutationRefusal | undefined {
	if (isRecoveryPending() || isHelperRecoveryPending())
		return "recovery_pending";
	const block = mutationBlocks.get(stableKey);
	if (block) return block.refusal;
	const owner = activeMutations.get(stableKey);
	if (owner && owner.token !== ownToken) return "mutation_in_progress";
	if (isForwardActive() || held?.holder === "streaming")
		return "streaming_active";
	if (held) return "mutation_in_progress";
	return undefined;
}

export function tryAcquireModemMutation(
	stableKey: string,
): ModemMutationAdmission {
	const refusal = modemMutationRefusal(stableKey);
	if (refusal) return { admitted: false, refusal };
	return { admitted: true, lease: grantKeyLease(stableKey, false) };
}

/**
 * Reconstruct the lease for a helper job that systemd already owns.
 * Fresh actions use tryAcquireModemMutation, which stays closed until
 * ordinary recovery has finished. This path does not open that admission.
 */
export function tryAcquireHelperRecoveryLease(
	stableKey: string,
): ModemMutationAdmission {
	if (activeMutations.has(stableKey)) {
		return { admitted: false, refusal: "mutation_in_progress" };
	}
	if (isForwardActive() || held?.holder === "streaming") {
		return { admitted: false, refusal: "streaming_active" };
	}
	if (held) return { admitted: false, refusal: "mutation_in_progress" };
	return { admitted: true, lease: grantKeyLease(stableKey, false) };
}

function grantKeyLease(
	stableKey: string,
	journalOnly: boolean,
): ModemJournalLease {
	nextMutationToken += 1;
	const token = nextMutationToken;
	activeMutations.set(stableKey, { token, journalOnly });
	return {
		stableKey,
		tryUpgrade: () => {
			if (
				activeMutations.get(stableKey)?.token !== token ||
				modemMutationRefusal(stableKey, token)
			)
				return false;
			activeMutations.set(stableKey, { token, journalOnly: false });
			return true;
		},
		release: () => {
			if (activeMutations.get(stableKey)?.token !== token) return;
			activeMutations.delete(stableKey);
			wakeReleaseWaiters(stableKey);
		},
	};
}

const releaseWaiters = new Map<string, Set<() => void>>();

function wakeReleaseWaiters(stableKey: string): void {
	const waiters = releaseWaiters.get(stableKey);
	releaseWaiters.delete(stableKey);
	for (const wake of waiters ?? []) wake();
}

/**
 * The same per-key lease, for journal owners that must not pass ordinary
 * admission: an operator retirement, replay or failed-transition settlement
 * exists precisely to act on a recovering or blocked identity. It excludes only
 * the same key, so a retirement can never outlive the authority it validated
 * while a new mutation arms that slot. Never awaits; undefined means held.
 */
export function tryAcquireModemJournalKey(
	stableKey: string,
): ModemJournalLease | undefined {
	return activeMutations.has(stableKey)
		? undefined
		: grantKeyLease(stableKey, true);
}

/**
 * Resolve true once the current holder of `stableKey` releases, false when the
 * signal aborts first. The waiter holds nothing, so it cannot extend a lock
 * order; it must reread and re-acquire after waking.
 */
export function awaitModemMutationRelease(
	stableKey: string,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	if (!activeMutations.has(stableKey)) return Promise.resolve(true);
	return new Promise((resolve) => {
		const waiters = releaseWaiters.get(stableKey) ?? new Set<() => void>();
		releaseWaiters.set(stableKey, waiters);
		const onAbort = () => {
			signal?.removeEventListener("abort", onAbort);
			waiters.delete(wake);
			if (waiters.size === 0 && releaseWaiters.get(stableKey) === waiters)
				releaseWaiters.delete(stableKey);
			resolve(false);
		};
		const wake = () => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		};
		waiters.add(wake);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function isModemMutationHeld(stableKey: string): boolean {
	return activeMutations.has(stableKey);
}

export function heldModemMutations(): readonly string[] {
	return [...activeMutations.keys()];
}

/**
 * Publish the journal's current fail-closed blocks. Replacing the whole set is
 * deliberate: a block that no longer exists on disk must stop being enforced in
 * the same operation that stops recording it, so the two cannot disagree.
 */
export function setMutationBlocks(blocks: readonly MutationBlock[]): void {
	const changed =
		blocks.length !== mutationBlocks.size ||
		blocks.some((block) => {
			const old = mutationBlocks.get(block.stableKey);
			return (
				!old ||
				old.refusal !== block.refusal ||
				old.unitLinkId !== block.unitLinkId ||
				old.deviceVidPid !== block.deviceVidPid ||
				old.matchUsbVendor !== block.matchUsbVendor ||
				old.blocksStreaming !== block.blocksStreaming
			);
		});
	mutationBlocks.clear();
	for (const block of blocks) mutationBlocks.set(block.stableKey, block);
	if (changed) for (const listener of mutationBlockListeners) listener();
}

const mutationBlockListeners = new Set<() => void>();

/** Called after the block set changed; the bond re-derives its members. */
export function onMutationBlocksChange(listener: () => void): () => void {
	mutationBlockListeners.add(listener);
	return () => mutationBlockListeners.delete(listener);
}

/** Whether this physical identity is blocked by the journal. */
export function isModemKeyBlocked(stableKey: string): boolean {
	return mutationBlocks.has(stableKey);
}

/** Keep the original port and verified unit held. Scope uncertainty by USB SKU. */
export function modemBlockMatches(
	block: MutationBlock,
	port: string | undefined,
	vidPid: string,
	unit: string | undefined,
): boolean {
	if (
		block.stableKey === port ||
		(unit !== undefined && block.unitLinkId === unit)
	)
		return true;
	if (block.deviceVidPid !== undefined) {
		// A USB composition change can replace the product ID while keeping
		// the same device. Unresolved returns can only be narrowed by vendor.
		const matches = block.matchUsbVendor
			? block.deviceVidPid.slice(0, 4) === vidPid.slice(0, 4)
			: block.deviceVidPid === vidPid;
		if (!matches) return false;
	}
	return (
		port === undefined || (unit === undefined && block.unitLinkId !== undefined)
	);
}

export function hasMutationBlocks(): boolean {
	return mutationBlocks.size > 0;
}

export function getMutationBlocks(): readonly MutationBlock[] {
	return [...mutationBlocks.values()];
}

/** The first block the journal says holds global stream autostart, if any. */
export function streamingBlockingMutation(): MutationBlock | undefined {
	for (const block of mutationBlocks.values()) {
		if (block.blocksStreaming) return block;
	}
	return undefined;
}

/**
 * The block that actually refuses a new stream, if any.
 *
 * A modem whose change failed or that went missing mid-change
 * (`mutation_blocked`) is kept out of the bond by its stable key
 * (`isBondCandidate`), so it can no longer reach a stream and does not hold the
 * other links. A mutation still in flight (`mutation_in_progress`) keeps holding
 * every start until it settles.
 */
export function globalStreamHold(): MutationBlock | undefined {
	for (const block of mutationBlocks.values()) {
		if (block.blocksStreaming && block.refusal !== "mutation_blocked")
			return block;
	}
	return undefined;
}
