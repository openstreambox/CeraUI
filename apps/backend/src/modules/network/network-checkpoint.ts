import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { EffectRegistry } from "./network-change-effects.ts";
import {
	type ChallengeRecord,
	emptyJournal,
	type Journal,
	type JournalStore,
	type NetworkChangePlan,
	type NoticeRecord,
	type ProfileRecord,
	type TxRecord,
} from "./network-change-journal.ts";
import {
	type AskBeforeAnswer,
	type AskBeforePrompt,
	askBeforePrompt,
	CONFIRMATION_CODE,
	classifyPath,
	confirmedLabelKey,
	DEFAULT_SETTLE_MS,
	DEFAULT_WINDOW_SECONDS,
	isAskBeforeAnswer,
	type NoticeReason,
	needsAskBefore,
	noticeMessageKey,
	type SessionRoute,
	sessionCanConfirm,
} from "./network-change-policy.ts";

export interface NetworkChangeSession {
	readonly id: string;
	readonly openedAt: number;
	readonly authenticated: boolean;
	/** Trusted arrival interface; unavailable evidence must remain undefined. */
	readonly ingress: string | undefined;
	/**
	 * The box's own route back to a session without arrival evidence. Used only
	 * to tell the person up front that a change cuts them; never to confirm.
	 */
	readonly route?: SessionRoute | undefined;
	/** SHA-256 (hex) of the socket's auth token: the browser login. */
	readonly tokenHash?: string | undefined;
	/** `Origin` and `Host` of the socket's WebSocket upgrade: the UI address. */
	readonly origin?: string | undefined;
	readonly host?: string | undefined;
	/** When the socket opened, on the boot clock (see `NetworkChangeDeps.clock`). */
	readonly openedClock?: number | undefined;
}

/**
 * A checkpoint and the NetworkManager instance that made it. NetworkManager
 * numbers checkpoint paths from 1 again after a restart, so a path alone can
 * name someone else's checkpoint. `owner` is that instance's unique bus name
 * (never reused on a bus), and every operation is sent to it; `created` is the
 * checkpoint's `Created` stamp.
 */
export interface CheckpointRef {
	readonly path: string;
	readonly owner: string;
	readonly created: string;
	/** The D-Bus instance `owner` is on: a fresh bus may reuse unique names. */
	readonly bus: string;
}

/** NetworkManager operations. Candidates are the only profiles edited in memory. */
export interface NmChangeDeps {
	/** Throws unless it can return a complete identity. */
	create(devices: string[], timeout: number): Promise<CheckpointRef>;
	live(ref: CheckpointRef): Promise<boolean>;
	/** Sent to `ref.owner`: fails, never reaches another daemon's checkpoint. */
	destroy(ref: CheckpointRef): Promise<void>;
	rollback(ref: CheckpointRef): Promise<void>;
	describe(uuid: string): Promise<{ id: string; autoconnect: boolean }>;
	/** In-memory clone, named so a sweep can find it without the journal. */
	cloneCandidate(uuid: string, name: string): Promise<string>;
	modifyInMemory(
		uuid: string,
		set: ReadonlyArray<readonly [string, string]>,
	): Promise<void>;
	activate(uuid: string, device: string): Promise<void>;
	activeOn(device: string): Promise<string | undefined>;
	/** Persistent rename + autoconnect: writes the profile to disk. */
	persist(uuid: string, id: string, autoconnect: boolean): Promise<void>;
	/** Idempotent: a missing profile is not an error. */
	remove(uuid: string): Promise<void>;
	/** Whether a profile exists (in memory or on disk). Throws when unknown. */
	exists(uuid: string): Promise<boolean>;
	listByPrefix(prefix: string): Promise<string[]>;
}

export interface NetworkChangeDeps {
	/** Wall time, for display and records from another boot. */
	readonly now: () => number;
	/**
	 * Milliseconds since boot (CLOCK_BOOTTIME), comparable across processes of
	 * the same boot. Deadlines and the settle floor use it, so an NTP step
	 * after an uplink change cannot shorten or stretch them. Undefined when it
	 * can't be read: then no boot-clock stamp is written, deadlines fall back
	 * to wall time, and nobody can confirm (no comparable stamps). Defaults to
	 * `now` (tests).
	 */
	readonly clock?: () => number | undefined;
	readonly bootId: () => Promise<string>;
	readonly nm: NmChangeDeps;
	readonly effects: EffectRegistry;
	readonly journal: JournalStore;
	readonly windowSeconds?: number;
	readonly settleMs?: number;
	/** Called after every journal change so every open UI can refresh. */
	readonly onChange?: () => void;
	/**
	 * Called when a change becomes the box's configuration ("committed": a
	 * confirmation, a roll-forward after a crash, or the deliberate "don't undo
	 * it" answer), when a kept change is undone ("reverted"), and after an
	 * automatic undo ("undone"). Callers persist their own intent here, never at
	 * apply time, so an unconfirmed change leaves nothing behind that a later
	 * reconcile could re-apply. It may run again after a crash, so it must be
	 * idempotent. A throw leaves the transaction in place for the next attempt.
	 */
	readonly onSettled?: (event: SettledEvent) => Promise<void> | void;
	/** Whether a stream is live, so the prompt can warn about an undo. */
	readonly isStreaming?: () => boolean;
	/** Diagnostics for retries that would otherwise be silent. */
	readonly log?: (message: string) => void;
}

