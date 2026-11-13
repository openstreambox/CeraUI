import {
	type DeviceDetectionDeps,
	defaultDeviceDetectionDeps,
	isRealDevice,
} from "./device-detection.ts";

/** Image-owned facts, independent of the streaming engine's live capabilities. */
export type BoardCapability =
	| "client-internet"
	| "wifi-country"
	| "sim-autounlock"
	| "modem-control"
	| "os-updates"
	| "addons"
	| "kiosk"
	| "bluetooth"
	| "network-ingest"
	| "device-control"
	| "system-control"
	| "audio"
	| "fan"
	| "hw-encoder"
	| "hdmi-rx"
	| "b-key-modem";

export interface BoardIdentity {
	board: string;
	family: string;
	capabilities: ReadonlySet<string>;
}

/** Parse data only: never source release files as shell code. */
export function parseBoardIdentity(text: string): BoardIdentity | null {
	const values = new Map<string, string>();
	for (const line of text.split("\n")) {
		if (!line.trim() || line.startsWith("#")) continue;
		const match = /^([A-Z_]+)=(?:"([^"\n]*)"|([a-zA-Z0-9_. -]*))$/.exec(line);
		if (!match) return null;
		const key = match[1];
		if (!key || values.has(key)) return null;
		values.set(key, match[2] ?? match[3] ?? "");
	}
	const board = values.get("BOARD");
	const family = values.get("FAMILY");
	const capabilities = values.get("CAPABILITIES");
	const token = /^[a-z0-9][a-z0-9_-]*$/;
	if (
		values.get("ID") !== "ceralive" ||
		!board ||
		!family ||
		!token.test(board) ||
		!token.test(family) ||
		capabilities === undefined
	)
		return null;
	const names = capabilities.split(" ").filter(Boolean);
	if (!names.every((name) => /^[a-z0-9][a-z0-9-]*$/.test(name))) return null;
	return { board, family, capabilities: new Set(names) };
}

export async function hasCapability(
	capability: BoardCapability,
	deps: DeviceDetectionDeps = defaultDeviceDetectionDeps,
): Promise<boolean> {
	const override = deps.getDeviceTypeOverride();
	if (override === "emulated") return false;
	if (override === "real") return true;
	if (deps.isDevelopment()) return false;
	let identity: BoardIdentity | null = null;
	let release = "";
	try {
		release = await deps.readCeraliveRelease();
		identity = parseBoardIdentity(release);
	} catch {
		/* Older images have no record. */
	}
	if (identity) return identity.capabilities.has(capability);
	// An attempted but invalid record must not silently grant legacy permissions.
	if (/^(?:BOARD|FAMILY|CAPABILITIES)=/m.test(release)) return false;
	return isRealDevice(deps);
}
