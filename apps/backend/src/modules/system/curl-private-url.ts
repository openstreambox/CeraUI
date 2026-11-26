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
import { type EffectOwner, ownedFiles } from "../../helpers/effect-owner.ts";

/**
 * A URL that carries a secret never goes on curl's command line: any local
 * process can read another's arguments. curl reads it from a config file only
 * this process's user can read, in a directory of its own, removed as soon as
 * curl has exited.
 */
export function curlUrlConfig(url: string): string {
	return `url = "${url.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`;
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
		join(tmpdir(), "ceraui-curl-"),
	);
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
		await files.removeTree("private-file:remove", dir);
	}
}
