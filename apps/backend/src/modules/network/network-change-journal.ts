/**
 * The network-change journal: one small persistent record that survives a
 * backend restart, a NetworkManager restart and a reboot.
 *
 * It names every candidate profile and every recorded undo BEFORE the effect
 * happens, so recovery never has to guess. The file can hold new Wi-Fi
 * passphrases from a plan, so it is written 0600 in a 0700 directory, like
 * NetworkManager's own keyfiles.
 */

import { randomUUID } from "node:crypto";
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

/**
 * What a confirmation must match, bound at apply. Hashes only: the code itself
 * stays in the requesting browser.
 */
export interface ChallengeRecord {
	/** SHA-256 (hex) of the one-time code the page minted for this change. */
	codeHash: string;
	/** SHA-256 (hex) of the requester's auth token: the browser login. */
	tokenHash: string;
	/** `Origin` and `Host` of the requester's WebSocket upgrade: the UI address. */
	origin: string;
	host: string;
}

export interface TxRecord {
	id: string;
	bootId: string;
	state: TxState;
	mode: AskBeforeAnswer;
	path: ChangePath;
	creator: string;
	devices: string[];
	/** Wall time (ms since the epoch), for display and older records. */
	startedAt: number;
	appliedAt?: number;
	expiresAt?: number;
	/**
	 * The same instants on the boot clock (ms since boot, CLOCK_BOOTTIME).
	 * Comparable across backend restarts within `bootId`, and immune to the
	 * wall clock stepping when NTP syncs after an uplink change.
	 */
	startedClock?: number;
	appliedClock?: number;
	expiresClock?: number;
	checkpoint?: string;
	/** The unique bus name of the NetworkManager instance that made it. */
	checkpointOwner?: string;
	/** The checkpoint's `Created` stamp. */
	checkpointCreated?: string;
	/** The D-Bus instance id (org.freedesktop.DBus.GetId) the owner name is on. */
	checkpointBus?: string;
	/** Absent: nobody can confirm (a session without a browser login). */
	challenge?: ChallengeRecord;
	/**
	 * Set by the confirmation: the confirming socket's front-door interface,
	 * or null for a remote connection. Shown once the commit finishes.
	 */
	confirmedVia?: string | null;
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
	/** Incomplete undo attempts so far, and when the tick may retry. */
	undoAttempts?: number;
	nextAttemptAt?: number;
}

export interface NoticeRecord {
	id: string;
	reason: NoticeReason;
	createdAt: number;
	plan: NetworkChangePlan;
}

/** The last confirmed change and where the confirmation came from. */
export interface ConfirmedRecord {
	id: string;
	/** The confirming socket's front-door interface; null: a remote connection. */
	via: string | null;
	at: number;
}

export interface Journal {
	version: 1;
	tx: TxRecord | null;
	notice: NoticeRecord | null;
	/** Kept until the next change starts. */
	confirmed?: ConfirmedRecord | null;
}

export interface JournalStore {
	/** Throws when the record cannot be trusted; never returns a guess. */
	read(): Promise<Journal>;
	write(journal: Journal): Promise<void>;
	/**
	 * Move the stored record aside under a name no other reset can pick, and
	 * return that name. Only the owner calls it, serialized, after a read
	 * failed.
	 */
	quarantine?(): Promise<string>;
}

export function emptyJournal(): Journal {
	return { version: 1, tx: null, notice: null };
}

const TX_STATES = ["applying", "pending", "confirming", "kept", "rolling-back"];
const MODES = ["undo-automatically", "keep-change"];
const PATHS = ["own", "other", "unknown"];
const REASONS = ["disconnected", "restart", "interrupted", "unsaved"];
const HEX64 = /^[0-9a-f]{64}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === "object" && !Array.isArray(v);
const isStrings = (v: unknown) =>
	Array.isArray(v) && v.every((item) => typeof item === "string");
const isTime = (v: unknown) =>
	typeof v === "number" && Number.isFinite(v) && v >= 0;
/** An optional field is absent, or present with the right shape. */
const optional = (v: unknown, valid: (value: unknown) => boolean) =>
	v === undefined || valid(v);
const isString = (v: unknown) => typeof v === "string";
const isShortString = (v: unknown) =>
	typeof v === "string" && v.length > 0 && v.length <= 512;

