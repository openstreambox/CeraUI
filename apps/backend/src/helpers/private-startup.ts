import fs from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "./logger.ts";

export const PRIVATE_STATE_FILES = [
	"config.json",
	"relays_cache.json",
	"hotspot_credentials.json",
	"auth_tokens.json",
	"stream.armed.json",
	"config.inflight.json",
	"bluetooth.json",
	"modem-credentials.json",
] as const;

/** Upgrade known private regular files once at boot without following links. */
export function tightenPrivateFiles(
	directory: string,
	additional: readonly string[] = [],
): void {
	let changed = 0;
	let failed = 0;
	for (const file of new Set([
		...PRIVATE_STATE_FILES.map((name) => join(directory, name)),
		...additional,
	])) {
		let fd: number | undefined;
		try {
			if (!fs.lstatSync(dirname(file)).isDirectory()) continue;
			const previous = fs.lstatSync(file);
			if (!previous.isFile() || (previous.mode & 0o177) === 0) continue;
			fd = fs.openSync(
				file,
				fs.constants.O_RDONLY |
					fs.constants.O_NOFOLLOW |
					fs.constants.O_NONBLOCK,
			);
			const current = fs.fstatSync(fd);
			if (
				!current.isFile() ||
				current.dev !== previous.dev ||
				current.ino !== previous.ino
			)
				continue;
			fs.fchmodSync(fd, current.mode & 0o600);
			changed++;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed++;
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}
	if (changed > 0)
		logger.info(`Tightened permissions on ${changed} private state files`);
	if (failed > 0)
		logger.warn(
			`Could not tighten permissions on ${failed} private state files`,
		);
}
