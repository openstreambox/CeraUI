/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { writeFileAtomicSync } from "../../helpers/config-loader.ts";

/*
  THE WRITER SIDE OF ADR-003 — effectful half.

  ADR-003 §5.1 fixes five rules and every one of them is load-bearing:

    1. each file is written to a UNIQUE temp sibling (`<target>.<pid>.<n>.tmp`),
       fsync-ed, then `rename(2)`-d into place — so a reader never sees a torn
       write, and two writers cannot clobber one temp;
    2. `BIND_IPS_FILE` is published FIRST, because the sidecar names the digest
       of the exact bytes that rename committed;
    3. THE SIDECAR RENAME IS THE COMMIT POINT — the mapping does not exist until
       it lands;
    4. `SIGHUP` comes last, after both renames (the caller's job);
    5. at startup BOTH files are republished BEFORE the sender is spawned.

  The window between renames — new IP bytes against an old sidecar — is real,
  named, and absorbed by the reader's bounded retry. The guarantee runs one way
  only: a reader seeing the NEW sidecar is guaranteed the content it names is on
  disk. We do not claim the converse, and we do not pretend the window is absent.

  PERMISSIONS ARE PART OF THE CONTRACT. §5.3 makes the reader REFUSE a sidecar
  that is a symlink, is not a regular file, or is group- or world-writable — the
  mapping decides where device traffic egresses. So the sidecar is created 0600
  and its temp sibling is too, or the very first read answers `unreadable`.
*/

import { createHash } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { logger } from "../../helpers/logger.ts";

import {
	type BondEntry,
	buildBindMapDocument,
	isMappableEntry,
	renderIpsFile,
	sameMapping,
} from "./bind-map.ts";

/** Why a publication could not put a usable mapping on disk. */
export type BindMapPublishFailure =
	| "unmappable"
	| "ips_write_failed"
	| "sidecar_write_failed"
	/** The write did not settle before its deadline; the writer has moved on. */
	| "timed_out";

export type BindMapPublication =
	| {
			readonly ok: true;
			readonly generation: number;
			readonly ipsFileSha256?: string;
			readonly changed: boolean;
			readonly sidecarPath: string;
	  }
	| {
			readonly ok: false;
			readonly reason: BindMapPublishFailure;
			readonly changed: boolean;
	  };

/** Where a settled publication came from. */
export interface BindMapPublicationOrigin {
	/** True for a republication the writer started itself, with no caller
	 * waiting on it: after a timeout or after a late effect of an abandoned write.
	 * Nobody else will request the reload such a publication may owe. */
	readonly republished: boolean;
}

export interface BindMapWriterDeps {
	readonly ipsFile: string;
	readonly sidecarFile: string;
	readonly writeFile: (
		path: string,
		contents: string,
		target?: string,
	) => Promise<void>;
	readonly renameFile: (from: string, to: string) => Promise<void>;
	readonly removeFile: (path: string) => Promise<void>;
	/** How long one publication may take before it is abandoned. */
	readonly deadlineMs?: number;
	/** Pauses between the writer's own retries while the newest snapshot is not
	 * on disk; the last one repeats. Defaults to `BIND_MAP_RETRY_DELAYS_MS`. */
	readonly retryDelaysMs?: readonly number[];
	/**
	 * Runs inside the serialized writer, once per publication that ran or timed
	 * out, in execution order and before any caller sees its receipt. The
	 * entries are the snapshot that was submitted, never a superseded caller's
	 * rows; on a failure receipt they may not be on disk.
	 */
	readonly onSettled?: (
		entries: readonly BondEntry[],
		publication: BindMapPublication,
		origin: BindMapPublicationOrigin,
	) => void;
}

/**
 * One publication normally takes a few fsyncs. A write that has not settled
 * after this long is treated as stuck: stream start and every later
 * publication wait behind it otherwise.
 */
export const BIND_MAP_PUBLICATION_DEADLINE_MS = 10_000;

/**
 * While the newest snapshot is not on disk (a timeout, a failed write, or a
 * late effect of an abandoned write), the writer republishes it on this
 * schedule until one publication lands or a newer submission supersedes it.
 * The last pause repeats. The first republication after a timeout or a late
 * effect runs at once instead: a single stuck operation is the common case.
 */
