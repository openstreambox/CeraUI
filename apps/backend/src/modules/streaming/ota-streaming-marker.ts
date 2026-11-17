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
 *
 * One owner writes the file, and what it writes follows from who holds it:
 * a stream keeps it empty, carrying alone keeps the line, nobody removes it.
 * Every holder change goes through `sync()` in the same tick, and a launch is
 * submitted only after the file was seen without the line in that tick, so
 * the file cannot say carrying-only beside a stream it launched.
 *
 * A stream this backend only adopts cannot be refused, and a write that fails
 * then cannot leave any other durable sign. So the line is a claim that
 * expires: it carries the uptime of its last refresh, carrying refreshes it on
 * its tick, and a later process trusts it only while fresh. A holder that could
 * not empty the file stops refreshing it and retries the empty on every tick.
 */

import fs from "node:fs";
import os from "node:os";
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
		return isEnoent(error) ? "idle" : "unknown";
	}
}

/** Written only into a marker that carrying alone explains: `carrying <uptime s>`. */
const CARRYING_LINE = /^carrying (\d+)\n$/;
/**
 * How old a predecessor's line may be. It was refreshed at most one carrying
 * tick (5 s) before that process stopped, and a service restart measured 2 s
 * on a device (2 s more after a crash); 30 s leaves room for a slow stop. A
 * line that is older, or from the future, proves nothing: `/run` is a tmpfs,
 * so only an earlier boot of a relocated marker could carry one.
 */
export const CARRYING_LINE_FRESH_SECONDS = 30;
/** Carrying's tick period: the line is not rewritten more often than this. */
const CARRYING_LINE_REFRESH_SECONDS = 5;

type MarkerFs = Pick<
	typeof fs,
	"lstatSync" | "readFileSync" | "writeFileSync" | "renameSync" | "rmSync"
>;
const isEnoent = (error: unknown) =>
	error instanceof Error && "code" in error && error.code === "ENOENT";

const setFailed = (error: unknown) =>
	logger.warn("ota-streaming-marker: failed to set", { error });
const clearFailed = (error: unknown) =>
	logger.warn("ota-streaming-marker: failed to clear", { error });

