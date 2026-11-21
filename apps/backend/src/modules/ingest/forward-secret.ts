import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import { logger } from "../../helpers/logger.ts";

/** Use the shared private publisher: mode is enforced before writing bytes. */
export async function writeForwardFile(
	path: string,
	contents: string,
): Promise<void> {
	writeFileAtomicSync(path, contents, { mode: 0o600 });
}

export async function readForwardSecret(
	path: string,
): Promise<string | undefined> {
	let file: Awaited<ReturnType<typeof open>>;
	try {
		file = await open(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	try {
		const stat = await file.stat();
		if (!stat.isFile() || (stat.mode & 0o077) !== 0)
			throw Error("forward_secret_permissions");
		if (stat.size > 81) return;
		const secret = (await file.readFile("utf8")).trim();
		if (
			secret.length < 10 ||
			secret.length > 79 ||
			[...secret].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
		)
			return;
		return secret;
	} finally {
		await file.close();
	}
}

/** Invalid private regular files are recoverable; unsafe paths are refused. */
export async function loadForwardSecret(
	path: string,
	generated: string,
	replacedLegacyPath?: string,
): Promise<string> {
	const existing = await readForwardSecret(path);
	if (existing !== undefined) return existing;
	const exists = (candidate: string) =>
		lstat(candidate).then(
			() => true,
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return false;
				throw error;
			},
		);
	const damaged =
		(await exists(path)) ||
		(replacedLegacyPath !== undefined && (await exists(replacedLegacyPath)));
	await writeForwardFile(path, generated);
	if (damaged) logger.warn("SRT forwarding credential regenerated");
	return generated;
}
