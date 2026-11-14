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
