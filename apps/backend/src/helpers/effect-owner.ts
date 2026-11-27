/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Effects that are done for someone, and stop when that someone has ended.
 *
 * Some work belongs to an owner that can end before the work has unwound: a
 * package install that a stream cancelled still has commands in flight and
 * code behind them. Whatever that code does next, it must not start anything
 * new for the owner. This module is where that is enforced, in two places
 * that everything passes:
 *
 * - **Commands.** Both spawn primitives (`run()` and `spawnWithTimeout()`)
 *   take an `owner` next to their `signal` and ask {@link assertOwnerMayRun}
 *   before they spawn. A command for an ended owner is refused, never
 *   started. Nothing in flight is killed: it finishes, and its result goes
 *   nowhere.
 * - **Owned writes.** Files and published state written for an owner go
 *   through {@link ownedFiles} and {@link ownedWrite}, which ask
 *   {@link assertOwnerMayWrite} first.
 *
 * A look that is neither (a capability file, a `stat`) asks
 * {@link assertOwnerMayRead}, so an ended owner stops reading too.
 *
 * What an ended owner may still do is take down what it had set up, and only
 * that: {@link OWNER_TEARDOWN} is the whole list.
 *
 * A refusal is an {@link OwnerEndedError}. Code that catches errors to log
 * them or to turn them into a result lets this one pass (`isOwnerEnded`), so
 * an ended owner stays silent.
 *
 * It imports nothing of this project on purpose: the spawn primitives depend
 * on it.
 */

import { constants } from "node:fs";
import fs from "node:fs/promises";

/** Whom an effect is done for. Absent: nobody in particular, never refused. */
export type EffectOwner = {
	/**
	 * True once the owner may not act any more. Asked right before each effect
	 * done for it, so an owner can also decide here that it has just ended.
	 */
	readonly ended: () => boolean;
};

/** The effect was not done: its owner has ended. Nothing was started. */
export class OwnerEndedError extends Error {
	constructor(effect = "an effect") {
		super(`not done for an owner that has ended: ${effect}`);
		this.name = "OwnerEndedError";
	}
}

export function isOwnerEnded(error: unknown): error is OwnerEndedError {
	return error instanceof OwnerEndedError;
}

/** Writes done for an owner, by what they are. */
export type OwnedWrite =
	// The detached install unit's output files.
	| "spool:secure-directory"
	| "spool:remove-file"
	| "spool:create-file"
	| "spool:set-mode"
	// A private file for one command (a curl config, a fetched index).
	| "private-file:create"
	| "private-file:remove"
	// The journal of routing rules a pinned apt run installs.
	| "routing-journal:record"
	| "routing-journal:retire"
	// What the device publishes about its last probes.
	| "transport-selection:publish"
	| "reachability-cache:store";

/**
 * Everything an ended owner may still do: take down what it set up itself.
 *
 * - Commands: delete the routing rule and the routes of the update tables
 *   (100000 for apt, 100001 for system images, priority 120) that a pinned
 *   run installed. Nothing else is spawned for an ended owner, reads included.
 * - Writes: strike those rules from the routing journal, and remove a private
 *   file made for one command.
 */
export const OWNER_TEARDOWN = {
	commands: [
		/^ip( -6)? rule del priority 120 uidrange (\d+)-\2 (prohibit|lookup 10000[01])$/,
		/^ip( -6)? route del .+ table 10000[01]( .+)?$/,
		/^ip( -6)? route flush table 10000[01]$/,
	],
	writes: ["routing-journal:retire", "private-file:remove"],
} as const satisfies {
	commands: readonly RegExp[];
	writes: readonly OwnedWrite[];
};

export function isOwnerTeardownCommand(argv: readonly string[]): boolean {
	const line = argv.join(" ");
	return OWNER_TEARDOWN.commands.some((pattern) => pattern.test(line));
}

export function isOwnerTeardownWrite(kind: OwnedWrite): boolean {
	return (OWNER_TEARDOWN.writes as readonly OwnedWrite[]).includes(kind);
}

/** The one question before a command: may it be started for this owner? */
export function assertOwnerMayRun(
	owner: EffectOwner | undefined,
	argv: readonly string[],
): void {
	if (owner === undefined || isOwnerTeardownCommand(argv)) return;
	if (owner.ended()) throw new OwnerEndedError(argv[0] ?? "a command");
}

/** The one question before an owned write. */
export function assertOwnerMayWrite(
	owner: EffectOwner | undefined,
	kind: OwnedWrite,
): void {
	if (owner === undefined || isOwnerTeardownWrite(kind)) return;
	if (owner.ended()) throw new OwnerEndedError(kind);
}

/**
 * The one question before a look done for an owner that is neither a command
 * nor a file of its own (a capability file, a `stat`, a journal): an ended
 * owner does not go on reading either.
 */
export function assertOwnerMayRead(
	owner: EffectOwner | undefined,
	what: string,
): void {
	if (owner?.ended()) throw new OwnerEndedError(what);
}

/**
 * Branches started side by side for an owner, joined like `Promise.all`, but
 * for this: a branch that fails does not end the wait while others are still
 * running. A refusal travels on only once everything that was started has
 * returned, so whoever keeps the owner's place until its work is over keeps
 * it long enough. Without an owner it is `Promise.all`.
 */
export async function ownedAll<const Branches extends readonly unknown[]>(
	owner: EffectOwner | undefined,
	branches: Branches,
): Promise<{ -readonly [Index in keyof Branches]: Awaited<Branches[Index]> }> {
	type Joined = {
		-readonly [Index in keyof Branches]: Awaited<Branches[Index]>;
	};
	if (owner === undefined) return (await Promise.all(branches)) as Joined;
	const settled = await Promise.allSettled(branches);
	for (const branch of settled)
		if (branch.status === "rejected") throw branch.reason;
	return settled.map(
		(branch) => (branch as PromiseFulfilledResult<unknown>).value,
	) as Joined;
}

