import { logger } from "../../helpers/logger.ts";
import { acquireLogindInhibitor } from "./logind-inhibitor.ts";
import {
	createShutdownInhibitor,
	type InhibitorOwner,
} from "./shutdown-inhibitor.ts";

let protection: ReturnType<typeof createShutdownInhibitor> | undefined;
let encoder = false;
let carrying = false;
export function setShutdownProtection(
	owner: InhibitorOwner,
	active: boolean,
): boolean {
	if (owner === "encoder") encoder = active;
	else carrying = active;
	const ok = protection?.set(owner, active) ?? true;
	if (!ok)
		logger.warn("Shutdown protection unavailable; stream start will wait");
	return ok;
}
/** Admission owns only the lease it introduces; retained startup/cleanup owners survive. */
export function ensureEncoderShutdownProtection(): boolean {
	const retainedEncoder = encoder;
	if (setShutdownProtection("encoder", true)) return true;
	if (!retainedEncoder) setShutdownProtection("encoder", false);
	return false;
}

export function initShutdownProtection(acquire = acquireLogindInhibitor): void {
	if (protection) return;
	protection = createShutdownInhibitor(acquire);
	process.once("exit", () => protection?.dispose());
	// Seed both owners even when logind is not ready. Later publication retries.
	const encoderReady = protection.set("encoder", encoder);
	const carryingReady = protection.set("carrying", carrying);
	if (!encoderReady || !carryingReady)
		logger.warn(
			"Shutdown protection unavailable at startup; retaining owners for retry",
		);
}
