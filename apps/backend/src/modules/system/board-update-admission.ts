import { readFileSync } from "node:fs";
import { recordCapability } from "./board-capabilities.ts";

const defaultRead = () => readFileSync("/etc/ceralive/release", "utf8");
let readRelease = defaultRead;
export function setUpdateReleaseReaderForTest(
	read: (() => string) | null,
): void {
	readRelease = read ?? defaultRead;
}

/** Explicit record denial must never select the legacy unguarded update path. */
export function boardUpdateAdmissionAllowed(): boolean {
	let text: string;
	try {
		text = readRelease();
	} catch {
		return true;
	}
	const verdict = recordCapability(text, "os-updates");
	if (verdict !== undefined) return verdict;
	// Update metadata without a board identity is incomplete, not legacy branding.
	return !/^(?:UPDATE_BOARD|UPDATE_COMPATIBLE|KERNEL_ARCH)=/m.test(text);
}
export function assertBoardUpdateAdmission(): void {
	if (!boardUpdateAdmissionAllowed())
		throw new Error("board_updates_not_offered");
}
