import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Publish only fully written, durable private bytes, then persist the rename. */
export async function writeForwardFile(
	path: string,
	contents: string,
): Promise<void> {
	const dir = dirname(path);
	const temp = join(
		dir,
		`.${basename(path)}.${crypto.randomUUID()}.${process.pid}.tmp`,
	);
	try {
		const file = await open(
			temp,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
			0o600,
		);
		try {
			await file.writeFile(contents);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temp, path);
		const directory = await open(
			dir,
			constants.O_RDONLY | constants.O_DIRECTORY,
		);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		await unlink(temp).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
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
): Promise<string> {
	const existing = await readForwardSecret(path);
	if (existing !== undefined) return existing;
	await writeForwardFile(path, generated);
	return generated;
}
