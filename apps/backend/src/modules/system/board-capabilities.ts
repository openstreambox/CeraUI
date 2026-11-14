import { readFileSync } from "node:fs";
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

function parseReleaseValues(text: string): Map<string, string> | null {
	const values = new Map<string, string>();
	for (const line of text.split("\n")) {
		if (!line.trim() || line.startsWith("#")) continue;
		const match = /^([A-Z_]+)=(?:"([^"\n]*)"|([a-zA-Z0-9_. -]*))$/.exec(line);
		if (!match) return null;
		const key = match[1];
		if (!key || values.has(key)) return null;
		values.set(key, match[2] ?? match[3] ?? "");
	}
	return values;
}

/** Parse data only: never source release files as shell code. */
export function parseBoardIdentity(text: string): BoardIdentity | null {
	const values = parseReleaseValues(text);
	if (!values) return null;
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

function recordCapability(
	release: string,
	capability: BoardCapability,
): boolean | undefined {
	const identity = parseBoardIdentity(release);
	if (identity) return identity.capabilities.has(capability);
	const values = parseReleaseValues(release);
	if (
		!values ||
		["BOARD", "FAMILY", "CAPABILITIES"].some((key) => values.has(key))
	)
		return false;
	return undefined;
}

export async function hasCapability(
	capability: BoardCapability,
	deps: DeviceDetectionDeps = defaultDeviceDetectionDeps,
): Promise<boolean> {
	const override = deps.getDeviceTypeOverride();
	if (override === "emulated") return false;
	if (override === "real") return true;
	if (deps.isDevelopment()) return false;
	let release = "";
	try {
		release = await deps.readCeraliveRelease();
	} catch {
		/* Older images have no record. */
	}
	const grant = recordCapability(release, capability);
	if (grant !== undefined) return grant;
	return isRealDevice(deps);
}

export const boardAdmissionDeps = {
	readRelease: () => readFileSync("/etc/ceralive/release", "utf8"),
};

/** Synchronous submission fence; legacy branding-only images retain their regime. */
export function isBoardCapabilityDenied(capability: BoardCapability): boolean {
	const override = defaultDeviceDetectionDeps.getDeviceTypeOverride();
	if (override === "emulated") return true;
	if (override === "real") return false;
	if (defaultDeviceDetectionDeps.isDevelopment()) return false;
	let release: string;
	try {
		release = boardAdmissionDeps.readRelease();
	} catch {
		return false;
	}
	return recordCapability(release, capability) === false;
}
