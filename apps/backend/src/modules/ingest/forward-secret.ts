import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Persist generated credentials separately from image-baked setup metadata. */
export async function loadForwardSecret(
	path: string,
	generated: string,
): Promise<string> {
	try {
		const file = await open(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
			0o600,
		);
		try {
			await file.writeFile(generated);
		} finally {
			await file.close();
		}
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
			throw error;
	}
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 79)
			throw Error("forward_secret_permissions");
		const secret = await file.readFile("utf8");
		if (secret.length < 10 || secret.length > 79)
			throw Error("forward_secret_invalid");
		return secret;
	} finally {
		await file.close();
	}
}