export interface SettledEvent {
	/**
	 * committed: the change is now the configuration. reverted: a kept change
	 * was undone on request. undone: an unconfirmed or failed change was undone
	 * automatically (nothing was persisted for it).
	 */
	readonly outcome: "committed" | "reverted" | "undone";
	/** Why an automatic undo ran; "failed" means the apply itself failed. */
	readonly reason?: NoticeReason | "failed" | undefined;
	readonly plan: NetworkChangePlan;
	/**
	 * Each edited profile's original UUID and its candidate's. After a commit
	 * the candidate is the real profile (promotion gives a new UUID); after a
	 * revert or an undo the original is.
	 */
	readonly profiles: ReadonlyArray<{
		readonly original: string;
		readonly candidate: string | undefined;
	}>;
}

/**
 * Another protected change is pending, being undone or being saved. Typed, so
 * callers can say "a change is in flight" instead of a generic failure.
 */
export class NetworkChangeInFlightError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NetworkChangeInFlightError";
	}
}

/**
 * Why a confirmation was refused. Typed, so the page can react: `too_early`
 * means "open a new connection after the settle time and try again"; every
 * other reason is final for this change.
 */
export type ConfirmRefusal =
	| "not_pending"
	| "expired"
	| "too_early"
	| "wrong_code"
	| "not_requester"
	| "wrong_address"
	/** No comparable boot-clock stamps: the box can't tell when the socket opened. */
	| "unverifiable";

export class NetworkChangeConfirmError extends Error {
	constructor(readonly reason: ConfirmRefusal) {
		super(`Confirmation refused: ${reason}`);
		this.name = "NetworkChangeConfirmError";
	}
}

/** SHA-256 hex digest: how the journal keeps the code and the token. */
export function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function sameDigest(a: string, b: string): boolean {
	const left = Buffer.from(a, "hex");
	const right = Buffer.from(b, "hex");
	return left.length === right.length && timingSafeEqual(left, right);
}

export const CANDIDATE_PREFIX = "ceralive-candidate-";
export const BACKUP_PREFIX = "ceralive-backup-";

export type ApplyResult =
	| AskBeforePrompt
	| {
			readonly kind: "pending";
			readonly id: string;
			/** Wall time of the deadline on the box's clock (display only). */
			readonly expiresAt: number;
			/** Time left until the box undoes the change. */
			readonly msLeft: number;
			/** Time until a new connection may confirm (the settle floor). */
			readonly confirmAfterMs: number;
			/** How long ago the floor passed (0 while it is ahead). */
			readonly floorAgoMs: number;
			/** Whether anyone can confirm it (the requester had a browser login). */
			readonly canConfirm: boolean;
	  }
	| {
			readonly kind: "kept";
			readonly id: string;
			/**
			 * The change is live and kept, but saving it did not finish (a failed
			 * profile or intent write). The tick finishes it and the caller's
			 * settle handler reports the outcome then.
			 */
			readonly saving?: true;
	  };

export interface ApplyOptions {
	readonly answer?: AskBeforeAnswer | undefined;
	/** Re-applying from an ask-after notice: always ask before. */
	readonly deliberate?: boolean;
	/**
	 * The notice this re-apply answers. Checked and consumed in the same
	 * serialized apply: a notice someone else answered meanwhile refuses it.
	 */
	readonly noticeId?: string;
	/**
	 * The one-time code the page minted for this change (CONFIRMATION_CODE).
	 * Required for a protected change from a session that can confirm; only
	 * its hash is stored.
	 */
	readonly confirmationCode?: string | undefined;
}

export interface NetworkChangeStatus {
	readonly pending: {
		readonly id: string;
		readonly expiresAt: number;
		readonly msLeft: number;
		readonly confirmAfterMs: number;
		readonly floorAgoMs: number;
		readonly path: string;
		/** The requester can confirm (from a new connection of their browser). */
		readonly canConfirm: boolean;
	} | null;
	/** The last confirmed change, labelled with where the confirmation came from. */
	readonly confirmed: {
		readonly id: string;
		readonly via: string | null;
		readonly labelKey: string;
	} | null;
	readonly kept: { readonly id: string; readonly undoKey: string } | null;
	readonly undoIncomplete: boolean;
	/**
	 * A confirmed or kept change whose commit did not finish (a failed profile
	 * write or intent write). The tick retries it.
	 */
	readonly commitIncomplete: boolean;
	/**
	 * Why an undo or a commit is stuck, and when the box tries again, so a
	 * person can see it instead of a change that silently never finishes.
	 */
	readonly problem: {
		readonly errors: string[];
		readonly nextAttemptAt?: number;
	} | null;
	readonly notice: {
		readonly id: string;
		readonly reason: NoticeReason;
		readonly messageKey: string;
		readonly summary: NetworkChangePlan["summary"];
	} | null;
}

/** Retry delay after the nth incomplete undo: 5 s doubling, at most 5 min. */
export function undoBackoffMs(attempts: number): number {
	return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 300_000);
}

