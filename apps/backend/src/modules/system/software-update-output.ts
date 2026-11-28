/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { type EffectOwner, ownedFiles } from "../../helpers/effect-owner.ts";

type OwnedFiles = ReturnType<typeof ownedFiles>;

const RUN_DIR = "/run/ceralive";
const MAX_READ_BYTES = 64 * 1024;

export type SoftwareUpdateOutputPaths = {
	readonly stdout: string;
	readonly stderr: string;
};

export type SoftwareUpdateOutputRead = {
	readonly bytes: Uint8Array;
	readonly nextOffset: number;
};

export class UnsafeSoftwareUpdateOutputPathError extends Error {
	constructor(
		readonly outputPath: string,
		reason: string,
	) {
		super(`unsafe software-update output path: ${reason}`);
		this.name = "UnsafeSoftwareUpdateOutputPathError";
	}
}

export function softwareUpdateOutputPaths(): SoftwareUpdateOutputPaths {
	return {
		stdout: path.join(RUN_DIR, "software-update.stdout"),
		stderr: path.join(RUN_DIR, "software-update.stderr"),
	};
}

async function secureOutputDirectory(
	files: OwnedFiles,
	directory: string,
	expectedUid: number,
): Promise<void> {
	await files.makeDirectory("spool:secure-directory", directory, 0o700);
	const stat = await files.inspect("spool:secure-directory", directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new UnsafeSoftwareUpdateOutputPathError(directory, "not a directory");
	}
	if (stat.uid !== expectedUid) {
		throw new UnsafeSoftwareUpdateOutputPathError(directory, "wrong owner");
	}
	if ((stat.mode & 0o022) !== 0) {
		throw new UnsafeSoftwareUpdateOutputPathError(
			directory,
			"writable by peers",
		);
	}
	await files.setMode("spool:secure-directory", directory, 0o700);
}

async function createOutputFile(
	files: OwnedFiles,
	filePath: string,
	expectedUid: number,
): Promise<void> {
	await files.removeFile("spool:remove-file", filePath);
	const handle = await files.createExclusive(
		"spool:create-file",
		"spool:set-mode",
		filePath,
		0o600,
	);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.uid !== expectedUid || stat.nlink !== 1) {
			throw new UnsafeSoftwareUpdateOutputPathError(
				filePath,
				"not a private regular file",
			);
		}
		await handle.chmod(0o600);
	} finally {
		await handle.close();
	}
}

/**
 * Makes the unit's two output files anew. `owner` is the install they are
 * made for: every step that removes, creates or changes a file asks first
 * whether that install still owns the updater (effect-owner.ts), so one that
 * ended touches no file a newer install's unit may already be writing to.
 */
export async function prepareSoftwareUpdateOutput(
	paths: SoftwareUpdateOutputPaths,
	expectedUid = 0,
	owner?: EffectOwner,
): Promise<void> {
	const files = ownedFiles(owner);
	const directories = new Set([
		path.dirname(paths.stdout),
		path.dirname(paths.stderr),
	]);
	if (directories.size !== 1) {
		throw new UnsafeSoftwareUpdateOutputPathError(
			paths.stdout,
			"stdout and stderr do not share a directory",
		);
	}
	const directory = directories.values().next().value;
	if (directory === undefined) {
		throw new UnsafeSoftwareUpdateOutputPathError(
			paths.stdout,
			"missing directory",
		);
	}
	await secureOutputDirectory(files, directory, expectedUid);
	await createOutputFile(files, paths.stdout, expectedUid);
	await createOutputFile(files, paths.stderr, expectedUid);
}

export async function readSoftwareUpdateOutput(
	filePath: string,
	offset: number,
): Promise<SoftwareUpdateOutputRead> {
	const paths = softwareUpdateOutputPaths();
	if (filePath !== paths.stdout && filePath !== paths.stderr) {
		throw new UnsafeSoftwareUpdateOutputPathError(
			filePath,
			"runtime paths are fixed",
		);
	}
	const handle = await fs.open(
		filePath,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = await handle.stat();
		if (
			!stat.isFile() ||
			stat.uid !== 0 ||
			stat.nlink !== 1 ||
			(stat.mode & 0o777) !== 0o600
		) {
			throw new UnsafeSoftwareUpdateOutputPathError(
				filePath,
				"not a private root-owned regular file",
			);
		}
		if (stat.size < offset) return { bytes: new Uint8Array(), nextOffset: 0 };
		if (stat.size === offset)
			return { bytes: new Uint8Array(), nextOffset: offset };

		const length = Math.min(stat.size - offset, MAX_READ_BYTES);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, offset);
		return {
			bytes: Uint8Array.from(buffer.subarray(0, bytesRead)),
			nextOffset: offset + bytesRead,
		};
	} finally {
		await handle.close();
	}
}
