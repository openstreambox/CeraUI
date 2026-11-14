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

/**
 * The device-local key behind every mode-choice tag.
 *
 * Generated once per device (32 random bytes), stored 0600 in the 0700
 * mode-choice directory, never sent on the wire, never logged and never part of
 * an export. A tag made with it (a modem's identity, later a radio-condition
 * bucket) means nothing on another device, so two devices' records cannot be
 * linked by their tags.
 *
 * Fail closed: a key file with the wrong size, owner permissions or type is NOT
 * replaced — replacing it would silently orphan every saved choice. The caller
 * gets `undefined` and saves nothing; deleting the file resets the store.
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

import { logger } from "../../helpers/logger.ts";

export const MODE_CHOICE_DEFAULT_DIR = "/data/ceralive/mode-choice";
export const MODE_CHOICE_KEY_FILE = "local-key";
const KEY_BYTES = 32;

export function modeChoiceDir(): string {
	return process.env.CERALIVE_MODE_CHOICE_DIR ?? MODE_CHOICE_DEFAULT_DIR;
}

/** Create the private directory, or prove an existing one is private. */
export function ensurePrivateModeChoiceDir(dir = modeChoiceDir()): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = lstatSync(dir);
	if (
		!stat.isDirectory() ||
		stat.uid !== process.getuid?.() ||
		(stat.mode & 0o077) !== 0
	) {
		throw new Error("mode-choice directory is not private");
	}
}

let cached: { dir: string; key: Uint8Array } | undefined;
let warnedFor: string | undefined;

function readKey(file: string): Uint8Array | undefined {
	let fd: number;
	try {
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o077) !== 0 ||
			stat.size !== KEY_BYTES
		) {
			throw new Error("mode-choice key file is not a private 32-byte file");
		}
		const key = new Uint8Array(KEY_BYTES);
		if (readSync(fd, key, 0, KEY_BYTES, 0) !== KEY_BYTES) {
			throw new Error("mode-choice key file is short");
		}
		return key;
	} finally {
		closeSync(fd);
	}
}

let keyWriter = (fd: number, key: Uint8Array): number => writeSync(fd, key);

/** Tests only: inject a short or failed write before publication. */
export function setModeChoiceKeyWriter(writer?: typeof keyWriter): void {
	keyWriter = writer ?? ((fd, key) => writeSync(fd, key));
}

function createKey(dir: string, file: string): Uint8Array {
	const key = new Uint8Array(randomBytes(KEY_BYTES));
	const temp = join(
		dir,
		`local-key.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
	);
	const fd = openSync(
		temp,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
		0o600,
	);
	try {
		if (keyWriter(fd, key) !== KEY_BYTES) {
			throw new Error("mode-choice key write was short");
		}
		fsyncSync(fd);
		linkSync(temp, file);
	} finally {
		closeSync(fd);
		unlinkSync(temp);
	}
	const parent = openSync(dir, "r");
	try {
		fsyncSync(parent);
	} finally {
		closeSync(parent);
	}
	return key;
}

/**
 * The key, creating it on first use when `create` is set. `undefined` when it
 * does not exist (and `create` is false) or cannot be used.
 */
export function loadModeChoiceKey(
	options: { create?: boolean } = {},
): Uint8Array | undefined {
	const dir = modeChoiceDir();
	if (cached?.dir === dir) return cached.key;
	const file = join(dir, MODE_CHOICE_KEY_FILE);
	try {
		if (options.create === true) ensurePrivateModeChoiceDir(dir);
		let key = readKey(file);
		if (key === undefined && options.create === true) {
			try {
				key = createKey(dir, file);
			} catch (error) {
				// Another caller created it between the read and the exclusive open.
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				key = readKey(file);
			}
		}
		if (key === undefined) return undefined;
		cached = { dir, key };
		return key;
	} catch {
		// The message never carries the path or the key, only the fact, and only
		// once per directory so a read-only data partition does not flood the log.
		if (warnedFor !== dir) {
			warnedFor = dir;
			logger.warn("Mode-choice key unavailable; mode choices are not saved", {
				module: "modems",
			});
		}
		return undefined;
	}
}

/** Tests only: forget the in-memory copy. */
export function resetModeChoiceKeyCache(): void {
	cached = undefined;
	warnedFor = undefined;
}
