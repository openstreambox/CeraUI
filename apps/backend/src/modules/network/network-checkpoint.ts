import { randomUUID } from "node:crypto";
import type { EffectRegistry } from "./network-change-effects.ts";
import {
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
	classifyPath,
	DEFAULT_SETTLE_MS,
	DEFAULT_WINDOW_SECONDS,
	isAskBeforeAnswer,
	type NoticeReason,
	needsAskBefore,
	noticeMessageKey,
} from "./network-change-policy.ts";

export interface NetworkChangeSession {
	readonly id: string;
	readonly openedAt: number;
	readonly authenticated: boolean;
	/** Trusted arrival interface; unavailable evidence must remain undefined. */
	readonly ingress: string | undefined;
}

/** NetworkManager operations. Candidates are the only profiles edited in memory. */
export interface NmChangeDeps {
	create(devices: string[], timeout: number): Promise<string>;
	live(path: string): Promise<boolean>;
	destroy(path: string): Promise<void>;
	rollback(path: string): Promise<void>;
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
	readonly now: () => number;
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

export const CANDIDATE_PREFIX = "ceralive-candidate-";
export const BACKUP_PREFIX = "ceralive-backup-";

export type ApplyResult =
	| AskBeforePrompt
	| {
			readonly kind: "pending";
			readonly id: string;
			readonly expiresAt: number;
	  }
	| { readonly kind: "kept"; readonly id: string };

export interface ApplyOptions {
	readonly answer?: AskBeforeAnswer | undefined;
	/** Re-applying from an ask-after notice: always ask before. */
	readonly deliberate?: boolean;
}

export interface NetworkChangeStatus {
	readonly pending: {
		readonly id: string;
		readonly expiresAt: number;
		readonly path: string;
	} | null;
	readonly kept: { readonly id: string; readonly undoKey: string } | null;
	readonly undoIncomplete: boolean;
	/**
	 * A confirmed or kept change whose commit did not finish (a failed profile
	 * write or intent write). The tick retries it.
	 */
	readonly commitIncomplete: boolean;
	readonly notice: {
		readonly id: string;
		readonly reason: NoticeReason;
		readonly messageKey: string;
		readonly summary: NetworkChangePlan["summary"];
	} | null;
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
 * - confirmation needs trusted arrival-interface evidence.
 */
export function createNetworkChangeOwner(deps: NetworkChangeDeps) {
	const window = deps.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
	const settle = deps.settleMs ?? DEFAULT_SETTLE_MS;
	let busy = false;

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

	async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
		if (busy) throw new Error("Network change busy");
		busy = true;
		try {
			return await fn();
		} finally {
			busy = false;
		}
	}