let writeObserver: ((kind: OwnedWrite) => void) | undefined;

/** Test seam: told of every owned write that is about to happen. */
export function setOwnedWriteObserverForTest(
	observer: ((kind: OwnedWrite) => void) | null,
): void {
	writeObserver = observer ?? undefined;
}

/** A state write done for `owner`: refused once the owner has ended. */
export function ownedWrite<Result>(
	owner: EffectOwner | undefined,
	kind: OwnedWrite,
	write: () => Result,
): Result {
	assertOwnerMayWrite(owner, kind);
	writeObserver?.(kind);
	return write();
}

/** What a newly created private file can be asked and told. */
export type OwnedFileHandle = {
	readonly stat: () => Promise<{
		isFile(): boolean;
		readonly uid: number;
		readonly nlink: number;
	}>;
	readonly chmod: (mode: number) => Promise<void>;
	readonly close: () => Promise<void>;
};

/** The file operations owned writes are made of. */
export type OwnedFileBackend = {
	readonly makeDirectory: (path: string, mode: number) => Promise<void>;
	readonly inspect: (path: string) => Promise<{
		isDirectory(): boolean;
		isSymbolicLink(): boolean;
		readonly uid: number;
		readonly mode: number;
	}>;
	readonly setMode: (path: string, mode: number) => Promise<void>;
	/** Removes one file, if it is there. */
	readonly removeFile: (path: string) => Promise<void>;
	/** Removes a directory this code made, with what is in it. */
	readonly removeTree: (path: string) => Promise<void>;
	/** Creates `path` anew, never through a link, open for writing. */
	readonly createExclusive: (
		path: string,
		mode: number,
	) => Promise<OwnedFileHandle>;
	readonly makeTempDirectory: (prefix: string) => Promise<string>;
	/** Writes a file that must not exist yet. */
	readonly writeNew: (
		path: string,
		data: string,
		mode: number,
	) => Promise<void>;
};

const nodeFiles: OwnedFileBackend = {
	makeDirectory: async (path, mode) => {
		await fs.mkdir(path, { recursive: true, mode });
	},
	inspect: (path) => fs.lstat(path),
	setMode: (path, mode) => fs.chmod(path, mode),
	removeFile: (path) => fs.rm(path, { force: true }),
	removeTree: (path) => fs.rm(path, { recursive: true, force: true }),
	createExclusive: async (path, mode) => {
		const handle = await fs.open(
			path,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			mode,
		);
		return {
			stat: () => handle.stat(),
			chmod: (next) => handle.chmod(next),
			close: () => handle.close(),
		};
	},
	makeTempDirectory: (prefix) => fs.mkdtemp(prefix),
	writeNew: (path, data, mode) =>
		fs.writeFile(path, data, { mode, flag: "wx" }),
};

let files = nodeFiles;

/** Test seam: the file operations underneath every owned file write. */
export function setOwnedFileBackendForTest(
	backend: OwnedFileBackend | null,
): void {
	files = backend ?? nodeFiles;
}

/**
 * File work done for `owner`. Each step asks first, a look at the file
 * included. Closing a handle that is open is not a step: it always happens.
 */
export function ownedFiles(owner: EffectOwner | undefined) {
	const may = (kind: OwnedWrite) => {
		assertOwnerMayWrite(owner, kind);
		writeObserver?.(kind);
	};
	return {
		makeDirectory(kind: OwnedWrite, path: string, mode: number) {
			may(kind);
			return files.makeDirectory(path, mode);
		},
		/** A look at what `kind` is about to change: asked like the change. */
		inspect(kind: OwnedWrite, path: string) {
			may(kind);
			return files.inspect(path);
		},
		setMode(kind: OwnedWrite, path: string, mode: number) {
			may(kind);
			return files.setMode(path, mode);
		},
		removeFile(kind: OwnedWrite, path: string) {
			may(kind);
			return files.removeFile(path);
		},
		removeTree(kind: OwnedWrite, path: string) {
			may(kind);
			return files.removeTree(path);
		},
		async createExclusive(
			kind: OwnedWrite,
			modeKind: OwnedWrite,
			path: string,
			mode: number,
		): Promise<OwnedFileHandle> {
			may(kind);
			const handle = await files.createExclusive(path, mode);
			return {
				stat() {
					may(kind);
					return handle.stat();
				},
				chmod(next) {
					may(modeKind);
					return handle.chmod(next);
				},
				close: handle.close,
			};
		},
		makeTempDirectory(kind: OwnedWrite, prefix: string) {
			may(kind);
			return files.makeTempDirectory(prefix);
		},
		writeNew(kind: OwnedWrite, path: string, data: string, mode: number) {
			may(kind);
			return files.writeNew(path, data, mode);
		},
	};
}

/** What a spawn answers, as both primitives collect it. */
export type SpawnOverrideResult = {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
};

type SpawnOverride = (argv: readonly string[]) => Promise<SpawnOverrideResult>;

let spawnOverride: SpawnOverride | undefined;

/**
 * Test seam: answers every spawn of both primitives instead of the system.
 * It sits below the owner check, so a command refused for an ended owner
 * never reaches it.
 */
export function setSpawnOverrideForTest(override: SpawnOverride | null): void {
	spawnOverride = override ?? undefined;
}

export function activeSpawnOverride(): SpawnOverride | undefined {
	return spawnOverride;
}
