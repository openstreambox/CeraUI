import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import {
	openStoredStateDirectory,
	readStoredStateDescriptor,
} from "../system/update-orchestrator/stored-state-file.ts";
import { parseAuthorityJson } from "../system/update-orchestrator/strict-authority-json.ts";

export interface CarrierIntentIdentity {
	readonly uuid: string;
	readonly deviceId: string;
	readonly simId: string;
}
export interface CarrierIntent {
	readonly version: 1;
	readonly key: string;
	readonly mode: "automatic" | "manual";
	readonly phase: "pending" | "applied";
	readonly appliedApn?: string;
}
export interface CarrierIntentStore {
	readonly dir: string;
}
const defaultStore: CarrierIntentStore = {
	get dir() {
		return (
			process.env.CERALIVE_AUTOMATIC_CARRIER_STATE_DIR ??
			"/var/lib/ceralive/automatic-carrier-intent"
		);
	},
};

export function carrierIntentKey(identity: CarrierIntentIdentity): string {
	const parts = [identity.uuid, identity.deviceId, identity.simId];
	if (parts.some((value) => !value || value.length > 1024))
		throw new Error("Unresolved carrier intent identity");
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
function privateDirectory(dir: string): number {
	const fd = openStoredStateDirectory(dir, true);
	const info = fstatSync(fd);
	if (info.uid !== (process.getuid?.() ?? 0) || (info.mode & 0o077) !== 0) {
		closeSync(fd);
		throw new Error("Unsafe carrier intent directory");
	}
	return fd;
}
function absent(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function parseIntent(value: unknown, key: string): CarrierIntent {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid carrier intent");
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).some(
			(name) =>
				!["version", "key", "mode", "phase", "appliedApn"].includes(name),
		) ||
		record.version !== 1 ||
		record.key !== key ||
		(record.mode !== "automatic" && record.mode !== "manual") ||
		(record.phase !== "pending" && record.phase !== "applied") ||
		(record.appliedApn !== undefined &&
			(typeof record.appliedApn !== "string" ||
				!/^[a-zA-Z0-9._-]{1,100}$/.test(record.appliedApn)))
	)
		throw new Error("Invalid carrier intent");
	return {
		version: 1,
		key,
		mode: record.mode,
		phase: record.phase as CarrierIntent["phase"],
		...(typeof record.appliedApn === "string"
			? { appliedApn: record.appliedApn }
			: {}),
	};
}

export async function readCarrierIntent(
	identity: CarrierIntentIdentity,
	store: CarrierIntentStore = defaultStore,
): Promise<CarrierIntent | undefined> {
	const key = carrierIntentKey(identity);
	let parent: number;
	try {
		parent = privateDirectory(store.dir);
	} catch (error) {
		if (absent(error)) return undefined;
		throw error;
	}
	try {
		let fd: number;
		try {
			fd = openSync(
				`/proc/self/fd/${parent}/${key}.json`,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
		} catch (error) {
			if (absent(error)) return undefined;
			throw error;
		}
		try {
			const info = fstatSync(fd);
			if (
				info.uid !== (process.getuid?.() ?? 0) ||
				(info.mode & 0o077) !== 0 ||
				info.nlink !== 1
			)
				throw new Error("Unsafe carrier intent file");
			return parseIntent(
				parseAuthorityJson(
					readStoredStateDescriptor(fd, 4096).toString("utf8"),
				),
				key,
			);
		} finally {
			closeSync(fd);
		}
	} finally {
		closeSync(parent);
	}
}

/** Call under the modem lifecycle lease; this record stores intent, never carrier selection. */
export async function writeCarrierIntent(
	identity: CarrierIntentIdentity,
	intent: CarrierIntent | undefined,
	store: CarrierIntentStore = defaultStore,
): Promise<void> {
	const key = carrierIntentKey(identity);
	if (intent) parseIntent(intent, key);
	await mkdir(store.dir, { recursive: true, mode: 0o700 });
	const parent = privateDirectory(store.dir);
	const path = `/proc/self/fd/${parent}/${key}.json`;
	const temporary = `/proc/self/fd/${parent}/${key}.${randomUUID()}.tmp`;
	try {
		if (!intent) {
			try {
				await unlink(path);
			} catch (error) {
				if (!absent(error)) throw error;
			}
			fsyncSync(parent);
			return;
		}
		const handle = await open(
			temporary,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await handle.writeFile(`${JSON.stringify(intent)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
		fsyncSync(parent);
	} finally {
		// A failed transaction may leave a private, uncommitted temporary. Preserve
		// the original persistence error; this path never names authoritative state.
		await unlink(temporary).catch(() => undefined);
		closeSync(parent);
	}
}

export function newCarrierIntent(
	identity: CarrierIntentIdentity,
	mode: CarrierIntent["mode"],
	appliedApn?: string,
): CarrierIntent {
	return {
		version: 1,
		key: carrierIntentKey(identity),
		mode,
		phase: mode === "manual" || appliedApn ? "applied" : "pending",
		...(appliedApn ? { appliedApn } : {}),
	};
}

/** A remembered APN is only a conflict witness; subscription evidence selects policy. */
export function effectiveCarrierAutomatic(
	intent: CarrierIntent | undefined,
	nmAutomatic: boolean,
	apn: string,
): boolean {
	if (!intent) return nmAutomatic;
	if (intent.mode === "manual") return false;
	if (intent.phase === "pending") return true;
	return (
		nmAutomatic ||
		(intent.appliedApn !== undefined && intent.appliedApn === apn)
	);
}

export function parseCarrierIntent(
	identity: CarrierIntentIdentity,
	value: unknown,
): CarrierIntent {
	return parseIntent(value, carrierIntentKey(identity));
}

export function sameCarrierIntent(
	a: CarrierIntent | undefined,
	b: CarrierIntent | undefined,
): boolean {
	return (
		a?.version === b?.version &&
		a?.key === b?.key &&
		a?.mode === b?.mode &&
		a?.phase === b?.phase &&
		a?.appliedApn === b?.appliedApn
	);
}