/**
 * One owner for every risky network change. NetworkManager owns the timer and
 * the profile snapshot; this owner holds the journal, the recorded undos of
 * effects outside NetworkManager, and the confirmation policy.
 *
 * Invariants:
 * - the live profile is never edited before confirmation: edits go to an
 *   in-memory candidate clone, promoted only on confirmation;
 * - every candidate and every undo is journaled before it exists;
 * - an unconfirmed change never outlives a NetworkManager restart, a backend
 *   restart or a reboot (`reconcile`);
 * - only the requester confirms: a new connection of the same browser login,
 *   to the same UI address, opened after the settle time, presenting the
 *   change's one-time code (network-change-policy.ts).
 */
export function createNetworkChangeOwner(deps: NetworkChangeDeps) {
	const window = deps.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
	const settle = deps.settleMs ?? DEFAULT_SETTLE_MS;
	const clock = deps.clock ?? deps.now;
	let busy = false;
	let queued = 0;
	let queue: Promise<unknown> = Promise.resolve();
	const inside = new AsyncLocalStorage<true>();
	let boot: string | undefined;

	/** This boot's id, read once. */
	async function currentBoot() {
		boot ??= await deps.bootId();
		return boot;
	}

	/** Boot-clock stamps are comparable only within the boot that wrote them. */
	async function sameBoot(tx: TxRecord) {
		return tx.bootId === (await currentBoot());
	}

	/**
	 * Time left until the deadline: on the boot clock when the record has it
	 * and was written in this boot, else on the wall clock.
	 */
	async function msLeft(tx: TxRecord): Promise<number> {
		const now = clock();
		if (
			tx.expiresClock !== undefined &&
			now !== undefined &&
			(await sameBoot(tx))
		)
			return tx.expiresClock - now;
		// Recovery policy without comparable stamps (another boot, an older
		// record, an unreadable boot clock): wall time. NetworkManager's own
		// timer still bounds the change; this only decides when the owner
		// gives up on it.
		return (tx.expiresAt ?? 0) - deps.now();
	}

	async function expired(tx: TxRecord) {
		return (await msLeft(tx)) <= 0;
	}

	/** Gone well before its deadline: a restart cut it short. */
	async function goneEarly(tx: TxRecord) {
		return (await msLeft(tx)) > 2_000;
	}

	/**
	 * Time until the settle floor has passed since the apply, on the boot
	 * clock only; undefined without comparable stamps (nobody can confirm).
	 */
	async function msToFloor(tx: TxRecord): Promise<number | undefined> {
		const now = clock();
		if (
			tx.appliedClock === undefined ||
			now === undefined ||
			!(await sameBoot(tx))
		)
			return undefined;
		return tx.appliedClock + settle - now;
	}

	/** The status fields for the floor: time until it, and since it passed. */
	async function floorFields(tx: TxRecord) {
		const floor = await msToFloor(tx);
		return {
			confirmAfterMs: floor === undefined ? 0 : Math.max(0, floor),
			floorAgoMs: floor === undefined ? 0 : Math.max(0, -floor),
		};
	}

	/**
	 * Whether this session could confirm a change applied now: a browser login
	 * (`sessionCanConfirm`) and a readable boot clock to stamp it with. The
	 * prompt and the challenge use this one predicate.
	 */
	function canConfirmNow(session: NetworkChangeSession) {
		return sessionCanConfirm(session) && clock() !== undefined;
	}

	async function save(journal: Journal) {
		await deps.journal.write(journal);
		deps.onChange?.();
	}

	async function settled(tx: TxRecord, outcome: SettledEvent["outcome"]) {
		await deps.onSettled?.({
			outcome,
			...(outcome === "undone" ? { reason: tx.undoReason } : {}),
			plan: tx.plan,
			profiles: tx.profiles.map((p) => ({
				original: p.original,
				candidate: p.candidate,
			})),
		});
	}

	/**
	 * One operation at a time. A request that arrives while another runs waits
	 * for it rather than failing with "busy"; the tick alone skips a turn.
	 */
	function exclusive<T>(fn: () => Promise<T>): Promise<T> {
		// A call from inside a running operation (an onSettled handler that
		// calls back into the owner) would wait for itself forever.
		if (inside.getStore())
			return Promise.reject(new Error("Nested network change"));
		queued++;
		const run = queue.then(async () => {
			queued--;
			busy = true;
			try {
				return await inside.run(true, fn);
			} finally {
				busy = false;
			}
		});
		queue = run.catch(() => undefined);
		return run;
	}

	/**
	 * The transaction's checkpoint with its full identity. A record without
	 * one (written before identities were journaled) yields undefined: it is
	 * treated as gone, and no destructive call is ever sent by path alone.
	 */
	async function checkpointRef(
		tx: TxRecord,
	): Promise<CheckpointRef | undefined> {
		if (
			!tx.checkpoint ||
			!tx.checkpointOwner ||
			!tx.checkpointCreated ||
			!tx.checkpointBus
		)
			return undefined;
		// A checkpoint never survives a reboot; after one, the stamp and the
		// unique name could both be reused, so the record names nothing.
		if (!(await sameBoot(tx))) return undefined;
		return {
			path: tx.checkpoint,
			owner: tx.checkpointOwner,
			created: tx.checkpointCreated,
			bus: tx.checkpointBus,
		};
	}

	/** No checkpoint (an effect-only change): the journaled deadline alone. */
	async function checkpointLive(tx: TxRecord) {
		if (!tx.checkpoint) return true;
		const ref = await checkpointRef(tx);
		return ref ? deps.nm.live(ref) : false;
	}

	/** A restart before the apply finished interrupted it; nobody could confirm. */
	function restartReason(tx: TxRecord): NoticeReason {
		return tx.appliedAt === undefined ? "interrupted" : "restart";
	}

	function allDevices(plan: NetworkChangePlan) {
		const devices = new Set(plan.devices);
		for (const effect of plan.effects)
			for (const device of effect.devices) devices.add(device);
		return [...devices];
	}

	async function sweepOrphans(journal: Journal) {
		const known = new Set(
			journal.tx?.profiles.flatMap((p) => (p.candidate ? [p.candidate] : [])),
		);
		const kept = journal.tx?.state === "kept";
		for (const uuid of await deps.nm.listByPrefix(CANDIDATE_PREFIX)) {
			// A promoted candidate of a kept change already carries the real name.
			if (kept && known.has(uuid)) continue;
			await deps.nm.remove(uuid);
		}
	}

	/** Undo everything the transaction did, idempotently, in reverse order. */
	async function undo(
		journal: Journal,
		reason: NoticeReason | "failed" | undefined,
	) {
		const tx = journal.tx;
		if (!tx) return;
		if (tx.state !== "rolling-back") {
			tx.state = "rolling-back";
			tx.undoReason = reason;
			await save(journal);
		}
		const errors: string[] = [];
		const attempt = async (what: string, step: () => Promise<void>) => {
			try {
				await step();
			} catch (error) {
				errors.push(`${what}: ${(error as Error).message}`);
			}
		};
		const ref = await checkpointRef(tx);
		if (ref) {
			// Sent to the daemon that made it; after a restart the call fails
			// or the checkpoint is no longer live, and the owner's own steps
			// below undo the change.
			await attempt("checkpoint", async () => {
				if (await deps.nm.live(ref)) await deps.nm.rollback(ref);
			});
		}
		for (const profile of [...tx.profiles].reverse()) {
			const candidate = profile.candidate;
			if (candidate)
				await attempt("candidate", () => deps.nm.remove(candidate));
		}
		await attempt("sweep", () => sweepOrphans({ ...journal, tx: null }));
		for (const effect of [...tx.effects].reverse()) {
			if (effect.state === "undone") continue;
			try {
				await deps.effects.get(effect.kind).undo(effect.undo);
				effect.state = "undone";
				await save(journal);
			} catch (error) {
				errors.push(`${effect.kind}: ${(error as Error).message}`);
			}
		}
		for (const profile of tx.profiles) {
			const device = profile.wasActiveOn;
			if (!device) continue;
			await attempt("reactivate", async () => {
				if ((await deps.nm.activeOn(device)) !== profile.original)
					await deps.nm.activate(profile.original, device);
			});
		}
		if (errors.length) {
			// Keep the record: the next tick or restart retries the same undo,
			// backing off so a device that stays missing (an unplugged USB NIC)
			// is retried every few minutes, not every 5 s, and logged each time.
			const attempts = (tx.undoAttempts ?? 0) + 1;
			tx.undoAttempts = attempts;
			tx.nextAttemptAt = deps.now() + undoBackoffMs(attempts);
			tx.errors = errors;
			await save(journal);
			deps.log?.(
				`network change ${tx.id.slice(0, 8)}: undo attempt ${attempts} incomplete (${errors.join("; ")}); next try in ${Math.round(undoBackoffMs(attempts) / 1000)} s`,
			);
			return false;
		}
		const noticeReason = tx.undoReason;
		await settled(tx, "undone");
		journal.tx = null;
		// A kept or confirmed change lost before it reached disk is reported
		// too: the person chose it, and the box could not keep it.
		if (
			(tx.mode !== "keep-change" && noticeReason === "disconnected") ||
			noticeReason === "restart" ||
			noticeReason === "interrupted" ||
			noticeReason === "unsaved"
		) {
			journal.notice = {
				id: randomUUID(),
				reason: noticeReason,
				createdAt: deps.now(),
				plan: tx.plan,
			};
		}
		await save(journal);
		return true;
	}

	/** Confirmed (or kept): candidates become the real profiles. Idempotent. */
	async function promote(journal: Journal, keepBackups: boolean) {
		const tx = journal.tx as TxRecord;
		for (const profile of tx.profiles) {
			if (!profile.candidate) continue;
			if (!profile.promoted) {
				// Persist first: deleting the original before the candidate is on
				// disk would lose both on a crash.
				await deps.nm.persist(
					profile.candidate,
					profile.originalId,
					profile.commitAutoconnect ?? profile.originalAutoconnect,
				);
				profile.promoted = true;
				await save(journal);
			}
			if (keepBackups) {
				if (!profile.backupId) {
					const backupId = `${BACKUP_PREFIX}${tx.id.slice(0, 8)}-${tx.profiles.indexOf(profile)}`;
					await deps.nm.persist(profile.original, backupId, false);
					profile.backupId = backupId;
					await save(journal);
				}
			} else {
				await deps.nm.remove(profile.original);
			}
		}
		await settled(tx, "committed");
	}

	async function finishKept(journal: Journal) {
		const tx = journal.tx;
		if (tx?.state !== "kept") return;
		for (const profile of tx.profiles)
			if (profile.backupId) await deps.nm.remove(profile.original);
		journal.tx = null;
		await save(journal);
	}

	function commitOpen(tx: TxRecord | null): boolean {
		return (
			tx?.state === "confirming" ||
			(tx?.state === "kept" && tx.settled !== true)
		);
	}

	/**
	 * Finish a confirmed ("confirming") or kept change: promote, settle, close.
	 * Idempotent, so reconcile and the tick can retry it. When a candidate that
	 * never reached disk is gone (a reboot or a NetworkManager restart after
	 * the checkpoint was destroyed), nothing was committed and the originals
	 * are intact on disk, so the change is undone instead of retried forever.
	 */
	async function finishCommit(
		journal: Journal,
	): Promise<"committed" | "undone" | "incomplete"> {
		const tx = journal.tx as TxRecord;
		const keep = tx.state === "kept";
		const lost: ProfileRecord[] = [];
		for (const profile of tx.profiles)
			if (
				profile.candidate &&
				!profile.promoted &&
				!(await deps.nm.exists(profile.candidate))
			)
				lost.push(profile);
		if (lost.length) {
			if (tx.profiles.some((profile) => profile.promoted)) {
				// Part of the change is on disk and part is gone: neither a
				// roll-forward nor an undo is safe without a person.
				tx.errors = ["A candidate was lost after part of the change was saved"];
				await save(journal);
				return "incomplete";
			}
			// Confirmed or kept, then lost before it reached disk: say so, rather
			// than "the network restarted before you confirmed".
			return (await undo(journal, "unsaved")) ? "undone" : "incomplete";
		}
		try {
			await promote(journal, keep);
		} catch (error) {
			tx.errors = [(error as Error).message];
			await save(journal);
			throw error;
		}
		delete tx.errors;
		if (keep) {
			tx.settled = true;
		} else {
			if (tx.confirmedVia !== undefined)
				journal.confirmed = {
					id: tx.id,
					via: tx.confirmedVia,
					at: deps.now(),
				};
			journal.tx = null;
		}
		await save(journal);
		return "committed";
	}

	async function settleStale(journal: Journal) {
		const tx = journal.tx;
		if (!tx || (tx.state === "kept" && tx.settled === true)) return;
		if (commitOpen(tx)) {
			await finishCommit(journal);
			if (journal.tx && commitOpen(journal.tx))
				throw new NetworkChangeInFlightError(
					"The previous change is still being saved",
				);
			return;
		}
		if (tx.state === "pending") {
			const live = await checkpointLive(tx);
			if (live && !(await expired(tx)))
				throw new NetworkChangeInFlightError("Network change pending");
			const early = !live && (await goneEarly(tx));
			await undo(journal, early ? "restart" : "disconnected");
		} else {
			// An undo that keeps failing waits for its backoff here too, so
			// changes on other ports can't turn it back into a tight retry.
			if (tx.state === "rolling-back" && deps.now() < (tx.nextAttemptAt ?? 0))
				throw new NetworkChangeInFlightError(
					"Undo of the previous change incomplete",
				);
			await undo(journal, tx.undoReason ?? restartReason(tx));
		}
		if (journal.tx)
			throw new NetworkChangeInFlightError(
				"Undo of the previous change incomplete",
			);
	}

	async function start(
		session: NetworkChangeSession,
		plan: NetworkChangePlan,
		options: ApplyOptions,
	): Promise<ApplyResult> {
		// Answers arrive as data from the UI; refuse anything else before acting.
		if (options.answer !== undefined && !isAskBeforeAnswer(options.answer))
			throw new Error("Unknown answer");
		const code = options.confirmationCode;
		if (code !== undefined && !CONFIRMATION_CODE.test(code))
			throw new Error("Invalid confirmation code");
		const devices = allDevices(plan);
		if (!session.authenticated || devices.length === 0)
			throw new Error("Network change unavailable");
		for (const effect of plan.effects) deps.effects.get(effect.kind);
		const journal = await deps.journal.read();
		if (
			options.noticeId !== undefined &&
			journal.notice?.id !== options.noticeId
		)
			throw new Error("Notice already answered");
		await settleStale(journal);
		const path = classifyPath(devices, session.ingress);
		const deliberate = options.deliberate === true;
		const canConfirm = canConfirmNow(session);
		if (needsAskBefore(path, deliberate) && options.answer === undefined)
			return askBeforePrompt({
				path,
				ingress: session.ingress,
				devices,
				route: session.route,
				seconds: window,
				settleSeconds: Math.round(settle / 1000),
				canConfirm,
				live: deps.isStreaming?.() === true,
			});
		// Only an explicit "keep-change" keeps a change without the undo.
		const mode: AskBeforeAnswer = options.answer ?? "undo-automatically";
		// A protected change from a browser login is bound to the code its page
		// minted. Without one, nobody could confirm it: refuse before acting
		// rather than start a change that is certain to be undone.
		if (mode === "undo-automatically" && canConfirm && code === undefined)
			throw new Error("Confirmation code required");
		const challenge: ChallengeRecord | undefined =
			mode === "undo-automatically" && canConfirm && code !== undefined
				? {
						codeHash: sha256Hex(code),
						tokenHash: session.tokenHash as string,
						origin: session.origin as string,
						host: session.host as string,
					}
				: undefined;
		await finishKept(journal);

		const startedAt = deps.now();
		const startedClock = clock();
		// A challenge needs boot-clock stamps; without them it can't be met.
		if (challenge && startedClock === undefined)
			throw new Error("Boot clock unavailable");
		const tx: TxRecord = {
			id: randomUUID(),
			bootId: await currentBoot(),
			state: "applying",
			mode,
			path,
			creator: session.id,
			devices,
			startedAt,
			...(startedClock === undefined ? {} : { startedClock }),
			plan,
			profiles: [],
			effects: [],
			...(challenge ? { challenge } : {}),
		};
		journal.tx = tx;
		// A new change replaces the last confirmation label.
		journal.confirmed = null;
		// A re-apply answers its notice in the same write that starts it.
		if (options.noticeId !== undefined) journal.notice = null;
		await save(journal);
		try {
			if (mode !== "keep-change") {
				tx.expiresAt = startedAt + window * 1000;
				if (startedClock !== undefined)
					tx.expiresClock = startedClock + window * 1000;
				// Only interfaces NetworkManager manages. Effect interfaces may not be
				// NetworkManager devices, and a torn-down one no longer exists.
				const managed = [...new Set(plan.devices)];
				if (plan.profiles.length) {
					if (!managed.length) throw new Error("Network change unavailable");
					const ref = await deps.nm.create(managed, window);
					if (!ref?.path || !ref.owner || !ref.created)
						throw new Error("Network checkpoint identity unavailable");
					if (!ref.bus)
						throw new Error("Network checkpoint identity unavailable");
					tx.checkpoint = ref.path;
					tx.checkpointOwner = ref.owner;
					tx.checkpointCreated = ref.created;
					tx.checkpointBus = ref.bus;
				}
				await save(journal);
			}
			for (const [index, edit] of plan.profiles.entries()) {
				const original = await deps.nm.describe(edit.uuid);
				const record = {
					original: edit.uuid,
					originalId: original.id,
					originalAutoconnect: original.autoconnect,
					commitAutoconnect: edit.autoconnect ?? original.autoconnect,
					wasActiveOn:
						edit.activateOn &&
						(await deps.nm.activeOn(edit.activateOn)) === edit.uuid
							? edit.activateOn
							: undefined,
				};
				tx.profiles.push(record);
				await save(journal);
				const name = `${CANDIDATE_PREFIX}${tx.id.slice(0, 8)}-${index}`;
				const candidate = await deps.nm.cloneCandidate(edit.uuid, name);
				tx.profiles[index] = { ...record, candidate };
				await save(journal);
				await deps.nm.modifyInMemory(candidate, [
					...edit.set,
					["connection.autoconnect", "no"],
				]);
			}
			for (const step of plan.effects) {
				const driver = deps.effects.get(step.kind);
				const effect = {
					kind: step.kind,
					undo: await driver.prepare(step.spec),
					state: "intent" as "intent" | "applied" | "undone",
				};
				tx.effects.push(effect);
				await save(journal);
				await driver.apply(step.spec);
				effect.state = "applied";
				await save(journal);
			}
			for (const [index, edit] of plan.profiles.entries()) {
				const candidate = tx.profiles[index]?.candidate;
				if (edit.activateOn && candidate)
					await deps.nm.activate(candidate, edit.activateOn);
			}
			tx.appliedAt = deps.now();
			const appliedClock = clock();
			if (appliedClock !== undefined) tx.appliedClock = appliedClock;
			if (mode === "keep-change") {
				tx.state = "kept";
				await save(journal);
				// A failure from here on leaves an unsettled kept change, which
				// reconcile and the tick finish (or undo, if nothing reached disk).
				// The change is live either way, so a failed save is reported as
				// kept-and-saving, not as a failed apply.
				let outcome: Awaited<ReturnType<typeof finishCommit>>;
				try {
					outcome = await finishCommit(journal);
				} catch {
					return { kind: "kept", id: tx.id, saving: true };
				}
				// Lost before it reached disk: undone (or being undone), not kept.
				if (outcome === "undone" || journal.tx?.state === "rolling-back")
					throw new Error("Network change could not be kept");
				if (outcome === "incomplete")
					return { kind: "kept", id: tx.id, saving: true };
				return { kind: "kept", id: tx.id };
			}
			if ((await expired(tx)) || !(await checkpointLive(tx)))
				throw new Error("Network change expired");
			tx.state = "pending";
			await save(journal);
			return {
				kind: "pending",
				id: tx.id,
				expiresAt: tx.expiresAt as number,
				msLeft: Math.max(0, await msLeft(tx)),
				...(await floorFields(tx)),
				canConfirm: tx.challenge !== undefined,
			};
		} catch (error) {
			if (journal.tx?.state !== "kept") await undo(journal, "failed");
			throw error;
		}
	}

	/**
	 * Destroy is the daemon-side expiry fence. Never promote before it: a
	 * timed-out checkpoint must not race a persistent candidate write.
	 */
	async function commitPending(journal: Journal, via: string | null) {
		const tx = journal.tx as TxRecord;
		if (tx.checkpoint) {
			const ref = await checkpointRef(tx);
			if (!ref) throw new Error("Network checkpoint identity unavailable");
			// Sent to the daemon that made the checkpoint: a restarted daemon
			// cannot answer it, so a destroy that succeeds destroyed ours.
			await deps.nm.destroy(ref);
		}
		tx.state = "confirming";
		tx.confirmedVia = via;
		await save(journal);
		// A failure here leaves "confirming"; the tick retries it.
		return finishCommit(journal);
	}

	/**
	 * The confirm rule (network-change-policy.ts). The code, the login and the
	 * UI address are checked before timing, so a wrong code is reported as
	 * such and a right one learns only whether to reconnect later.
	 */
	async function refusal(
		tx: TxRecord,
		code: string,
		session: NetworkChangeSession,
	): Promise<ConfirmRefusal | undefined> {
		const challenge = tx.challenge;
		if (
			!challenge ||
			!CONFIRMATION_CODE.test(code) ||
			!sameDigest(sha256Hex(code), challenge.codeHash)
		)
			return "wrong_code";
		if (
			!sessionCanConfirm(session) ||
			!sameDigest(session.tokenHash as string, challenge.tokenHash)
		)
			return "not_requester";
		if (session.origin !== challenge.origin || session.host !== challenge.host)
			return "wrong_address";
		const floor = await msToFloor(tx);
		if (floor === undefined) return "unverifiable";
		// The requester's existing connection, when front-door evidence shows
		// the change did not touch its path: after the settle time.
		if (
			tx.path === "other" &&
			session.id === tx.creator &&
			session.ingress !== undefined &&
			!tx.devices.includes(session.ingress)
		)
			return floor <= 0 ? undefined : "too_early";
		// Otherwise a connection opened after the settle time, both instants
		// on this boot's clock.
		if (session.openedClock === undefined) return "unverifiable";
		return session.openedClock >= (tx.appliedClock as number) + settle
			? undefined
			: "too_early";
	}

	return {
		/**
		 * Whether a change in flight names this interface: anything but a kept
		 * change that has fully settled. Other writers to that interface (the
		 * Ethernet role reconciler, a legacy role write) must leave it alone.
		 */
		async touches(device: string): Promise<boolean> {
			const tx = (await deps.journal.read()).tx;
			if (!tx || (tx.state === "kept" && tx.settled === true)) return false;
			return tx.devices.includes(device);
		},
		async status(): Promise<NetworkChangeStatus> {
			const journal = await deps.journal.read();
			const tx = journal.tx;
			const notice = journal.notice;
			return {
				pending:
					tx?.state === "pending"
						? {
								id: tx.id,
								expiresAt: tx.expiresAt as number,
								msLeft: Math.max(0, await msLeft(tx)),
								...(await floorFields(tx)),
								path: tx.path,
								canConfirm: tx.challenge !== undefined,
							}
						: null,
				confirmed: journal.confirmed
					? {
							id: journal.confirmed.id,
							via: journal.confirmed.via,
							labelKey: confirmedLabelKey(journal.confirmed.via),
						}
					: null,
				kept:
					tx?.state === "kept"
						? { id: tx.id, undoKey: "network.changeSafety.kept.undo" }
						: null,
				undoIncomplete: tx?.state === "rolling-back",
				commitIncomplete: commitOpen(tx ?? null),
				problem: tx?.errors?.length
					? {
							errors: [...tx.errors],
							...(tx.nextAttemptAt === undefined
								? {}
								: { nextAttemptAt: tx.nextAttemptAt }),
						}
					: null,
				notice: notice
					? {
							id: notice.id,
							reason: notice.reason,
							messageKey: noticeMessageKey(notice.reason),
							summary: notice.plan.summary,
						}
					: null,
			};
		},
		apply(
			session: NetworkChangeSession,
			plan: NetworkChangePlan,
			options: ApplyOptions = {},
		) {
			return exclusive(() => start(session, plan, options));
		},
		/**
		 * Keep a pending change: only its requester, from a new connection of
		 * the same browser login to the same UI address after the settle time,
		 * with the change's one-time code. Refusals are typed.
		 */
		confirm(
			id: string,
			code: string,
			session: NetworkChangeSession | (() => NetworkChangeSession),
		) {
			// The socket's session is read again at the fence: a password
			// change (token revoked or replaced) or lost ingress evidence while
			// this waited in the queue or on NetworkManager must refuse it.
			const current = typeof session === "function" ? session : () => session;
			return exclusive(async () => {
				const journal = await deps.journal.read();
				const tx = journal.tx;
				if (tx?.state !== "pending" || tx.id !== id)
					throw new NetworkChangeConfirmError("not_pending");
				if (await expired(tx)) throw new NetworkChangeConfirmError("expired");
				const refused = await refusal(tx, code, current());
				if (refused) throw new NetworkChangeConfirmError(refused);
				if (!(await checkpointLive(tx)))
					throw new NetworkChangeConfirmError("expired");
				// The fence, after the liveness round trip and as close to the
				// destroy as the owner gets: the owner's deadline (journaled
				// before NetworkManager armed its own, so never later than
				// NetworkManager's; it is the authoritative one) and the live
				// session. Only same-boot reads remain before the destroy.
				const live = current();
				const fenced = await refusal(tx, code, live);
				if (fenced) throw new NetworkChangeConfirmError(fenced);
				if (await expired(tx)) throw new NetworkChangeConfirmError("expired");
				const via = live.ingress ?? null;
				const result = await commitPending(journal, via);
				return {
					via,
					saved: result === "committed",
				};
			});
		},
		/** Run by a timer: NetworkManager's deadline passed or its checkpoint is gone. */
		tick() {
			// Skip a turn while anything runs or waits; never queue behind it.
			if (busy || queued > 0) return Promise.resolve(false);
			return exclusive(async () => {
				const journal = await deps.journal.read();
				const tx = journal.tx;
				if (!tx) return false;
				if (tx.state === "pending") {
					const live = await checkpointLive(tx);
					if (live && !(await expired(tx))) return false;
					const early = !live && (await goneEarly(tx));
					return undo(journal, early ? "restart" : "disconnected");
				}
				if (tx.state === "rolling-back") {
					if (deps.now() < (tx.nextAttemptAt ?? 0)) return false;
					return undo(journal, tx.undoReason);
				}
				if (commitOpen(tx))
					return (await finishCommit(journal)) !== "incomplete";
				return false;
			});
		},
		/**
		 * Run at backend start, when NetworkManager's bus name gets a new owner,
		 * and from a boot unit ordered after NetworkManager.
		 */
		reconcile(reason: "backend-start" | "network-restart" | "boot") {
			return exclusive(async () => {
				const journal = await deps.journal.read();
				const tx = journal.tx;
				if (!tx) {
					await sweepOrphans(journal);
					return "clean" as const;
				}
				if (
					tx.state === "pending" &&
					reason === "backend-start" &&
					(await sameBoot(tx)) &&
					!(await expired(tx)) &&
					(await checkpointLive(tx))
				) {
					// Only this process restarted: NetworkManager still holds the timer.
					return "resumed" as const;
				}
				if (commitOpen(tx)) {
					const kept = tx.state === "kept";
					const result = await finishCommit(journal);
					if (result === "undone") return "undone" as const;
					if (result === "incomplete") return "incomplete" as const;
					if (!kept) return "promoted" as const;
				}
				if (journal.tx?.state === "kept") {
					await sweepOrphans(journal);
					return "kept" as const;
				}
				// A pending change whose deadline already passed (the backend was
				// down when it expired) was not cut short by a restart.
				const lapsed = tx.state === "pending" && (await expired(tx));
				const done = await undo(
					journal,
					tx.state === "rolling-back"
						? tx.undoReason
						: lapsed
							? "disconnected"
							: restartReason(tx),
				);
				return done ? ("undone" as const) : ("incomplete" as const);
			});
		},
		/**
		 * The way out of an unreadable journal, serialized with every other
		 * operation: only a journal that still fails to read is moved aside
		 * (the store keeps it next to the original), then leftover candidates
		 * are swept. A readable journal is refused: it may hold an undo.
		 */
		resetDamagedJournal() {
			return exclusive(async () => {
				const quarantine = deps.journal.quarantine;
				if (!quarantine) throw new Error("Journal reset unavailable");
				let readable = true;
				try {
					await deps.journal.read();
				} catch {
					readable = false;
				}
				if (readable)
					throw new Error(
						"The network-change journal is readable; nothing to reset",
					);
				const movedTo = await quarantine();
				await sweepOrphans(emptyJournal());
				deps.onChange?.();
				return { movedTo };
			});
		},
		/** The deliberate "don't undo it" answer left a recorded undo; any signed-in connection may run it. */
		undoKept(id: string, session: NetworkChangeSession) {
			return exclusive(async () => {
				const journal = await deps.journal.read();
				const tx = journal.tx;
				if (
					!session.authenticated ||
					!tx ||
					tx.state !== "kept" ||
					tx.id !== id
				)
					throw new Error("Nothing to undo");
				for (const profile of [...tx.profiles].reverse()) {
					if (profile.candidate) await deps.nm.remove(profile.candidate);
					if (profile.backupId)
						await deps.nm.persist(
							profile.original,
							profile.originalId,
							profile.originalAutoconnect,
						);
				}
				for (const effect of [...tx.effects].reverse())
					if (effect.state !== "undone")
						await deps.effects.get(effect.kind).undo(effect.undo);
				for (const profile of tx.profiles)
					if (profile.wasActiveOn)
						await deps.nm.activate(profile.original, profile.wasActiveOn);
				await settled(tx, "reverted");
				journal.tx = null;
				await save(journal);
			});
		},
		/** Ask-after, "Make the change": the stored plan again, asked before. */
		reapply(
			noticeId: string,
			session: NetworkChangeSession,
			answer?: AskBeforeAnswer,
			confirmationCode?: string,
		) {
			return exclusive(async () => {
				const journal = await deps.journal.read();
				const notice = journal.notice;
				if (!session.authenticated || !notice || notice.id !== noticeId)
					throw new Error("Notice already answered");
				// The notice is checked and cleared inside the same apply.
				return start(session, notice.plan, {
					answer,
					deliberate: true,
					noticeId,
					confirmationCode,
				});
			});
		},
		/** Ask-after, "Leave it undone". */
		leaveUndone(noticeId: string, session: NetworkChangeSession) {
			return exclusive(async () => {
				const journal = await deps.journal.read();
				const notice: NoticeRecord | null = journal.notice;
				if (!session.authenticated || !notice || notice.id !== noticeId)
					throw new Error("Notice already answered");
				journal.notice = null;
				await save(journal);
			});
		},
	};
}

export { emptyJournal };
