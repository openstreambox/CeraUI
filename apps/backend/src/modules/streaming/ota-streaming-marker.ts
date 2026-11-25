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
 * the file cannot say carrying-only beside a stream this backend launched.
 *
 * A line left by an earlier process is only that process's belief at its
 * last write. A stream that began afterwards (another control client, while
 * the file could not be rewritten) leaves it standing, so the line alone never
 * proves idle to a restarted backend. It is held as protection until the
 * engine agrees: a silent engine witnesses it (`releaseEncoder`), a running
 * one is adopted (`adoptStream`).
 */

import fs from "node:fs";
import { logger } from "../../helpers/logger.ts";
import { setShutdownProtection } from "../system/shutdown-protection.ts";

export function otaStreamingMarkerPath(): string {
	return process.env.CERALIVE_STREAMING_MARKER ?? "/run/ceralive/streaming";
}

/** Only ENOENT proves an empty boot baseline; unreadable evidence stays protected. */
export function initialOtaStreamLiveness(
	path: string = otaStreamingMarkerPath(),
): "idle" | "unknown" {
	try {
		fs.lstatSync(path);
		return "unknown";
	} catch (error) {
		return isEnoent(error) ? "idle" : "unknown";
	}
}

/** Written only into a marker that carrying alone explains. */
const CARRYING_ONLY = "carrying\n";

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
	/** The content, null for no file, undefined when it cannot be read. */
	const contentNow = (): string | null | undefined => {
		try {
			return io.fs.readFileSync(io.path(), "utf8");
		} catch (error) {
			return isEnoent(error) ? null : undefined;
		}
	};
	/** True for the exact line, false for anything else readable or no file,
	 * undefined when the file cannot be read. */
	const saysCarryingOnly = (): boolean | undefined => {
		const content = contentNow();
		return content === undefined ? undefined : content === CARRYING_ONLY;
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
	const rewrite = (content: string) =>
		attempt(() => io.fs.writeFileSync(io.path(), content), setFailed);
	const replace = (content: string) =>
		attempt(() => {
			try {
				io.fs.writeFileSync(`${io.path()}.new`, content);
				io.fs.renameSync(`${io.path()}.new`, io.path());
			} catch (error) {
				io.fs.rmSync(`${io.path()}.new`, { force: true });
				throw error;
			}
		}, setFailed);
	/**
	 * A failure must leave the marker standing, so it is never removed first.
	 * Content already on disk is not written again: a rewrite that fails after
	 * truncating would turn a good line into an empty, unexplained file. The
	 * line goes through a renamed sibling, so a torn write never reaches the
	 * marker; rewriting in place stays the fallback that still leaves a file
	 * for the image. The empty stream marker is a truncation, which cannot
	 * tear and needs no new file.
	 */
	const put = (content: string): boolean => {
		if (contentNow() === content) return true;
		return content === ""
			? rewrite(content) || replace(content)
			: replace(content) || rewrite(content);
	};

	// A process that died between writing the sibling and renaming it left
	// the sibling behind. Nothing reads it; it is only tidied away.
	attempt(
		() => io.fs.rmSync(`${io.path()}.new`, { force: true }),
		() => undefined,
	);

	let carrying = false;
	// True while the file, if any, is ours and no stream stands behind it:
	// created from absence or handed back by a confirmed encoder idle.
	let explained = false;
	// The carrying line an earlier backend process left. `/run` outlives a
	// backend restart, and every restart takes the carrying hold again, so it is
	// usually that process's hold and nothing more. It still only says what
	// that process knew, so it stays protection, unchanged on disk, until this
	// process's engine evidence confirms idle or finds a stream.
	let inherited = saysCarryingOnly() === true;
	// Anything else on disk (empty, unreadable, unexplained) is evidence of a
	// possible stream.
	let encoder = !inherited && presence() !== "idle";
	io.setShutdownProtection("encoder", encoder || inherited);

	const claimFromAbsence = () => {
		if (!encoder && !inherited && presence() === "idle") explained = true;
	};
	/** The one place the file changes. */
	const sync = (): boolean => {
		if (encoder) return put("");
		// Neither carrying nor its end may change a line that waits for a witness.
		// A line that is gone no longer says anything.
		if (inherited && presence() === "unknown") return true;
		inherited = false;
		if (carrying)
			return explained
				? put(CARRYING_ONLY)
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
			explained && !encoder && !inherited ? "idle" : presence(),
		/**
		 * True while an earlier process's carrying line waits for this process's
		 * engine evidence. Engine silence alone is not idle; silence together
		 * with that line is, because a running session reports its status.
		 */
		awaitsIdleWitness: (): boolean => inherited && !encoder,
		setCarrying: (protectedNow: boolean): boolean => {
			carrying = protectedNow;
			if (protectedNow) {
				claimFromAbsence();
				const shutdownProtected = io.setShutdownProtection("carrying", true);
				const written = sync();
				return shutdownProtected && written;
			}
			const cleared = encoder || inherited || sync();
			io.setShutdownProtection("carrying", !cleared);
			return cleared;
		},
		/**
		 * Protection for a possible stream. A failed write keeps protection
		 * unconfirmed and must be retried by the owner. An inherited line is
		 * left as it is: unknown is not a stream, and the line is what lets the
		 * next process, too, reach idle once the engine is heard.
		 */
		takeEncoder: (): boolean => {
			const shutdownProtected = io.setShutdownProtection("encoder", true);
			if (inherited && !encoder) return shutdownProtected;
			encoder = true;
			explained = false;
			const written = sync();
			return shutdownProtected && written;
		},
		/**
		 * The engine reports a running session: the file becomes the stream's,
		 * whoever started it and whatever it said before. Called on every commit
		 * to streaming, because protection may already be held from an earlier
		 * unknown answer.
		 */
		adoptStream: (): boolean => {
			const shutdownProtected = io.setShutdownProtection("encoder", true);
			inherited = false;
			encoder = true;
			explained = false;
			const written = sync();
			return shutdownProtected && written;
		},
		/** Cleared after confirmed idle/cleanup or a failed launch that never went
		 * live. Stop intent disarms restoration separately; parked/failed/unknown
		 * media stops retain this OTA guard. */
		releaseEncoder: (): boolean => {
			encoder = false;
			// Confirmed idle also witnesses an inherited line: nothing stands
			// behind it, so it is this process's hold or nobody's.
			inherited = false;
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
		claimForLaunch: (): boolean => {
			const held = { encoder, explained, inherited };
			encoder = true;
			explained = false;
			inherited = false;
			sync();
			if (saysCarryingOnly() === false) return true;
			({ encoder, explained, inherited } = held);
			sync();
			return false;
		},
	};
}

const owner = createOtaMarkerOwner({
	path: otaStreamingMarkerPath,
	fs,
	setShutdownProtection,
});
export const encoderOtaStreamLiveness = owner.liveness;
export const setCarryingOtaProtection = owner.setCarrying;
export const setOtaStreamingMarker = owner.takeEncoder;
export const clearOtaStreamingMarker = owner.releaseEncoder;
export const claimOtaMarkerForLaunch = owner.claimForLaunch;
export const adoptOtaStreamingMarker = owner.adoptStream;
export const otaMarkerAwaitsIdleWitness = owner.awaitsIdleWitness;