function validPlan(plan: unknown): boolean {
	return (
		isObject(plan) &&
		isObject(plan.summary) &&
		typeof plan.summary.key === "string" &&
		optional(
			plan.summary.params,
			(params) => isObject(params) && Object.values(params).every(isString),
		) &&
		isStrings(plan.devices) &&
		Array.isArray(plan.profiles) &&
		plan.profiles.every(
			(edit) =>
				isObject(edit) &&
				typeof edit.uuid === "string" &&
				Array.isArray(edit.set) &&
				edit.set.every(
					(pair) => Array.isArray(pair) && pair.length === 2 && isStrings(pair),
				) &&
				optional(edit.activateOn, isString) &&
				optional(edit.autoconnect, (v) => typeof v === "boolean"),
		) &&
		Array.isArray(plan.effects) &&
		plan.effects.every(
			(step) =>
				isObject(step) &&
				typeof step.kind === "string" &&
				isStrings(step.devices),
		)
	);
}

function validChallenge(challenge: unknown): boolean {
	return (
		isObject(challenge) &&
		HEX64.test(String(challenge.codeHash)) &&
		HEX64.test(String(challenge.tokenHash)) &&
		isShortString(challenge.origin) &&
		isShortString(challenge.host)
	);
}

/**
 * The fields every code path relies on, and every optional field that is
 * present. Optional fields added later may be missing, so records written by
 * earlier builds still read (a record without a checkpoint identity is
 * readable, and the owner never sends it a checkpoint call). Fields a state
 * needs are required for that state: a pending change has a deadline.
 */
function validTx(tx: unknown): boolean {
	if (
		!(
			isObject(tx) &&
			typeof tx.id === "string" &&
			typeof tx.bootId === "string" &&
			TX_STATES.includes(tx.state as string) &&
			MODES.includes(tx.mode as string) &&
			PATHS.includes(tx.path as string) &&
			typeof tx.creator === "string" &&
			isStrings(tx.devices) &&
			isTime(tx.startedAt) &&
			validPlan(tx.plan) &&
			Array.isArray(tx.profiles) &&
			tx.profiles.every(
				(p) =>
					isObject(p) &&
					typeof p.original === "string" &&
					typeof p.originalId === "string" &&
					typeof p.originalAutoconnect === "boolean" &&
					optional(p.commitAutoconnect, (v) => typeof v === "boolean") &&
					optional(p.candidate, isString) &&
					optional(p.wasActiveOn, isString) &&
					optional(p.promoted, (v) => typeof v === "boolean") &&
					optional(p.backupId, isString),
			) &&
			Array.isArray(tx.effects) &&
			tx.effects.every(
				(e) =>
					isObject(e) &&
					typeof e.kind === "string" &&
					"undo" in e &&
					["intent", "applied", "undone"].includes(e.state as string),
			)
		)
	)
		return false;
	const timesOk = [
		tx.appliedAt,
		tx.expiresAt,
		tx.startedClock,
		tx.appliedClock,
		tx.expiresClock,
		tx.nextAttemptAt,
	].every((v) => optional(v, isTime));
	const stringsOk = [
		tx.checkpoint,
		tx.checkpointOwner,
		tx.checkpointCreated,
		tx.checkpointBus,
	].every((v) => optional(v, isString));
	const restOk =
		optional(tx.challenge, validChallenge) &&
		optional(tx.confirmedVia, (v) => v === null || isShortString(v)) &&
		optional(tx.settled, (v) => typeof v === "boolean") &&
		optional(
			tx.undoReason,
			(v) => v === "failed" || REASONS.includes(v as string),
		) &&
		optional(tx.errors, isStrings) &&
		optional(
			tx.undoAttempts,
			(v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0,
		);
	// A pending change is bounded: it has an apply time and a deadline.
	const stateOk =
		tx.state !== "pending" || (isTime(tx.appliedAt) && isTime(tx.expiresAt));
	return timesOk && stringsOk && restOk && stateOk;
}

function validNotice(notice: unknown): boolean {
	return (
		isObject(notice) &&
		typeof notice.id === "string" &&
		REASONS.includes(notice.reason as string) &&
		isTime(notice.createdAt) &&
		validPlan(notice.plan)
	);
}

function validConfirmed(confirmed: unknown): boolean {
	return (
		confirmed === null ||
		(isObject(confirmed) &&
			typeof confirmed.id === "string" &&
			(confirmed.via === null || isShortString(confirmed.via)) &&
			isTime(confirmed.at))
	);
}

function parseJournal(json: unknown): Journal {
	if (
		!isObject(json) ||
		json.version !== 1 ||
		!("tx" in json) ||
		!("notice" in json) ||
		(json.tx !== null && !validTx(json.tx)) ||
		(json.notice !== null && !validNotice(json.notice)) ||
		!optional(json.confirmed, validConfirmed)
	)
		throw new Error("Unsupported network-change journal");
	return structuredClone(json as unknown as Journal);
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
		async quarantine() {
			const movedTo = `${path}.damaged-${Date.now()}-${randomUUID().slice(0, 8)}`;
			renameSync(path, movedTo);
			return movedTo;
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
