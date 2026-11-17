/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * The OTA-activation streaming sentinel (Todo 37) — `/run/ceralive/streaming`.
 *
 * This is the EXACT SAME flag path the image-side
 * `mkosi/runtime/ceralive-rauc-activate.sh` already checks (Todo 28,
 * image-building-pipeline): `STREAMING="${CERALIVE_STREAMING_MARKER:-/run/ceralive/streaming}"`.
 * Both that script's `--arm`/`--now`/shutdown-hook activation paths and
 * `--stop` all check `[[ -e "$STREAMING" ]]` and defer/refuse RAUC slot
 * activation while it exists. The name and default path must never drift
 * from that script's default — the env override below exists only for
 * symmetry with the shell script's own `CERALIVE_STREAMING_MARKER` override
 * (test/dev use), not because CeraUI ever needs a different production path.
 *
 * Existence-only sentinel for the image: that script never reads the CONTENT.
 * CeraUI alone writes one line into a marker that only its carrying owner
 * explains, so a restarted backend can tell that file from a stream's marker.
 */

import fs from "node:fs";
import { logger } from "../../helpers/logger.ts";
import { setShutdownProtection } from "../system/shutdown-protection.ts";

export function otaStreamingMarkerPath(): string {
	return process.env.CERALIVE_STREAMING_MARKER ?? "/run/ceralive/streaming";
}

/** Only ENOENT proves an empty boot baseline; unreadable evidence stays protected. */
export function initialOtaStreamLiveness(): "idle" | "unknown" {
	try {
		fs.lstatSync(otaStreamingMarkerPath());
		return "unknown";
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ENOENT"
			? "idle"
			: "unknown";
	}
}

/** Written only into a marker that carrying alone explains. */
const CARRYING_ONLY = "carrying\n";

/** Anything but the exact line (empty, unreadable, absent) is not a claim. */
function markerSaysCarryingOnly(): boolean {
	try {
		return fs.readFileSync(otaStreamingMarkerPath(), "utf8") === CARRYING_ONLY;
	} catch {
		return false;
	}
}

let carryingProtected = false;
// True only while the carrying owner alone explains the marker: carrying
// created it from absence, the encoder confirmed idle while carrying kept it,
// or an earlier backend process left it saying so. `/run` outlives a backend
// restart, and every start takes the carrying hold again, so the earlier
// process's hold is not a stream. Anything else (written for the encoder,
// empty, unexplained) stays evidence of a possible stream.
let carryingOnlyMarker = markerSaysCarryingOnly();
let encoderProtected =
	!carryingOnlyMarker && initialOtaStreamLiveness() !== "idle";
setShutdownProtection("encoder", encoderProtected);

/**
 * The stream session's view of the sentinel. Both owners share one file for
 * the image-side activation check, so a marker this process wrote only for
 * client traffic is not evidence that a stream may be running. Counting it
 * made every production boot reconcile into the carrying startup hold and
 * stay `reconciling` until an operator stop. The same holds for the marker a
 * restarted backend finds from its predecessor's hold, before and after this
 * process takes its own.
 */
export function encoderOtaStreamLiveness(): "idle" | "unknown" {
	if (carryingOnlyMarker && !encoderProtected) return "idle";
	return initialOtaStreamLiveness();
}

export function setCarryingOtaProtection(protectedNow: boolean): boolean {
	carryingProtected = protectedNow;
	if (protectedNow) {
		const existed = initialOtaStreamLiveness() !== "idle";
		const shutdownProtected = setShutdownProtection("carrying", true);
		if (!existed && !encoderProtected) carryingOnlyMarker = true;
		const written = writeMarker(carryingOnlyMarker ? CARRYING_ONLY : undefined);
		if (!written && !existed) carryingOnlyMarker = false;
		return shutdownProtected && written;
	}
	const cleared = encoderProtected || removeMarker();
	if (cleared) carryingOnlyMarker = false;
	setShutdownProtection("carrying", !cleared);
	return cleared;
}

/** A failed write keeps protection unconfirmed and must be retried by the owner. */
export function setOtaStreamingMarker(): boolean {
	encoderProtected = true;
	carryingOnlyMarker = false;
	const shutdownProtected = setShutdownProtection("encoder", true);
	const written = emptyMarker();
	return shutdownProtected && written;
}

/** A file that cannot be rewritten in place is replaced, never removed first:
 * a failure must leave the marker standing. */
function emptyMarker(): boolean {
	if (writeMarker("")) return true;
	const path = otaStreamingMarkerPath();
	try {
		fs.writeFileSync(`${path}.new`, "");
		fs.renameSync(`${path}.new`, path);
		return true;
	} catch (error) {
		logger.warn("ota-streaming-marker: failed to set", { error });
		try {
			fs.rmSync(`${path}.new`, { force: true });
		} catch {
			// Nothing was renamed; the marker itself is untouched.
		}
		return false;
	}
}

/**
 * Before a launch is submitted, the file must stop saying carrying-only: a
 * later process would read that line beside a live stream and call the box
 * idle. Only the file changes here; this process still knows who holds it. A
 * marker that can be neither read, rewritten nor replaced refuses the Start.
 */
export function retireCarryingOnlyLine(): boolean {
	try {
		if (fs.readFileSync(otaStreamingMarkerPath(), "utf8") !== CARRYING_ONLY)
			return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return true;
	}
	return emptyMarker();
}

/** A stream's marker is empty. Without content the file is created or left as
 * it is: carrying never rewrites a marker it cannot explain. */
function writeMarker(content?: string): boolean {
	try {
		fs.writeFileSync(otaStreamingMarkerPath(), content ?? "", {
			flag: content === undefined ? "a" : "w",
		});
		return true;
	} catch (error) {
		logger.warn("ota-streaming-marker: failed to set", { error });
		return false;
	}
}

/** Cleared after confirmed idle/cleanup or a failed launch that never went live.
 * Stop intent disarms restoration separately; parked/failed/unknown media stops
 * retain this OTA guard. Removing an already-absent file is a no-op. */
export function clearOtaStreamingMarker(): boolean {
	encoderProtected = false;
	// Confirmed idle: a marker kept for client traffic is now carrying's alone.
	// The line is for a later process; a failed write only costs it that proof.
	if (carryingProtected) {
		carryingOnlyMarker = true;
		writeMarker(CARRYING_ONLY);
	}
	const cleared = carryingProtected || removeMarker();
	setShutdownProtection("encoder", !cleared);
	return cleared;
}

function removeMarker(): boolean {
	try {
		fs.rmSync(otaStreamingMarkerPath(), { force: true });
		return true;
	} catch (error) {
		logger.warn("ota-streaming-marker: failed to clear", { error });
		return false;
	}
}
