import { createHash } from "node:crypto";
import { accessCellularAuthority } from "./cellular-authority-store.ts";
export interface CarrierIntentIdentity {
	readonly uuid: string;
	readonly deviceId: string;
	readonly simId: string;
}
export interface CarrierIntent {
	readonly version: 1;
	readonly key: string;
	readonly mode: "automatic" | "manual";
	readonly phase: "pending" | "applied";
	readonly appliedApn?: string;
	readonly pendingApn?: string;
}
export interface CarrierIntentStore {
	readonly dir: string;
}
const defaultStore: CarrierIntentStore = {
	get dir() {
		return (
			process.env.CERALIVE_AUTOMATIC_CARRIER_STATE_DIR ??
			"/data/ceralive/automatic-carrier-intent"
		);
	},
};

export function carrierIntentKey(identity: CarrierIntentIdentity): string {
	const parts = [identity.uuid, identity.deviceId, identity.simId];
	if (parts.some((value) => !value || value.length > 1024))
		throw new Error("Unresolved carrier intent identity");
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
export function parseCarrierIntentSlot(
	value: unknown,
	key: string,
): CarrierIntent {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid carrier intent");
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).some(
			(name) =>
				![
					"version",
					"key",
					"mode",
					"phase",
					"appliedApn",
					"pendingApn",
				].includes(name),
		) ||
		record.version !== 1 ||
		record.key !== key ||
		(record.mode !== "automatic" && record.mode !== "manual") ||
		(record.phase !== "pending" && record.phase !== "applied") ||
		(record.pendingApn !== undefined &&
			(typeof record.pendingApn !== "string" ||
				!/^[a-zA-Z0-9._-]{0,100}$/.test(record.pendingApn))) ||
		(record.appliedApn !== undefined &&
			(typeof record.appliedApn !== "string" ||
				!/^[a-zA-Z0-9._-]{1,100}$/.test(record.appliedApn)))
	)
		throw new Error("Invalid carrier intent");
	return {
		version: 1,
		key,
		mode: record.mode,
		phase: record.phase as CarrierIntent["phase"],
		...(typeof record.pendingApn === "string"
			? { pendingApn: record.pendingApn }
			: {}),
		...(typeof record.appliedApn === "string"
			? { appliedApn: record.appliedApn }
			: {}),
	};
}

export async function readCarrierIntent(
	identity: CarrierIntentIdentity,
	store: CarrierIntentStore = defaultStore,
): Promise<CarrierIntent | undefined> {
	const key = carrierIntentKey(identity);
	return accessCellularAuthority(
		"automatic-carrier-intent",
		key,
		parseCarrierIntentSlot,
		async (value) => value,
		store === defaultStore
			? process.env.CERALIVE_AUTOMATIC_CARRIER_STATE_DIR
			: store.dir,
		store === defaultStore,
	);
}
/** Call under the modem lifecycle lease; never use this record as carrier identity. */
export async function writeCarrierIntent(
	identity: CarrierIntentIdentity,
	intent: CarrierIntent | undefined,
	store: CarrierIntentStore = defaultStore,
): Promise<void> {
	const key = carrierIntentKey(identity);
	if (intent) parseCarrierIntentSlot(intent, key);
	await accessCellularAuthority(
		"automatic-carrier-intent",
		key,
		parseCarrierIntentSlot,
		async (_value, write) => write(intent),
		store === defaultStore
			? process.env.CERALIVE_AUTOMATIC_CARRIER_STATE_DIR
			: store.dir,
		store === defaultStore,
	);
}

export function newCarrierIntent(
	identity: CarrierIntentIdentity,
	mode: CarrierIntent["mode"],
	appliedApn?: string,
): CarrierIntent {
	return {
		version: 1,
		key: carrierIntentKey(identity),
		mode,
		phase: mode === "manual" || appliedApn ? "applied" : "pending",
		...(appliedApn ? { appliedApn } : {}),
	};
}

/** Expected NM APN is a conflict witness while automatic provider lookup is pending. */
export function newPendingCarrierIntent(
	identity: CarrierIntentIdentity,
	apn: string,
): CarrierIntent {
	const intent = {
		...newCarrierIntent(identity, "automatic"),
		pendingApn: apn,
	};
	parseCarrierIntentSlot(intent, intent.key);
	return intent;
}
/** A remembered APN is only a conflict witness; subscription evidence selects policy. */
export function effectiveCarrierAutomatic(
	intent: CarrierIntent | undefined,
	nmAutomatic: boolean,
	apn: string,
): boolean {
	if (!intent) return nmAutomatic;
	if (intent.mode === "manual") return false;
	if (intent.phase === "pending")
		return (
			intent.pendingApn === undefined ||
			nmAutomatic ||
			intent.pendingApn === apn
		);
	return (
		nmAutomatic ||
		(intent.appliedApn !== undefined && intent.appliedApn === apn)
	);
}

export function parseCarrierIntent(
	identity: CarrierIntentIdentity,
	value: unknown,
): CarrierIntent {
	return parseCarrierIntentSlot(value, carrierIntentKey(identity));
}

export function sameCarrierIntent(
	a: CarrierIntent | undefined,
	b: CarrierIntent | undefined,
): boolean {
	return (
		a?.version === b?.version &&
		a?.key === b?.key &&
		a?.mode === b?.mode &&
		a?.phase === b?.phase &&
		a?.appliedApn === b?.appliedApn &&
		a?.pendingApn === b?.pendingApn
	);
}
