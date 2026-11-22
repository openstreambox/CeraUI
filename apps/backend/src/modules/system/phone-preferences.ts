import { type PhoneWay, phoneWaySchema } from "@ceraui/rpc/schemas";
import { writeFileAtomicSync } from "../../helpers/config-loader";
import { logger } from "../../helpers/logger";
import {
	readStoredStateFile,
	STORED_STATE_LIMITS,
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
		// An empty, truncated or non-UTF-8 file is the same as no saved choice.
		if (!(error instanceof SyntaxError)) throw error;
		logger.warn("phone way file is not valid JSON, ignoring it");
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