export const BIND_MAP_RETRY_DELAYS_MS: readonly number[] = [
	2_000, 5_000, 15_000, 60_000,
];

/**
 * Abandoned attempts whose file operations have not settled yet. Up to this
 * many may still be outstanding while a new attempt starts, so one stuck
 * operation does not stall stream start; beyond it, new file I/O waits until
 * one settles instead of piling more blocked operations onto hung storage.
 */
const MAX_UNSETTLED_ABANDONED = 1;

/** Why the files on disk may not hold the newest snapshot. */
export type BindMapStaleReason =
	| BindMapPublishFailure
	| "late_effect"
	| "error";

/** Whether the files on disk hold the newest submitted snapshot. */
export interface BindMapPublicationHealth {
	/** True while the newest snapshot is not known to be on disk. */
	readonly stale: boolean;
	/** `Date.now()` when the current stale period began. */
	readonly staleSinceMs?: number;
	/** Failed or timed-out attempts in the current stale period. */
	readonly failures: number;
	readonly lastFailure?: BindMapStaleReason;
	/** A retry is waiting on its backoff timer. */
	readonly retryScheduled: boolean;
	/** Abandoned attempts whose file operations have not settled. */
	readonly abandonedUnsettled: number;
}

/**
 * Write + fsync + close. `Bun.write` is deliberately NOT used here: it does not
 * fsync, and an unsynced rename can leave an empty file behind a power cut on
 * the very device this exists for.
 */
async function writeFileSynced(
	path: string,
	contents: string,
	target?: string,
): Promise<void> {
	writeFileAtomicSync(path, contents, {
		mode: 0o600,
		permissionSource: target,
	});
}

export function defaultBindMapWriterDeps(
	ipsFile: string,
	sidecarFile: string,
): BindMapWriterDeps {
	return {
		ipsFile,
		sidecarFile,
		writeFile: writeFileSynced,
		renameFile: async (from, to) => {
			await rename(from, to);
			const directory = await open(dirname(to), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		},
		removeFile: (path) => unlink(path),
	};
}

/** Derive the sidecar path from the ips-file path when none is configured. */
export function defaultSidecarPath(ipsFile: string): string {
	return `${ipsFile}.bindmap.json`;
}

/**
 * Writer-session state. `generation` is monotonic per WRITER PROCESS lifetime
 * and restarts at 1 only with a new supervised sender lifetime. Changed mappings
 * advance it even when IP bytes are identical. A consecutive successful no-op
 * retains its identity: a fresh generation cannot be silently published without
 * reloading the sender. Failed/uncertain publications invalidate that no-op cache.
 *
 * Publications run one at a time. At most one more waits behind the one in
 * flight; a newer submission replaces the waiting snapshot (latest wins) and the
 * replaced callers resolve with the receipt of the publication that replaced
 * them. A flapping link therefore costs two publications, not one per event.
 * The writer's own retries use the same queue; they are never a second one.
 */
let generation = 0;
let tempCounter = 0;
/** Bumped by a reset; work from an older session never touches state again. */
let session = 0;
/** Bumped whenever reuse is invalidated; an attempt that started under an older
 * epoch may not re-establish reuse when it completes. */
let reuseEpoch = 0;
/** A timeout or late effect left the files in an unknown state: the next
 * publication that lands must report `changed`, whatever it replaces. */
let diskUncertain = false;
/** Bumped whenever the disk becomes uncertain. Only an attempt that started
 * after the latest bump can prove the disk holds what it wrote: a late rename
 * may have landed in the middle of an earlier one. */
let uncertainEpoch = 0;

function markDiskUncertain(): void {
	diskUncertain = true;
	uncertainEpoch += 1;
}
let lastPublished: readonly BondEntry[] | undefined;
let lastSuccessful:
	| {
			readonly entries: readonly BondEntry[];
			readonly generation: number;
			readonly digest: string;
			readonly ipsFile: string;
			readonly sidecarFile: string;
	  }
	| undefined;

interface Snapshot {
	readonly entries: readonly BondEntry[];
	readonly deps: BindMapWriterDeps;
}

type Waiter = ReturnType<typeof Promise.withResolvers<BindMapPublication>>;

interface Submission {
	snapshot: Snapshot;
	waiters: Waiter[];
	/** Answers the waiters while new file I/O is held back (see `blocked`). */
	waitTimer?: ReturnType<typeof setTimeout> | undefined;
}

interface Attempt {
	readonly session: number;
	readonly reuseEpoch: number;
	readonly uncertainEpoch: number;
	abandoned: boolean;
	/** An effect (rename/unlink) settled after abandonment: it may have landed. */
	lateEffect: boolean;
}

interface StaleState {
	readonly since: number;
	failures: number;
	reason: BindMapStaleReason;
	/** Backoff steps already taken in this stale period. */
	backoff: number;
	/** Immediate retry used since the last successful overlapped publication. */
	immediateUsed: boolean;
}

/** A live attempt is in flight. */
let running = false;
let abandonedUnsettled = 0;
let pending: Submission | undefined;
let newest: Snapshot | undefined;
let stale: StaleState | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let idleWaiters: (() => void)[] = [];

const snapshotMapping = (entries: readonly BondEntry[]) =>
	Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));

