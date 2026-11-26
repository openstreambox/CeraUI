/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type EffectOwner,
	isOwnerEnded,
	ownedFiles,
} from "../../helpers/effect-owner.ts";
import { logger } from "../../helpers/logger.ts";

const PRIVATE_DIRECTORY_PREFIX = "ceraui-curl-";
/** Logged whenever a private curl config could not be removed. */
export const PRIVATE_FILE_LEFT_BEHIND =
	"Security: a private curl config holding the image source's access token could not be removed";

// Older than any probe can run: a directory of that age nobody made in flight.
const ABANDONED_AFTER_MS = 10 * 60_000;

// The directories of runs in flight, and those whose removal failed.
const inUse = new Set<string>();
const leftBehind = new Set<string>();

/**
 * A URL that carries a secret never goes on curl's command line: any local
 * process can read another's arguments. curl reads it from a config file only
 * this process's user can read, in a directory of its own, removed as soon as
 * curl has exited.
 */
export function curlUrlConfig(url: string): string {
	return `url = "${url.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`;
}

type Files = ReturnType<typeof ownedFiles>;

/**
 * Removes one private directory. A failure is reported whoever the run was
 * for, an owner that has ended included: a file with the access token is
 * still on disk. Neither the token nor the directory's own name is logged,
 * and the run's result stands. The next install start tries again
 * ({@link sweepPrivateCurlFiles}).
 */
async function removePrivateDirectory(
	files: Files,
	directory: string,
): Promise<boolean> {
	try {
		await files.removeTree("private-file:remove", directory);
		leftBehind.delete(directory);
		return true;
	} catch (error) {
		leftBehind.add(directory);
		const code: unknown =
			error instanceof Error && "code" in error ? error.code : undefined;
		logger.error(PRIVATE_FILE_LEFT_BEHIND, {
			location: join(tmpdir(), `${PRIVATE_DIRECTORY_PREFIX}*`),
			left_behind: leftBehind.size,
			...(typeof code === "string" ? { code } : {}),
		});
		return false;
	}
}

/**
 * Runs curl's `argv` (without its URL) against `url`, given privately. For an
 * `owner` that has ended, no file is made; one already made is still removed.
 */
export async function runCurlWithPrivateUrl<Result>(
	argv: readonly string[],
	url: string,
	run: (argv: string[]) => Promise<Result>,
	owner?: EffectOwner,
): Promise<Result> {
	const files = ownedFiles(owner);
	// The directory is made 0700; the file is created 0600 and must be new.
	const dir = await files.makeTempDirectory(
		"private-file:create",
		join(tmpdir(), PRIVATE_DIRECTORY_PREFIX),
	);
	inUse.add(dir);
	try {
		const file = join(dir, "url");
		await files.writeNew(
			"private-file:create",
			file,
			curlUrlConfig(url),
			0o600,
		);
		return await run([...argv, "-K", file]);
	} finally {
		inUse.delete(dir);
		await removePrivateDirectory(files, dir);
	}
}

/**
 * Removes private curl configs that are still on disk although no run uses
 * them: one whose removal failed, or one a process that died left behind
 * (told by its age, so a probe another process has in flight is left alone).
 * An install starts with this. Whatever cannot be removed is reported as
 * above; a directory that cannot be listed is reported unless `owner` has
 * ended.
 */
export async function sweepPrivateCurlFiles(
	owner?: EffectOwner,
	now: () => number = Date.now,
): Promise<void> {
	const files = ownedFiles(owner);
	const root = tmpdir();
	const found = new Set(leftBehind);
	try {
		for (const name of await files.listDirectory("private-file:remove", root)) {
			const directory = join(root, name);
			if (
				!name.startsWith(PRIVATE_DIRECTORY_PREFIX) ||
				found.has(directory) ||
				inUse.has(directory)
			)
				continue;
			const seen = await files.inspect("private-file:remove", directory);
			if (now() - seen.mtimeMs >= ABANDONED_AFTER_MS) found.add(directory);
		}
	} catch (error) {
		if (!isOwnerEnded(error) && !owner?.ended())
			logger.warn("Private curl configs could not be looked for", {
				error: error instanceof Error ? error.name : String(error),
			});
	}
	for (const directory of found)
		if (!inUse.has(directory)) await removePrivateDirectory(files, directory);
}

/** Test seam: forget which directories are in use or were left behind. */
export function resetPrivateCurlFilesForTest(): void {
	inUse.clear();
	leftBehind.clear();
}
