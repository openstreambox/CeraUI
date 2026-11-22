import {
	linkSync,
	lstatSync,
	readFileSync,
	renameSync,
	unlinkSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { logger } from "../../helpers/logger.ts";
import type { NmProfileInstance } from "./network-manager-profile-instance.ts";

type FileIdentity = NonNullable<NmProfileInstance["file"]>;

function identity(path: string) {
	const entry = lstatSync(path, { bigint: true, throwIfNoEntry: false });
	if (!entry?.isFile()) return undefined;
	return {
		device: String(entry.dev),
		inode: String(entry.ino),
		ctime: String(entry.ctimeNs),
	};
}

function hasBytes(
	path: string,
	expected: Pick<FileIdentity, "device" | "inode">,
	bytes: Buffer,
) {
	const before = identity(path);
	if (before?.device !== expected.device || before.inode !== expected.inode)
		return false;
	return (
		readFileSync(path).equals(bytes) && identity(path)?.ctime === before.ctime
	);
}

/** The name operations a restore races against; tests interleave other writers here. */
export type KeyfileNameOps = {
	readonly rename: (from: string, to: string) => void;
	readonly link: (existing: string, name: string) => void;
};
const nameOps: KeyfileNameOps = { rename: renameSync, link: linkSync };

export function stageKeyfilePublication(
	original: FileIdentity,
	bytes: Buffer,
	staged: string,
	ops: KeyfileNameOps = nameOps,
) {
	const live = original.filename;
	const previous = `${staged}.previous.tmp`;
	const moved = `${staged}.rollback.tmp`;
	let parked = false;
	let published: ReturnType<typeof identity>;
	let loadStarted = false;
	let committed = false;
	let keepMoved = false;

	const matches = (path: string, expected: Buffer) =>
		published !== undefined && hasBytes(path, published, expected);
	return {
		publish(expected: Buffer) {
			published = identity(staged);
			if (!published) return false;
			// Park what actually occupied the name; neither publication nor restore may replace a new entry.
			renameSync(live, previous);
			parked = true;
			if (!hasBytes(previous, original, bytes)) return false;
			linkSync(staged, live);
			return matches(live, expected);
		},
		ownsLive: (expected: Buffer) => matches(live, expected),
		beginLoad: () => {
			loadStarted = true;
		},
		commit: () => {
			committed = true;
		},
		/**
		 * After a load, put the parked original back under the live name, but only
		 * while that name still holds our bytes: a successor written by anyone else
		 * stays live and the original stays parked. Returns the restored file's
		 * identity, ctime included, so the caller can prove NM loaded exactly it.
		 */
		restore(expected: Buffer): FileIdentity | undefined {
			if (!parked || committed || !matches(live, expected)) return undefined;
			try {
				ops.rename(live, moved);
				keepMoved = true;
				const ours = matches(moved, expected);
				// link refuses an entry that appeared meanwhile; nothing is overwritten.
				ops.link(ours ? previous : moved, live);
				keepMoved = false;
				if (!ours) return undefined;
				// Drop the parked name now: unlinking it later would move the inode's ctime.
				unlinkSync(previous);
				parked = false;
				const restored = identity(live);
				return restored && hasBytes(live, original, bytes)
					? { filename: live, ...restored }
					: undefined;
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				logger.error("NM keyfile restoration failed", { filename: live });
				return undefined;
			}
		},
		async finish(expected: Buffer) {
			try {
				if (parked && !loadStarted) {
					if (!lstatSync(live, { throwIfNoEntry: false })) {
						linkSync(previous, live);
						parked = false;
					} else if (matches(live, expected)) {
						renameSync(live, moved);
						keepMoved = true;
						// An external rename can win between the check and the move; relink that successor, not our backup.
						const ours = matches(moved, expected);
						linkSync(ours ? previous : moved, live);
						keepMoved = false;
						if (ours) parked = false;
					}
				}
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				logger.error("NM keyfile restoration failed", { filename: live });
			} finally {
				if (parked && !committed)
					logger.error("NM profile rollback kept the previous keyfile aside", {
						preserved: previous,
					});
				else await rm(previous, { force: true });
				if (keepMoved)
					logger.error(
						"NM profile rollback kept the displaced live keyfile aside",
						{
							preserved: moved,
						},
					);
				else await rm(moved, { force: true });
				await rm(staged, { force: true });
			}
		},
	};
}
