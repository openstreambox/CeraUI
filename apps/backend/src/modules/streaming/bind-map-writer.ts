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
	readonly writeFile: (path: string, contents: string) => Promise<void>;
	readonly renameFile: (from: string, to: string) => Promise<void>;
	readonly removeFile: (path: string) => Promise<void>;
	/** How long one publication may take before it is abandoned. */
	readonly deadlineMs?: number;
	/**
	 * Runs inside the serialized writer, once per publication that actually ran,
	 * in execution order and before any caller sees its receipt. The entries are
	 * the snapshot that was written, never a superseded caller's rows.
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

const SIDECAR_MODE = 0o600;

/**
 * Write + fsync + close. `Bun.write` is deliberately NOT used here: it does not
 * fsync, and an unsynced rename can leave an empty file behind a power cut on
 * the very device this exists for.
 */
async function writeFileSynced(path: string, contents: string): Promise<void> {
	const handle = await open(path, "w", SIDECAR_MODE);
	try {
		await handle.writeFile(contents);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export function defaultBindMapWriterDeps(
	ipsFile: string,
	sidecarFile: string,
): BindMapWriterDeps {
	return {
		ipsFile,
		sidecarFile,
		writeFile: writeFileSynced,
		renameFile: rename,
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
 */
let generation = 0;
let tempCounter = 0;
/** Bumped by a reset; work from an older session never touches state again. */
let session = 0;
/** Bumped whenever reuse is invalidated; an attempt that started under an older
 * epoch may not re-establish reuse when it completes. */
let reuseEpoch = 0;
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

interface Submission {
	snapshot: Snapshot;
	readonly waiters: ReturnType<
		typeof Promise.withResolvers<BindMapPublication>
	>[];
}

interface Attempt {
	readonly session: number;
	readonly reuseEpoch: number;
	abandoned: boolean;
	/** An effect (rename/unlink) settled after abandonment: it may have landed. */
	lateEffect: boolean;
}

let running = false;
let pending: Submission | undefined;
let newest: Snapshot | undefined;
let idleWaiters: (() => void)[] = [];

const snapshotMapping = (entries: readonly BondEntry[]) =>
	Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));

/** Drop the writer session (test isolation). Never call from production code. */
export function resetBindMapWriter(): void {
	session += 1;
	generation = 0;
	tempCounter = 0;
	lastPublished = undefined;
	lastSuccessful = undefined;
	running = false;
	pending = undefined;
	newest = undefined;
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

/** Resolves once no publication is in flight or waiting. */
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
	await deps.writeFile(temp, contents);
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
 * cleared. Unless a newer submission is already waiting, the newest snapshot is
 * republished at once; that republication owes the reload (see `onSettled`).
 * An abandoned rename that still lands later triggers one more republication.
 */
export function publishBondMapping(
	provided: readonly BondEntry[],
	deps: BindMapWriterDeps,
): Promise<BindMapPublication> {
	// Capture caller-owned rows at submission; compare writer state only at execution.
	const snapshot: Snapshot = { entries: snapshotMapping(provided), deps };
	const waiter = Promise.withResolvers<BindMapPublication>();
	newest = snapshot;
	submit(snapshot, waiter);
	return waiter.promise;
}

function submit(
	snapshot: Snapshot,
	waiter?: ReturnType<typeof Promise.withResolvers<BindMapPublication>>,
): void {
	if (pending !== undefined) {
		pending.snapshot = snapshot;
		if (waiter) pending.waiters.push(waiter);
		return;
	}
	const submission: Submission = { snapshot, waiters: waiter ? [waiter] : [] };
	if (running) pending = submission;
	else start(submission);
}

function republishNewest(): void {
	if (newest !== undefined) submit(newest);
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
	const { entries, deps } = submission.snapshot;
	const attempt: Attempt = {
		session,
		reuseEpoch,
		abandoned: false,
		lateEffect: false,
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<"timed_out">((resolve) => {
		timer = setTimeout(
			() => resolve("timed_out"),
			deps.deadlineMs ?? BIND_MAP_PUBLICATION_DEADLINE_MS,
		);
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
			invalidateBindMapReuse();
			logger.error("bind-map: publication did not settle before its deadline", {
				deadlineMs: deps.deadlineMs ?? BIND_MAP_PUBLICATION_DEADLINE_MS,
			});
			const publication = timedOut();
			notifySettled(submission, publication);
			finish(submission, { publication });
			// One republication per caller-visible timeout; a republication that
			// itself times out leaves the next real publication to try again.
			if (pending === undefined && submission.waiters.length > 0) {
				republishNewest();
			}
			// If the abandoned write still lands something, publish the newest
			// snapshot again so the late effect is never the last one on disk.
			void outcome.then(() => {
				if (attempt.lateEffect && attempt.session === session) {
					logger.warn("bind-map: an abandoned publication landed late");
					invalidateBindMapReuse();
					republishNewest();
				}
			});
		} else {
			if ("publication" in result)
				notifySettled(submission, result.publication);
			finish(submission, result);
		}
		drain();
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
	running = false;
	const next = pending;
	pending = undefined;
	if (next !== undefined) {
		start(next);
		return;
	}
	const waiters = idleWaiters;
	idleWaiters = [];
	for (const resolve of waiters) resolve();
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
			lastPublished === undefined ||
			!sameMapping(lastPublished, entries) ||
			(mappable && !identical);

	try {
		await publishAtomically(deps, attempt, deps.ipsFile, ipsContent);
	} catch (error) {
		if (!isLive(attempt)) throw error;
		lastSuccessful = undefined;
		logger.error("bind-map: failed to publish the IP list", { error });
		return { ok: false, reason: "ips_write_failed", changed };
	}

	// The IP list is what the legacy path runs on, so it is published even when
	// the mapping cannot be: an undescribable link still carries traffic, it just
	// cannot be told apart from a same-IP twin.
	if (!mappable) {
		lastPublished = entries;
		lastSuccessful = undefined;
		await retireSidecar(deps, attempt);
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
