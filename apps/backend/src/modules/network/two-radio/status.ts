import fs from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateStatusSync } from "../../../helpers/config-loader.ts";

/** Disposable diagnostics belong on tmpfs, separate from the durable journal. */
export function statusPath(): string {
	return join(
		process.env.CERALIVE_RUN_DIR ?? "/run/ceralive",
		"two-radio",
		"status.json",
	);
}

export function publishStatus(view: unknown): void {
	const file = statusPath();
	fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	writePrivateStatusSync(file, JSON.stringify(view));
}

/** One best-effort migration per startup, including when live mode is disabled.
 * The containing config directory is service-owned. lstat never follows links;
 * unlink removes the entry itself and never reads or modifies a linked target.
 */
export function removeLegacyStatus(
	directory: string,
	log: (message: string) => void,
): void {
	const file = join(directory, "status.json");
	try {
		if (!fs.lstatSync(file).isFile()) return;
		fs.unlinkSync(file);
		log("Removed legacy two-radio diagnostic status");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			log("Could not remove legacy two-radio diagnostic status");
	}
}