export function createOtaMarkerOwner(io: {
	readonly path: () => string;
	readonly fs: MarkerFs;
	readonly setShutdownProtection: typeof setShutdownProtection;
	/** Seconds since boot: one clock for this process and its successors. */
	readonly uptime: () => number;
	/** The exhaustive walk fails writes on purpose, thousands of times. */
	readonly quiet?: boolean;
}) {
	/** Only ENOENT proves an empty boot baseline; unreadable evidence stays protected. */
	const presence = (): "idle" | "unknown" => {
		try {
			io.fs.lstatSync(io.path());
			return "unknown";
		} catch (error) {
			return isEnoent(error) ? "idle" : "unknown";
		}
	};
	/** The file's content, null for no file, undefined when it cannot be read. */
	const content = (): string | null | undefined => {
		try {
			return io.fs.readFileSync(io.path(), "utf8");
		} catch (error) {
			return isEnoent(error) ? null : undefined;
		}
	};
	/** True for a carrying line of any age, false for anything else readable
	 * or no file, undefined when the file cannot be read. */
	const saysCarryingOnly = (): boolean | undefined => {
		const found = content();
		return found === undefined ? undefined : CARRYING_LINE.test(found ?? "");
	};
	/** Seconds since the line's stamp; undefined without a carrying line. */
	const lineAge = (): number | undefined => {
		const stamp = CARRYING_LINE.exec(content() ?? "")?.[1];
		return stamp === undefined ? undefined : io.uptime() - Number(stamp);
	};
	const freshCarryingLine = (): boolean => {
		const age = lineAge();
		return age !== undefined && age >= 0 && age <= CARRYING_LINE_FRESH_SECONDS;
	};
	const attempt = (
		action: () => void,
		report: (error: unknown) => void,
	): boolean => {
		try {
			action();
			return true;
		} catch (error) {
			if (io.quiet !== true) report(error);
			return false;
		}
	};
	/** A file that cannot be rewritten in place is replaced, never removed
	 * first: a failure must leave the marker standing. */
	const put = (content: string): boolean =>
		attempt(() => io.fs.writeFileSync(io.path(), content), setFailed) ||
		attempt(() => {
			try {
				io.fs.writeFileSync(`${io.path()}.new`, content);
				io.fs.renameSync(`${io.path()}.new`, io.path());
			} catch (error) {
				io.fs.rmSync(`${io.path()}.new`, { force: true });
				throw error;
			}
		}, setFailed);

	let carrying = false;
	// True while the file, if any, is ours and no stream stands behind it:
	// created from absence, handed back by a confirmed encoder idle, or left
	// by an earlier backend process with a fresh carrying line. `/run` outlives
	// a backend restart, and every start takes the carrying hold again, so the
	// earlier process's hold is not a stream. Anything else (empty, stale,
	// unreadable, unexplained) stays evidence of a possible stream.
	let explained = freshCarryingLine();
	let encoder = !explained && presence() !== "idle";
	io.setShutdownProtection("encoder", encoder);

	const claimFromAbsence = () => {
		if (!encoder && presence() === "idle") explained = true;
	};
	/** The one place the file changes. */
	const sync = (): boolean => {
		if (encoder) return put("");
		if (carrying)
			return explained
				? put(`carrying ${Math.floor(io.uptime())}\n`)
				: // Carrying never rewrites a marker it cannot explain.
					attempt(
						() => io.fs.writeFileSync(io.path(), "", { flag: "a" }),
						setFailed,
					);
		const removed = attempt(
			() => io.fs.rmSync(io.path(), { force: true }),
			clearFailed,
		);
		if (removed) explained = false;
		return removed;
	};

	return {
		/**
		 * The stream session's view of the sentinel. Both owners share one file
		 * for the image-side activation check, so a marker held only for client
		 * traffic is not evidence that a stream may be running. Counting it made
		 * every production boot reconcile into the carrying startup hold and stay
		 * `reconciling` until an operator stop; so did the marker a restarted
		 * backend found from its predecessor's hold.
		 */
		liveness: (): "idle" | "unknown" =>
			explained && !encoder ? "idle" : presence(),
		setCarrying: (protectedNow: boolean): boolean => {
			carrying = protectedNow;
			if (protectedNow) {
				claimFromAbsence();
				const shutdownProtected = io.setShutdownProtection("carrying", true);
				const written = sync();
				return shutdownProtected && written;
			}
			const cleared = encoder || sync();
			io.setShutdownProtection("carrying", !cleared);
			return cleared;
		},
		/** A failed write keeps protection unconfirmed and must be retried by the owner. */
		takeEncoder: (): boolean => {
			encoder = true;
			explained = false;
			const shutdownProtected = io.setShutdownProtection("encoder", true);
			const written = sync();
			return shutdownProtected && written;
		},
		/** Cleared after confirmed idle/cleanup or a failed launch that never went
		 * live. Stop intent disarms restoration separately; parked/failed/unknown
		 * media stops retain this OTA guard. */
		releaseEncoder: (): boolean => {
			encoder = false;
			// Confirmed idle: a marker kept for client traffic is carrying's alone.
			// Its line is for a later process; a failed write only costs that proof.
			if (carrying) explained = true;
			const written = sync();
			const cleared = carrying || written;
			io.setShutdownProtection("encoder", !cleared);
			return cleared;
		},
		/**
		 * The last step of Start admission, in the same tick as the launch: the
		 * stream takes the file, and the launch may go only if the file is then
		 * seen without the carrying line. Otherwise a later process would read
		 * it beside a live stream as idle, so nothing is taken and Start is
		 * refused. Until this call a Start changes nothing, so a cancelled one
		 * leaves nothing to put back.
		 */
		/**
		 * Carrying's tick. Keeps a carrying-only line fresh, and retries the empty
		 * a stream holder could not write, so a line left beside an adopted
		 * stream goes stale by itself and is gone once the file can be written.
		 */
		tick: (): void => {
			if (encoder) {
				if (content() !== "") sync();
				return;
			}
			if (!carrying || !explained) return;
			// Reports between ticks never rewrite the marker; one tick may.
			const age = lineAge();
			if (age === undefined || age < 0 || age >= CARRYING_LINE_REFRESH_SECONDS)
				sync();
		},
		claimForLaunch: (): boolean => {
			const held = { encoder, explained };
			encoder = true;
			explained = false;
			sync();
			if (saysCarryingOnly() === false) return true;
			({ encoder, explained } = held);
			sync();
			return false;
		},
	};
}

const owner = createOtaMarkerOwner({
	path: otaStreamingMarkerPath,
	fs,
	setShutdownProtection,
	uptime: os.uptime,
});
export const encoderOtaStreamLiveness = owner.liveness;
export const setCarryingOtaProtection = owner.setCarrying;
export const setOtaStreamingMarker = owner.takeEncoder;
export const clearOtaStreamingMarker = owner.releaseEncoder;
export const claimOtaMarkerForLaunch = owner.claimForLaunch;
export const tickOtaMarker = owner.tick;
