/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import { randomUUID } from "node:crypto";
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

/** Test seam: where the private curl configs go (null restores it). */
export function setPrivateCurlDirectoryForTest(path: string | null): void {
	directory = path ?? PRIVATE_CURL_DIRECTORY;
}

/** Logged whenever a private curl config could not be removed. */
export const PRIVATE_FILE_LEFT_BEHIND =
	"Security: a private curl config holding the image source's access token could not be removed";

// Reported whoever the run was for, an owner that has ended included: a file
// with the access token is still on disk. Neither the token nor the file's
// name is logged.
function reportLeftBehind(error: unknown): void {
	const code: unknown =
		error instanceof Error && "code" in error ? error.code : undefined;
	logger.error(PRIVATE_FILE_LEFT_BEHIND, {
		directory,
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
	await files.makeDirectory("private-file:create", directory, 0o700);
	const file = join(directory, `${randomUUID()}.conf`);
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
				reportLeftBehind(error);
			}
	}
}

/**
 * Backend start, before anything can probe: whatever an earlier process left
 * in that one directory is removed with it. No other time and no other place.
 */
export async function wipePrivateCurlConfigs(): Promise<void> {
	try {
		await ownedFiles(undefined).removeTree("private-file:remove", directory);
	} catch (error) {
		reportLeftBehind(error);
	}
}
