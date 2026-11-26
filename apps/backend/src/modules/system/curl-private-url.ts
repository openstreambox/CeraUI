/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EffectOwner, ownedFiles } from "../../helpers/effect-owner.ts";
import { logger } from "../../helpers/logger.ts";

/**
 * The one directory private curl configs are written to: inside the service's
 * own runtime directory (root, 0700), made by this process, never a shared
 * temp directory. Nothing else is put there and nothing outside it is touched.
 */
export const PRIVATE_CURL_DIRECTORY = "/run/ceralive/curl-private";
let directory = PRIVATE_CURL_DIRECTORY;
// Whether this process is the sole backend: it holds the single-instance
// lock lease (told at boot, by `wipePrivateCurlConfigs`). Only the sole
// backend writes into the service's directory, which its start wipes.
let soleBackend = false;
// Any other instance (source development, a boot without the lock) keeps its
// configs in a directory of its own, made once for this process, where no
// service start can remove one that is in flight.
let ownDirectory: Promise<string> | undefined;

/**
 * Test seam: `path` is the service's directory and this process its sole
 * backend; null restores a process that holds no lease.
 */
export function setPrivateCurlDirectoryForTest(path: string | null): void {
	directory = path ?? PRIVATE_CURL_DIRECTORY;
	soleBackend = path !== null;
	ownDirectory = undefined;
}

type Files = ReturnType<typeof ownedFiles>;

// The directory this process's configs go to, made sure of: 0700 either way.
async function privateDirectory(files: Files): Promise<string> {
	if (soleBackend) {
		await files.makeDirectory("private-file:create", directory, 0o700);
		return directory;
	}
	if (ownDirectory === undefined) {
		const made = files
			.makeTempDirectory(
				"private-file:create",
				join(tmpdir(), `ceraui-curl-${process.pid}-`),
			)
			.catch((error: unknown) => {
				if (ownDirectory === made) ownDirectory = undefined;
				throw error;
			});
		ownDirectory = made;
	}
	return ownDirectory;
}

/** Logged whenever a private curl config could not be removed. */
export const PRIVATE_FILE_LEFT_BEHIND =
	"Security: a private curl config holding the image source's access token could not be removed";

// Reported whoever the run was for, an owner that has ended included: a file
// with the access token is still on disk. Neither the token nor the file's
// name is logged.
function reportLeftBehind(error: unknown, where: string): void {
	const code: unknown =
		error instanceof Error && "code" in error ? error.code : undefined;
	logger.error(PRIVATE_FILE_LEFT_BEHIND, {
		directory: where,
		...(typeof code === "string" ? { code } : {}),
	});
}

/**
 * A URL that carries a secret never goes on curl's command line: any local
 * process can read another's arguments. curl reads it from a config file only
 * this process's user can read, in the service's own directory, removed by its
 * exact path as soon as curl has exited.
 */
export function curlUrlConfig(url: string): string {
	return `url = "${url.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`;
}

/**
 * Runs curl's `argv` (without its URL) against `url`, given privately. For an
 * `owner` that has ended, no file is made; one already made is still removed.
 * A removal that fails is reported and the run's result stands; the file goes
 * when the backend next starts ({@link wipePrivateCurlConfigs}).
 */
export async function runCurlWithPrivateUrl<Result>(
	argv: readonly string[],
	url: string,
	run: (argv: string[]) => Promise<Result>,
	owner?: EffectOwner,
): Promise<Result> {
	const files = ownedFiles(owner);
	// The directory is 0700; the file is created 0600 and must be new.
	const where = await privateDirectory(files);
	const file = join(where, `${randomUUID()}.conf`);
	let made = false;
	try {
		// Refused for an ended owner before anything is written.
		const writing = files.writeNew(
			"private-file:create",
			file,
			curlUrlConfig(url),
			0o600,
		);
		made = true;
		await writing;
		return await run([...argv, "-K", file]);
	} finally {
		if (made)
			try {
				await files.removeFile("private-file:remove", file);
			} catch (error) {
				reportLeftBehind(error, where);
			}
	}
}

/**
 * Backend start, before anything can probe. `holdsLease`: this process holds
 * the backend's single-instance lock lease, so it is the sole backend. Then
 * nothing is in flight: whatever an earlier process left in the service's one
 * directory is removed with it, and this process's own configs go there. No
 * other time and no other place. Without the lease nothing is removed, and
 * this process keeps its configs in a directory of its own.
 */
export async function wipePrivateCurlConfigs(
	holdsLease: boolean,
): Promise<void> {
	soleBackend = holdsLease;
	if (!holdsLease) return;
	try {
		await ownedFiles(undefined).removeTree("private-file:remove", directory);
	} catch (error) {
		reportLeftBehind(error, directory);
	}
}
