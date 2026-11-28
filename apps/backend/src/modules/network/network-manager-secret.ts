import { AsyncLocalStorage } from "node:async_hooks";
import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { logger } from "../../helpers/logger.ts";
import { run, runWithStdin } from "../../helpers/run.ts";
import { nmConnGetFields } from "./network-manager.ts";
import { stageKeyfilePublication } from "./network-manager-keyfile-publication.ts";
import type { NmProfileReadTrace } from "./network-manager-profile-diagnostics.ts";
import { readNmProfileFileSecret } from "./network-manager-profile-file.ts";
import {
	type NmProfileInstance,
	readNmProfileInstance,
	sameNmProfileFile,
	sameNmProfileResource,
} from "./network-manager-profile-instance.ts";
import { openNmProfileFile } from "./network-manager-profile-write.ts";
import type { ProfileWritePermit } from "./profile-write-permit.ts";

/** Secret-display placeholders are unavailable reads, never credentials. */
export function isNmWifiSecretAvailable(
	value: string | undefined,
): value is string {
	return value !== undefined && value !== "" && value !== "<hidden>";
}

/** NM owns encoding/normalization; secret values reach it only on stdin. */
export async function serializeNmProfileModify(
	before: string,
	fields: Readonly<Record<string, string>>,
): Promise<string> {
	const password = fields["802-11-wireless-security.psk"];
	let input = before;
	if (password !== undefined) {
		const escaped = password
			.replaceAll("\\", "\\\\")
			.replaceAll(" ", "\\s")
			.replaceAll("\n", "\\n")
			.replaceAll("\r", "\\r")
			.replaceAll("\t", "\\t");
		input += `\n[wifi-security]\npsk=${escaped}\npsk-flags=0\n`;
	}
	const ordinary = Object.entries(fields).filter(
		([key]) =>
			key !== "802-11-wireless-security.psk" &&
			(password === undefined || key !== "802-11-wireless-security.psk-flags"),
	);
	return runWithStdin(
		"nmcli",
		["--offline", "connection", "modify", ...ordinary.flat()],
		input,
		{ timeout: 10000, maxBuffer: 1024 * 1024 },
	);
}

/** Display values are hints; only a coherent read matching persistent bytes hydrates a credential. */
export async function readVerifiedNmWifiSecret(
	uuid: string,
	settings: Readonly<Record<string, string>>,
): Promise<string | undefined> {
	try {
		const instance = await readNmProfileInstance(uuid, {
			...settings,
			"802-11-wireless.mode": "ap",
			"802-11-wireless-security.psk-flags": "0",
		});
		const password = (await readNmProfileFileSecret(instance?.file))?.password;
		if (password === undefined || password === "") return undefined;
		const held = await openNmProfileFile(instance?.file);
		if (!held) return undefined;
		try {
			const baseline = await serializeNmProfileModify(held.bytes.toString(), {
				"802-11-wireless-security.psk-flags": "0",
			});
			const predicted = await serializeNmProfileModify(held.bytes.toString(), {
				"802-11-wireless-security.psk": password,
			});
			const current = await openNmProfileFile(instance?.file);
			try {
				return current?.bytes.equals(held.bytes) && predicted === baseline
					? password
					: undefined;
			} finally {
				await current?.handle.close();
			}
		} finally {
			await held.handle.close();
		}
	} catch (error: unknown) {
		if (!(error instanceof Error)) throw error;
		return undefined;
	}
}

/** One dispatch's scope: only writes made inside it can leave it a receipt. */
export type NmRollbackScope = {
	readonly uuid: string;
	receipt?: NmProfileInstance | undefined;
};
const rollbackScope = new AsyncLocalStorage<NmRollbackScope>();

/** Run one dispatch so a verified rollback of its own write reaches only it. */
export function runInNmRollbackScope<T>(
	scope: NmRollbackScope,
	dispatch: () => T,
): T {
	return rollbackScope.run(scope, dispatch);
}

/** The restored bytes and the secret NM shows positively agree; unreadable is unverified. */
async function restoredSecretLoaded(
	uuid: string,
	file: NmProfileInstance["file"],
	original: Buffer,
): Promise<boolean> {
	const current = await openNmProfileFile(file);
	try {
		if (!current?.bytes.equals(original)) return false;
	} finally {
		await current?.handle.close();
	}
	const kept = await readNmProfileFileSecret(file);
	if (!kept) return false;
	const shown = (
		await nmConnGetFields(uuid, ["802-11-wireless-security.psk"] as const)
	)?.[0];
	// A keyfile without a PSK needs NM to show none; one with a PSK needs NM to show it.
	return kept.password === undefined || kept.password === ""
		? shown === ""
		: isNmWifiSecretAvailable(shown) && shown === kept.password;
}

