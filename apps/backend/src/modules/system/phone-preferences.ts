import { type PhoneWay, phoneWaySchema } from "@ceraui/rpc/schemas";
import { writeFileAtomicSync } from "../../helpers/config-loader";
import {
	readStoredStateFile,
	STORED_STATE_LIMITS,
} from "./update-orchestrator/stored-state-file";

const FILE =
	process.env.NODE_ENV === "development"
		? "phone-way.json"
		: "/data/phone-way.json";
export async function readPhoneWay(path = FILE): Promise<PhoneWay | null> {
	const raw = await readStoredStateFile(path, STORED_STATE_LIMITS.settings);
	if (raw === null) return null;
	const value = phoneWaySchema.safeParse(JSON.parse(raw).way);
	return value.success ? value.data : null;
}
export async function writePhoneWay(way: PhoneWay, path = FILE): Promise<void> {
	writeFileAtomicSync(path, JSON.stringify({ way: phoneWaySchema.parse(way) }));
}
