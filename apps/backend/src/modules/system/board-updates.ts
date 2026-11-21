import { parseBoardIdentity, recordCapability } from "./board-capabilities.ts";
import { defaultDeviceDetectionDeps } from "./device-detection.ts";

export interface BoardUpdates {
	readonly board: string;
	readonly compatible: string;
	readonly family: string;
	readonly architecture: "arm64" | "amd64";
}

/** undefined is a legacy image; null is an explicit unsupported/invalid record. */
export function resolveBoardUpdates(
	text: string,
): BoardUpdates | null | undefined {
	if (recordCapability(text, "os-updates") === false) return null;
	if (
		!/^\s*(?:BOARD|FAMILY|CAPABILITIES|UPDATE_BOARD|UPDATE_COMPATIBLE|KERNEL_ARCH)\s*=/m.test(
			text,
		)
	)
		return undefined;
	const identity = parseBoardIdentity(text);
	if (!identity?.capabilities.has("os-updates")) return null;
	const field = (key: string) =>
		new RegExp(`^${key}=([a-z0-9_-]*)$`, "m").exec(text)?.[1];
	const board = field("UPDATE_BOARD");
	const compatible = field("UPDATE_COMPATIBLE");
	const architecture = field("KERNEL_ARCH");
	if (
		!board ||
		!compatible ||
		(architecture !== "arm64" && architecture !== "amd64")
	)
		return null;
	return { board, compatible, family: identity.family, architecture };
}

export async function readBoardUpdates(): Promise<
	BoardUpdates | null | undefined
> {
	let text: string;
	try {
		text = await defaultDeviceDetectionDeps.readCeraliveRelease();
	} catch {
		return undefined;
	}
	return resolveBoardUpdates(text);
}