const deadlineOf = (deps: BindMapWriterDeps) =>
	deps.deadlineMs ?? BIND_MAP_PUBLICATION_DEADLINE_MS;

/** New file I/O waits while too many abandoned attempts are still outstanding. */
const blocked = () => abandonedUnsettled > MAX_UNSETTLED_ABANDONED;

function cancelRetry(): void {
	if (retryTimer !== undefined) clearTimeout(retryTimer);
	retryTimer = undefined;
}

/** Drop the writer session (test isolation). Never call from production code. */
export function resetBindMapWriter(): void {
	session += 1;
	generation = 0;
	tempCounter = 0;
	diskUncertain = false;
	uncertainEpoch = 0;
	lastPublished = undefined;
	lastSuccessful = undefined;
	running = false;
	abandonedUnsettled = 0;
	if (pending?.waitTimer !== undefined) clearTimeout(pending.waitTimer);
	pending = undefined;
	newest = undefined;
	stale = undefined;
	cancelRetry();
	const waiters = idleWaiters;
	idleWaiters = [];
	for (const resolve of waiters) resolve();
}

/** A failed delivery makes the last published identity uncertain. An attempt
 * already in flight cannot re-establish reuse when it completes. */
export function invalidateBindMapReuse(): void {
	reuseEpoch += 1;
	lastSuccessful = undefined;
}

/** The generation the last successful publication carried, or 0 if none. */
export function currentBindMapGeneration(): number {
	return generation;
}

/** Whether the files on disk hold the newest snapshot, and since when not. */
export function getBindMapPublicationHealth(): BindMapPublicationHealth {
	return stale === undefined
		? {
				stale: false,
				failures: 0,
				retryScheduled: false,
				abandonedUnsettled,
			}
		: {
				stale: true,
				staleSinceMs: stale.since,
				failures: stale.failures,
				lastFailure: stale.reason,
				retryScheduled: retryTimer !== undefined,
				abandonedUnsettled,
			};
}

/**
 * Resolves once no publication is in flight or waiting. A retry waiting on its
 * backoff timer, or an abandoned attempt's file operations, do not count.
 */
export function whenBindMapWriterIdle(): Promise<void> {
	if (!running && pending === undefined) return Promise.resolve();
	return new Promise((resolve) => idleWaiters.push(resolve));
}

function tempPath(target: string): string {
	tempCounter += 1;
	return `${target}.${process.pid}.${tempCounter}.tmp`;
}

const isLive = (attempt: Attempt) =>
	!attempt.abandoned && attempt.session === session;

class AbandonedPublication extends Error {}

/** Run an effect that may land on disk; note it when it settles after abandonment. */
async function effect(attempt: Attempt, run: () => Promise<void>) {
	try {
		await run();
	} finally {
		if (!isLive(attempt)) attempt.lateEffect = true;
	}
	if (!isLive(attempt)) throw new AbandonedPublication();
}

