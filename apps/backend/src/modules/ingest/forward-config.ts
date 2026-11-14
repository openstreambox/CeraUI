import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { srtForwardConfigSchema } from "../../helpers/forward-config-schema.ts";
import {
	readStoredStateJson,
	STORED_STATE_LIMITS,
} from "../system/update-orchestrator/stored-state-file.ts";
import {
	loadForwardSecret,
	readForwardSecret,
	writeForwardFile,
} from "./forward-secret.ts";

/** Operator-owned state wins over image metadata. null means never configured. */
export async function loadForwardConfig(
	directory: string,
	legacy: unknown,
	legacySecret: string,
) {
	const path = join(directory, "srt-forward.json");
	let raw: unknown;
	let migrate = false;
	let fromSnapshot = false;
	const snapshot = join(directory, "srt-forward-legacy-setup.json");
	// A persistent file supersedes the backup even if its contents fail closed.
	const persistentExists = await lstat(path).then(
		() => true,
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return false;
			throw error;
		},
	);
	if (persistentExists) await removeSnapshot(directory, snapshot);
	raw = await readStoredStateJson(path, STORED_STATE_LIMITS.settings);
	if (raw === undefined) {
		raw = legacy;
		if (raw === undefined) {
			const saved = await readStoredStateJson(
				snapshot,
				STORED_STATE_LIMITS.settings,
			);
			if (saved !== undefined) {
				fromSnapshot = true;
				if (typeof saved !== "object" || saved === null)
					throw Error("forward_migration_invalid");
				raw = Reflect.get(saved, "srt_forward");
			}
		}
		if (raw === undefined) {
			if (fromSnapshot) await removeSnapshot(directory, snapshot);
			return null;
		}
		migrate = true;
	}
	const parsed = srtForwardConfigSchema.parse(raw);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if (
		typeof raw === "object" &&
		raw !== null &&
		!Reflect.has(raw, "passphrase")
	) {
		const previous = migrate
			? await readForwardSecret(legacySecret)
			: undefined;
		parsed.passphrase = await loadForwardSecret(
			join(directory, "srt-forward.secret"),
			previous ?? parsed.passphrase,
		);
	}
	// Publish configuration last, so a completed migration always has its secret.
	if (migrate) await writeForwardFile(path, JSON.stringify(raw));
	await removeSnapshot(directory, snapshot);
	return parsed;
}

async function removeSnapshot(directory: string, snapshot: string) {
	try {
		await unlink(snapshot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const dir = await open(directory, "r");
	try {
		await dir.sync();
	} finally {
		await dir.close();
	}
}
