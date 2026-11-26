/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A URL that carries a secret never goes on curl's command line: any local
 * process can read another's arguments. curl reads it from a config file only
 * this process's user can read, in a directory of its own, removed as soon as
 * curl has exited.
 */
export function curlUrlConfig(url: string): string {
	return `url = "${url.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`;
}

/** Runs curl's `argv` (without its URL) against `url`, given privately. */
export async function runCurlWithPrivateUrl<Result>(
	argv: readonly string[],
	url: string,
	run: (argv: string[]) => Promise<Result>,
): Promise<Result> {
	// mkdtemp makes the directory 0700; the file is created 0600 and must be new.
	const dir = await mkdtemp(join(tmpdir(), "ceraui-curl-"));
	try {
		const file = join(dir, "url");
		await writeFile(file, curlUrlConfig(url), { mode: 0o600, flag: "wx" });
		return await run([...argv, "-K", file]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