async function publishAtomically(
	deps: BindMapWriterDeps,
	attempt: Attempt,
	target: string,
	contents: string,
): Promise<void> {
	const temp = tempPath(target);
	await deps.writeFile(temp, contents, target);
	if (!isLive(attempt)) {
		// Woke after its deadline: the temp never reaches the target.
		await deps.removeFile(temp).catch(() => {
			// A temp left behind is harmless; nothing renames it.
		});
		throw new AbandonedPublication();
	}
	await effect(attempt, () => deps.renameFile(temp, target));
}

/**
 * Publish the IP list and its sidecar, in that order.
 *
 * `changed` answers "does the sender need a SIGHUP" and is true for a
 * MAPPING-ONLY change as well as an IP-list change — moving a link from one
 * interface to another leaves the IP bytes byte-identical, so a digest-only
 * comparison would silently skip the reload that is the entire point.
 *
 * A publication that has not settled by its deadline resolves as `timed_out`
 * with `changed: false` and is abandoned: it renames nothing more, and reuse is
 * cleared. Until the newest snapshot lands, the writer republishes it itself:
 * once at once, then on `BIND_MAP_RETRY_DELAYS_MS`, also after a failed write
 * and after a late effect of an abandoned write. Those republications owe the
 * reload (see `onSettled`); the first one that lands after an uncertain state
 * always reports `changed`. If a successful newest publication overlaps a
 * late effect, it earns one immediate repair without resetting the backoff.
 */
export function publishBondMapping(
	provided: readonly BondEntry[],
	deps: BindMapWriterDeps,
): Promise<BindMapPublication> {
	// Capture caller-owned rows at submission; compare writer state only at execution.
	const snapshot: Snapshot = { entries: snapshotMapping(provided), deps };
	const waiter = Promise.withResolvers<BindMapPublication>();
	newest = snapshot;
	// This submission is the retry now; a later failure schedules a fresh one.
	cancelRetry();
	submit(snapshot, waiter);
	return waiter.promise;
}

function submit(snapshot: Snapshot, waiter?: Waiter): void {
	if (pending !== undefined) {
		pending.snapshot = snapshot;
		if (waiter) pending.waiters.push(waiter);
		if (blocked()) armWait(pending);
		return;
	}
	const submission: Submission = { snapshot, waiters: waiter ? [waiter] : [] };
	if (running || blocked()) {
		pending = submission;
		if (blocked()) armWait(submission);
	} else start(submission);
}

/**
 * While new file I/O is held back, answer a waiting submission's callers with
 * `timed_out` after one deadline. The submission itself keeps its slot and is
 * written once storage settles, as a writer-started republication.
 */
function armWait(submission: Submission): void {
	if (submission.waitTimer !== undefined || submission.waiters.length === 0)
		return;
	const { deps } = submission.snapshot;
	submission.waitTimer = setTimeout(() => {
		submission.waitTimer = undefined;
		if (pending !== submission || submission.waiters.length === 0) return;
		const publication = timedOut();
		notifySettled(submission, publication);
		const waiters = submission.waiters;
		submission.waiters = [];
		for (const waiter of waiters) waiter.resolve(publication);
		invalidateBindMapReuse();
		noteFailure("timed_out");
	}, deadlineOf(deps));
}

type Outcome =
	| { readonly publication: BindMapPublication }
	| { readonly error: unknown };

const timedOut = (): BindMapPublication => ({
	ok: false,
	reason: "timed_out",
	changed: false,
});