/** Keep credentials in stdin and mode-0600 keyfiles, never the process table. */
export async function writeNmWifiSecret(
	uuid: string,
	fields: Readonly<Record<string, string>>,
	permit?: ProfileWritePermit,
): Promise<boolean> {
	const reject = (
		reason:
			| "pre-read-unverified"
			| "pre-read-fields-unreadable"
			| "pre-file-unreadable"
			| "serialization-failed"
			| "pre-write-resource-changed"
			| "publish-target-replaced"
			| "publish-proof-changed"
			| "file-publish-failed"
			| "load-failed"
			| "post-read-fields-unreadable"
			| "post-read-submitted-mismatch"
			| "post-read-secret-unreadable"
			| "post-read-unverified"
			| "post-read-failed"
			| "post-file-unreadable"
			| "post-run-changed"
			| "post-path-changed",
	): false => {
		logger.warn("NM profile write rejected", { reason });
		return false;
	};
	const scope = rollbackScope.getStore();
	if (scope?.uuid === uuid) scope.receipt = undefined;
	const beforeTrace: NmProfileReadTrace = {};
	const before = await readNmProfileInstance(uuid, undefined, beforeTrace);
	if (!before)
		return reject(
			beforeTrace.exit === "fields-unreadable"
				? "pre-read-fields-unreadable"
				: "pre-read-unverified",
		);
	if (!before.file) return reject("pre-file-unreadable");
	const filename = before.file.filename;
	const held = await openNmProfileFile(before.file);
	if (!held) return reject("pre-file-unreadable");
	const original = held.bytes;
	const expected = before.file;
	let output: string;
	try {
		output = await serializeNmProfileModify(held.bytes.toString(), fields);
	} catch (error: unknown) {
		if (!(error instanceof Error)) throw error;
		return reject("serialization-failed");
	} finally {
		await held.handle.close();
	}
	const temporary = join(
		dirname(filename),
		`.${basename(filename)}.${crypto.randomUUID()}.tmp`,
	);
	const submitted = Buffer.from(output);
	const publication = stageKeyfilePublication(expected, original, temporary);
	let stage: "file-publish-failed" | "load-failed" | "post-read-failed" =
		"file-publish-failed";
	let loaded = false;
	/*
	  Once NM may have loaded the submitted keyfile, a rejection alone would leave
	  NM on the new values while every caller keeps the old ones. Put the original
	  back (only over our own bytes) and reload it. Only a reload that succeeded,
	  read back as exactly the restored file on the same NM run and object with
	  the original settings, earns a receipt; anything less stays unverified.
	*/
	const rollBack = async (
		reason: Parameters<typeof reject>[0],
	): Promise<false> => {
		reject(reason);
		try {
			const restoredFile = publication.restore(submitted);
			if (!restoredFile) return false;
			await run("nmcli", ["connection", "load", filename]);
			const restored = await readNmProfileInstance(uuid);
			if (
				restored?.file &&
				sameNmProfileFile(restoredFile, restored.file) &&
				restored.runId === before.runId &&
				restored.path === before.path &&
				restored.fingerprint === before.fingerprint &&
				(await restoredSecretLoaded(uuid, restored.file, original))
			) {
				if (scope?.uuid === uuid) scope.receipt = restored;
				logger.warn("NM profile write rolled back");
				return false;
			}
		} catch (error: unknown) {
			if (!(error instanceof Error)) throw error;
		}
		logger.error("NM profile rollback could not be verified");
		return false;
	};
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(submitted);
			await file.sync();
		} finally {
			await file.close();
		}
		if (!sameNmProfileResource(before, await readNmProfileInstance(uuid)))
			return reject("pre-write-resource-changed");
		if (permit && (!(await permit()) || permit.current?.() === false))
			return false;
		if (!publication.publish(submitted))
			return reject("publish-target-replaced");
		if (permit && (!(await permit()) || permit.current?.() === false))
			return reject("publish-proof-changed");
		if (!publication.ownsLive(submitted))
			return reject("publish-target-replaced");
		stage = "load-failed";
		publication.beginLoad();
		loaded = true;
		await run("nmcli", ["connection", "load", filename]);
		stage = "post-read-failed";
		const trace: NmProfileReadTrace = {};
		const after = await readNmProfileInstance(
			uuid,
			{
				...fields,
				"802-11-wireless-security.psk-flags": "0",
			},
			trace,
		);
		if (!after)
			return await rollBack(
				trace.exit === "fields-unreadable"
					? "post-read-fields-unreadable"
					: trace.exit === "submitted-settings-mismatch"
						? "post-read-submitted-mismatch"
						: trace.exit === "persistent-secret-unreadable"
							? "post-read-secret-unreadable"
							: "post-read-unverified",
			);
		if (!after.file) return await rollBack("post-file-unreadable");
		if (after.runId !== before.runId) return await rollBack("post-run-changed");
		if (after.path !== before.path) return await rollBack("post-path-changed");
		if (!publication.ownsLive(submitted))
			return reject("publish-target-replaced");
		publication.commit();
		return true;
	} catch (error: unknown) {
		if (!(error instanceof Error)) throw error;
		return loaded ? await rollBack(stage) : reject(stage);
	} finally {
		await publication.finish(submitted);
	}
}
