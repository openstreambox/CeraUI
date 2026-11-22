/**
 * Password hash storage
 * Separate module to avoid circular dependencies
 */

import { logger } from "../../helpers/logger.ts";

let passwordHash: string | undefined;

export function setPasswordHash(newHash: string | undefined) {
	logger.debug(
		`setPasswordHash called: ${newHash ? "hash provided" : "no hash"}`,
	);
	passwordHash = newHash;
}

export function getPasswordHash(): string | undefined {
	return passwordHash;
}

/** Explicit operator opt-in. A missing claim digest never enables legacy setup. */
export function localClaimEnabled(): boolean {
	return process.env.CERALIVE_LOCAL_CLAIM === "1";
}