function start(submission: Submission): void {
	running = true;
	cancelRetry();
	if (submission.waitTimer !== undefined) clearTimeout(submission.waitTimer);
	submission.waitTimer = undefined;
	const { entries, deps } = submission.snapshot;
	const attempt: Attempt = {
		session,
		reuseEpoch,
		uncertainEpoch,
		abandoned: false,
		lateEffect: false,
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<"timed_out">((resolve) => {
		timer = setTimeout(() => resolve("timed_out"), deadlineOf(deps));
	});
	const work = publishBondMappingSerial(entries, deps, attempt);
	const outcome: Promise<Outcome> = work.then(
		(publication) => ({ publication }),
		(error: unknown) => ({ error }),
	);
	void Promise.race([outcome, deadline]).then((result) => {
		clearTimeout(timer);
		if (attempt.session !== session) {
			finish(submission, result === "timed_out" ? undefined : result);
			return;
		}
		if (result === "timed_out") {
			attempt.abandoned = true;
			abandonedUnsettled += 1;
			markDiskUncertain();
			invalidateBindMapReuse();
			logger.error("bind-map: publication did not settle before its deadline", {
				deadlineMs: deadlineOf(deps),
			});
			const publication = timedOut();
			notifySettled(submission, publication);
			finish(submission, { publication });
			noteFailure("timed_out");
			void outcome.then(() => abandonedSettled(attempt));
		} else if ("publication" in result) {
			notifySettled(submission, result.publication);
			finish(submission, result);
			noteResult(submission.snapshot, result.publication, attempt);
		} else {
			finish(submission, result);
			noteFailure("error");
		}
		running = false;
		drain();
	});
}

/** An abandoned attempt's file operations settled: its I/O slot is free again. */
function abandonedSettled(attempt: Attempt): void {
	if (attempt.session !== session) return;
	abandonedUnsettled -= 1;
	if (attempt.lateEffect) {
		// The abandoned write landed something after all: whatever it renamed may
		// now sit on top of a newer publication. Publish the newest snapshot again.
		logger.warn("bind-map: an abandoned publication landed late");
		markDiskUncertain();
		invalidateBindMapReuse();
		// Keep the existing stale period and its retry budget. Repeated late
		// effects must not turn slow storage into an immediate rewrite loop.
		noteFailure("late_effect");
	}
	drain();
}

function noteResult(
	snapshot: Snapshot,
	publication: BindMapPublication,
	attempt: Attempt,
): void {
	if (!publication.ok && publication.reason !== "unmappable") {
		noteFailure(publication.reason);
		return;
	}
	if (stale === undefined || snapshot !== newest) return;
	if (attempt.uncertainEpoch !== uncertainEpoch) {
		// Storage completed a successful publication, but an abandoned effect
		// overlapped it. Repair at once without resetting the backoff: repeated
		// timeouts alone must never replenish the immediate retry budget.
		if (publication.ok) stale.immediateUsed = false;
		return;
	}
	logger.info("bind-map: the published mapping is current again", {
		failures: stale.failures,
		staleForMs: Date.now() - stale.since,
	});
	stale = undefined;
	cancelRetry();
}

/** The newest snapshot is not (or no longer known to be) on disk. */
function noteFailure(reason: BindMapStaleReason): void {
	if (stale === undefined) {
		logger.error(
			"bind-map: the files on disk are stale; republishing the newest mapping until it lands",
			{ reason },
		);
		stale = {
			since: Date.now(),
			failures: 1,
			reason,
			backoff: 0,
			immediateUsed: false,
		};
		return;
	}
	stale.failures += 1;
	stale.reason = reason;
	logger.warn("bind-map: the published mapping is still stale", {
		reason,
		failures: stale.failures,
		staleForMs: Date.now() - stale.since,
	});
}

function notifySettled(
	submission: Submission,
	publication: BindMapPublication,
): void {
	try {
		submission.snapshot.deps.onSettled?.(
			submission.snapshot.entries,
			publication,
			{ republished: submission.waiters.length === 0 },
		);
	} catch (error) {
		logger.error("bind-map: publication observer failed", { error });
	}
}

function finish(submission: Submission, result: Outcome | undefined): void {
	for (const waiter of submission.waiters) {
		if (result === undefined) {
			waiter.resolve(timedOut());
		} else if ("publication" in result) {
			waiter.resolve(result.publication);
		} else {
			waiter.reject(result.error);
		}
	}
}

function drain(): void {
	if (running) return;
	if (pending !== undefined) {
		if (blocked()) {
			// Written once an abandoned attempt settles; its callers hear back sooner.
			armWait(pending);
			return;
		}
		const next = pending;
		pending = undefined;
		start(next);
		return;
	}
	if (stale !== undefined && newest !== undefined) scheduleRetry();
	if (running || pending !== undefined) return;
	const waiters = idleWaiters;
	idleWaiters = [];
	for (const resolve of waiters) resolve();
}

/** Republish the newest snapshot: once at once after a timeout or late effect,
 * otherwise after the next backoff pause. One timer at most, never a loop. */
function scheduleRetry(): void {
	if (retryTimer !== undefined || stale === undefined || newest === undefined)
		return;
	const snapshot = newest;
	const immediate =
		!stale.immediateUsed &&
		(stale.reason === "timed_out" || stale.reason === "late_effect");
	if (immediate) {
		stale.immediateUsed = true;
		submit(snapshot);
		return;
	}
	const delays = snapshot.deps.retryDelaysMs ?? BIND_MAP_RETRY_DELAYS_MS;
	const delay = delays[Math.min(stale.backoff, delays.length - 1)] ?? 0;
	stale.backoff += 1;
	const owner = session;
	retryTimer = setTimeout(() => {
		retryTimer = undefined;
		if (owner !== session || stale === undefined || newest === undefined)
			return;
		if (running || pending !== undefined) return; // a newer run covers it
		logger.warn("bind-map: republishing the newest mapping", {
			failures: stale.failures,
			staleForMs: Date.now() - stale.since,
		});
		submit(newest);
	}, delay);
	retryTimer.unref?.();
}

async function publishBondMappingSerial(
	entries: readonly BondEntry[],
	deps: BindMapWriterDeps,
	attempt: Attempt,
): Promise<BindMapPublication> {
	const ipsContent = renderIpsFile(entries),
		digest = createHash("sha256").update(ipsContent, "utf8").digest("hex"),
		mappable = entries.every(isMappableEntry),
		identical =
			!!lastSuccessful &&
			lastSuccessful.generation === generation &&
			lastSuccessful.digest === digest &&
			lastSuccessful.ipsFile === deps.ipsFile &&
			lastSuccessful.sidecarFile === deps.sidecarFile &&
			sameMapping(lastSuccessful.entries, entries),
		changed =
			diskUncertain ||
			lastPublished === undefined ||
			!sameMapping(lastPublished, entries) ||
			(mappable && !identical);

	try {
		await publishAtomically(deps, attempt, deps.ipsFile, ipsContent);
	} catch (error) {
		if (!isLive(attempt)) throw error;
		lastSuccessful = undefined;
		logger.error("bind-map: failed to publish the IP list", { error });
		return { ok: false, reason: "ips_write_failed", changed: false };
	}

	// The IP list is what the legacy path runs on, so it is published even when
	// the mapping cannot be: an undescribable link still carries traffic, it just
	// cannot be told apart from a same-IP twin.
	if (!mappable) {
		lastPublished = entries;
		lastSuccessful = undefined;
		await retireSidecar(deps, attempt);
		if (attempt.uncertainEpoch === uncertainEpoch) diskUncertain = false;
		return { ok: false, reason: "unmappable", changed };
	}

	if (!identical) generation += 1;
	const publishedGeneration = generation;
	const document = buildBindMapDocument(entries, publishedGeneration, digest);

	try {
		await publishAtomically(
			deps,
			attempt,
			deps.sidecarFile,
			JSON.stringify(document),
		);
	} catch (error) {
		if (!isLive(attempt)) throw error;
		logger.error("bind-map: failed to publish the sidecar", { error });
		lastPublished = entries;
		lastSuccessful = undefined;
		// A sidecar that survives its own failed republication describes bytes that
		// are no longer on disk, which the reader can only report as a hash
		// mismatch. Retiring it makes the state honest: `missing_file`.
		await retireSidecar(deps, attempt);
		return { ok: false, reason: "sidecar_write_failed", changed };
	}

	lastPublished = entries;
	if (attempt.uncertainEpoch === uncertainEpoch) diskUncertain = false;
	lastSuccessful =
		attempt.reuseEpoch === reuseEpoch
			? {
					entries: lastPublished,
					generation: publishedGeneration,
					digest,
					ipsFile: deps.ipsFile,
					sidecarFile: deps.sidecarFile,
				}
			: undefined;
	return {
		ok: true,
		generation: publishedGeneration,
		ipsFileSha256: digest,
		changed,
		sidecarPath: deps.sidecarFile,
	};
}

async function retireSidecar(
	deps: BindMapWriterDeps,
	attempt: Attempt,
): Promise<void> {
	try {
		await effect(attempt, () => deps.removeFile(deps.sidecarFile));
	} catch (error) {
		if (error instanceof AbandonedPublication) throw error;
		// Absent is the state we wanted; anything else is already logged above.
	}
}
