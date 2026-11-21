/**
 * The network-change journal: one small persistent record that survives a
 * backend restart, a NetworkManager restart and a reboot.
 *
 * It names every candidate profile and every recorded undo BEFORE the effect
 * happens, so recovery never has to guess. The file can hold new Wi-Fi
 * passphrases from a plan, so it is written 0600 in a 0700 directory, like
 * NetworkManager's own keyfiles.
 */

import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readPersistentRecord } from "../../helpers/persistent-record.ts";
import type { JsonValue } from "./network-change-effects.ts";
import type {
	AskBeforeAnswer,
	ChangePath,
	NoticeReason,
} from "./network-change-policy.ts";

export interface ProfileEdit {
	readonly uuid: string;
	/** nmcli property/value pairs applied to the candidate only. */
	readonly set: ReadonlyArray<readonly [string, string]>;
	/** Interface to activate the candidate on, when the edit is live. */
	readonly activateOn?: string;
	/**
	 * Autoconnect the promoted profile gets on commit. Absent keeps the
	 * original's. The candidate itself always has autoconnect off.
	 */
	readonly autoconnect?: boolean;
}

export interface EffectStep {
	readonly kind: string;
	readonly devices: readonly string[];
	readonly spec: JsonValue;
}

export interface NetworkChangePlan {
	readonly summary: {
		readonly key: string;
		readonly params?: Readonly<Record<string, string>>;
	};
	/** Interfaces the profile edits touch. Effect devices are added to these. */
	readonly devices: readonly string[];
	readonly profiles: readonly ProfileEdit[];
	readonly effects: readonly EffectStep[];
}

export type TxState =
	| "applying"
	| "pending"
	| "confirming"
	| "kept"
	| "rolling-back";

export interface ProfileRecord {
	original: string;
	originalId: string;
	originalAutoconnect: boolean;
	/** Autoconnect written on promotion (the edit's, else the original's). */
	commitAutoconnect?: boolean;
	candidate?: string;
	/** Interface the original carried when the change started. */
	wasActiveOn?: string | undefined;
	promoted?: boolean;
	backupId?: string;
}

export interface EffectRecord {
	kind: string;
	undo: JsonValue;
	state: "intent" | "applied" | "undone";
}

export interface TxRecord {
	id: string;
	bootId: string;
	state: TxState;
	mode: AskBeforeAnswer;
	path: ChangePath;
	creator: string;
	devices: string[];
	startedAt: number;
	appliedAt?: number;
	expiresAt?: number;
	checkpoint?: string;
	plan: NetworkChangePlan;
	profiles: ProfileRecord[];
	effects: EffectRecord[];
	/**
	 * A kept change whose promotion and settle both finished. Until then
	 * reconcile and the tick finish it, so a crash or a failed intent write
	 * can never leave a kept change unsettled.
	 */
	settled?: boolean;
	/** Set when an undo started, so a crash mid-undo finishes the same way. */
	undoReason?: NoticeReason | "failed" | undefined;
	errors?: string[];
}

export interface NoticeRecord {
	id: string;
	reason: NoticeReason;
	createdAt: number;
	plan: NetworkChangePlan;
}

export interface Journal {
	version: 1;
	tx: TxRecord | null;
	notice: NoticeRecord | null;
}

export interface JournalStore {
	/** Throws when the record cannot be trusted; never returns a guess. */
	read(): Promise<Journal>;
	write(journal: Journal): Promise<void>;
}

export function emptyJournal(): Journal {
	return { version: 1, tx: null, notice: null };
}

function parseJournal(json: unknown): Journal {
	if (
		!json ||
		typeof json !== "object" ||
		(json as { version?: unknown }).version !== 1 ||
		!("tx" in json) ||
		!("notice" in json)
	)
		throw new Error("Unsupported network-change journal");
	return structuredClone(json as Journal);
}

/** Copies on every read and write so callers cannot alias stored state. */
export function createMemoryJournalStore(
	initial: Journal = emptyJournal(),
): JournalStore & { snapshot(): Journal } {
	let stored = structuredClone(initial);
	return {
		async read() {
			return structuredClone(stored);
		},
		async write(journal) {
			stored = structuredClone(journal);
		},
		snapshot() {
			return structuredClone(stored);
		},
	};
}

export const DEFAULT_JOURNAL_PATH =
	"/data/ceralive/network-change/journal.json";
const MAX_JOURNAL_BYTES = 256 * 1024;

export function createFileJournalStore(
	path: string = DEFAULT_JOURNAL_PATH,
): JournalStore {
	return {
		async read() {
			const record = await readPersistentRecord(
				path,
				MAX_JOURNAL_BYTES,
				parseJournal,
			);
			if (record.kind === "absent") return emptyJournal();
			if (record.kind === "valid") return record.value;
			// Damaged or unreadable: refuse changes rather than forget an undo.
			throw new Error("Network-change journal unavailable");
		},
		async write(journal) {
			const dir = dirname(path);
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const tmp = join(dir, `.network-change.${process.pid}.tmp`);
			const fd = openSync(tmp, "w", 0o600);
			try {
				writeSync(fd, `${JSON.stringify(journal)}\n`);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			try {
				renameSync(tmp, path);
			} catch (error) {
				try {
					unlinkSync(tmp);
				} catch {
					/* already gone */
				}
				throw error;
			}
			const dirFd = openSync(dir, "r");
			try {
				fsyncSync(dirFd);
			} finally {
				closeSync(dirFd);
			}
		},
	};
}
