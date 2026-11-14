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
export function initShutdownProtection(acquire = acquireLogindInhibitor): void {
	if (protection) return;
	protection = createShutdownInhibitor(acquire);
	process.once("exit", () => protection?.dispose());
	if (
		!protection.set("encoder", encoder) ||
		!protection.set("carrying", carrying)
	)
		throw new Error("Cannot establish shutdown protection");
}
