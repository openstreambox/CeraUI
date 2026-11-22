import { type PhoneWay, phoneWaySchema } from "@ceraui/rpc/schemas";
import { writeFileAtomicSync } from "../../helpers/config-loader";
import { logger } from "../../helpers/logger";
import {
	readStoredStateFile,
	STORED_STATE_LIMITS,
	StoredStateReadError,
} from "./update-orchestrator/stored-state-file";

const FILE =
	process.env.NODE_ENV === "development"
		? "phone-way.json"
		: "/data/phone-way.json";
export async function readPhoneWay(path = FILE): Promise<PhoneWay | null> {
	let stored: unknown;
	try {
		const raw = await readStoredStateFile(path, STORED_STATE_LIMITS.settings);
		if (raw === null) return null;
		stored = JSON.parse(raw);
	} catch (error) {
		// An empty, truncated, non-UTF-8, oversize or non-regular file is the same
		// as no saved choice. Other read errors (a file that changed under the
		// read, an I/O failure) still propagate.
		const unusable =
			error instanceof SyntaxError ||
			(error instanceof StoredStateReadError &&
				(error.reason === "oversize" || error.reason === "not_regular_file"));
		if (!unusable) throw error;
		logger.warn("phone way file is unusable, ignoring it");
		return null;
	}
	const way =
		typeof stored === "object" && stored !== null
			? (stored as { way?: unknown }).way
			: undefined;
	const value = phoneWaySchema.safeParse(way);
	return value.success ? value.data : null;
}
export async function writePhoneWay(way: PhoneWay, path = FILE): Promise<void> {
	writeFileAtomicSync(path, JSON.stringify({ way: phoneWaySchema.parse(way) }));
}