	/** No checkpoint (an effect-only change): the journaled deadline alone. */
	async function checkpointLive(tx: TxRecord) {
		return tx.checkpoint ? deps.nm.live(tx.checkpoint) : true;
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
		if (tx.checkpoint) {
			const path = tx.checkpoint;
			await attempt("checkpoint", async () => {
				if (await deps.nm.live(path)) await deps.nm.rollback(path);
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
			// Keep the record: the next tick or restart retries the same undo.
			tx.errors = errors;
			await save(journal);
			return false;
		}
		const noticeReason = tx.undoReason;
		await settled(tx, "undone");
		journal.tx = null;
		// A kept change lost before it reached disk is reported too: the person
		// chose to keep it, and the box could not.
		if (
			(tx.mode === "undo-automatically" && noticeReason === "disconnected") ||
			noticeReason === "restart"
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
			return (await undo(journal, "restart")) ? "undone" : "incomplete";
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
				throw new Error("The previous change is still being saved");
			return;
		}
		if (tx.state === "pending") {
			const live = await checkpointLive(tx);
			if (live && deps.now() < (tx.expiresAt ?? 0))
				throw new Error("Network change pending");
			const early = !live && deps.now() < (tx.expiresAt ?? 0) - 2_000;
			await undo(journal, early ? "restart" : "disconnected");
		} else {
			await undo(journal, tx.undoReason ?? "restart");
		}
		if (journal.tx) throw new Error("Undo of the previous change incomplete");
	}

	async function start(
		session: NetworkChangeSession,
		plan: NetworkChangePlan,
		options: ApplyOptions,
	): Promise<ApplyResult> {
		// Answers arrive as data from the UI; refuse anything else before acting.
		if (options.answer !== undefined && !isAskBeforeAnswer(options.answer))
			throw new Error("Unknown answer");
		const devices = allDevices(plan);
		if (!session.authenticated || devices.length === 0)
			throw new Error("Network change unavailable");
		for (const effect of plan.effects) deps.effects.get(effect.kind);
		const journal = await deps.journal.read();
		await settleStale(journal);
		const path = classifyPath(devices, session.ingress);
		const deliberate = options.deliberate === true;
		if (needsAskBefore(path, deliberate) && options.answer === undefined)
			return askBeforePrompt(path, session.ingress, window);
		// Only an explicit "keep-change" keeps a change without the undo.
		const mode: AskBeforeAnswer = options.answer ?? "undo-automatically";
		await finishKept(journal);

		const startedAt = deps.now();
		const tx: TxRecord = {
			id: randomUUID(),
			bootId: await deps.bootId(),
			state: "applying",
			mode,
			path,
			creator: session.id,
			devices,
			startedAt,
			plan,
			profiles: [],
			effects: [],
		};
		journal.tx = tx;
		await save(journal);
		try {
			if (mode === "undo-automatically") {
				tx.expiresAt = startedAt + window * 1000;
				// Only interfaces NetworkManager manages. Effect interfaces may not be
				// NetworkManager devices, and a torn-down one no longer exists.
				const managed = [...new Set(plan.devices)];
				if (plan.profiles.length) {
					if (!managed.length) throw new Error("Network change unavailable");
					tx.checkpoint = await deps.nm.create(managed, window);
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
			if (mode === "keep-change") {
				tx.state = "kept";
				await save(journal);
				// A failure from here on leaves an unsettled kept change, which
				// reconcile and the tick finish (or undo, if nothing reached disk).
				if ((await finishCommit(journal)) === "undone")
					throw new Error("Network change could not be kept");
				return { kind: "kept", id: tx.id };
			}
			if (deps.now() >= (tx.expiresAt ?? 0) || !(await checkpointLive(tx)))
				throw new Error("Network change expired");
			tx.state = "pending";
			await save(journal);
			return {
				kind: "pending",
				id: tx.id,
				expiresAt: tx.expiresAt as number,
			};
		} catch (error) {
			if (journal.tx?.state !== "kept") await undo(journal, "failed");
			throw error;
		}
	}

	function confirmable(tx: TxRecord, session: NetworkChangeSession) {
		if (!session.authenticated || !session.ingress) return false;
		const appliedAt = tx.appliedAt ?? Number.POSITIVE_INFINITY;
		if (tx.devices.includes(session.ingress))
			return session.id !== tx.creator && session.openedAt > appliedAt;
		// Another path: the creator's connection still working after the settle
		// time proves the change did not cut it. Never for own/unknown paths.
		return tx.path === "other" && deps.now() >= appliedAt + settle;
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
								path: tx.path,
							}
						: null,
				kept:
					tx?.state === "kept"
						? { id: tx.id, undoKey: "network.changeSafety.kept.undo" }
						: null,
				undoIncomplete: tx?.state === "rolling-back",
				commitIncomplete: commitOpen(tx ?? null),
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
		confirm(id: string, session: NetworkChangeSession) {
			return exclusive(async () => {
				const journal = await deps.journal.read();
				const tx = journal.tx;
				if (
					tx?.state !== "pending" ||
					tx.id !== id ||
					deps.now() >= (tx.expiresAt ?? 0) ||
					!confirmable(tx, session) ||
					!(await checkpointLive(tx))
				) {
					throw new Error(
						"Reconnect over the changed network before confirming",
					);
				}
				// Destroy is the daemon-side expiry fence. Never promote before it:
				// a timed-out checkpoint must not race a persistent candidate write.
				if (tx.checkpoint) await deps.nm.destroy(tx.checkpoint);
				tx.state = "confirming";
				await save(journal);
				// A failure here leaves "confirming"; the tick retries it.
				await finishCommit(journal);
			});
		},
		/** Run by a timer: NetworkManager's deadline passed or its checkpoint is gone. */
		tick() {
			if (busy) return Promise.resolve(false);
			return exclusive(async () => {
				const journal = await deps.journal.read();
				const tx = journal.tx;
				if (!tx) return false;
				if (tx.state === "pending") {
					const live = await checkpointLive(tx);
					const expiresAt = tx.expiresAt ?? 0;
					if (live && deps.now() < expiresAt) return false;
					const early = !live && deps.now() < expiresAt - 2_000;
					return undo(journal, early ? "restart" : "disconnected");
				}
				if (tx.state === "rolling-back") return undo(journal, tx.undoReason);
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
				const sameBoot = tx.bootId === (await deps.bootId());
				if (
					tx.state === "pending" &&
					reason === "backend-start" &&
					sameBoot &&
					deps.now() < (tx.expiresAt ?? 0) &&
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
				const done = await undo(
					journal,
					tx.state === "rolling-back" ? tx.undoReason : "restart",
				);
				return done ? ("undone" as const) : ("incomplete" as const);
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
		) {
			return exclusive(async () => {
				const journal = await deps.journal.read();
				const notice = journal.notice;
				if (!session.authenticated || !notice || notice.id !== noticeId)
					throw new Error("Notice already answered");
				const result = await start(session, notice.plan, {
					answer,
					deliberate: true,
				});
				if (result.kind !== "ask-before") {
					const after = await deps.journal.read();
					if (after.notice?.id === noticeId) {
						after.notice = null;
						await save(after);
					}
				}
				return result;
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
