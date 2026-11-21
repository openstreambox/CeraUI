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
export function ensureEncoderShutdownProtection(
	current: () => boolean = () => true,
	signal?: AbortSignal,
): boolean | Promise<boolean> {
	const retainedEncoder = encoder;
	let released = false;
	const releaseFreshOwner = () => {
		if (released) return;
		released = true;
		if (!retainedEncoder) setShutdownProtection("encoder", false);
	};
	signal?.addEventListener("abort", releaseFreshOwner, { once: true });
	if (signal?.aborted) return false;
	if (setShutdownProtection("encoder", true)) return true;
	const finish = () => {
		if (protection?.confirmed() && current() && !signal?.aborted) return true;
		releaseFreshOwner();
		return false;
	};
	const pending = protection?.pending();
	return pending ? pending.then(finish) : finish();
}

export function initShutdownProtection(
	acquire: Parameters<
		typeof createShutdownInhibitor
	>[0] = acquireLogindInhibitor,
): void {
	if (protection) return;
	protection = createShutdownInhibitor(acquire);
	process.once("exit", () => protection?.dispose());
	// Seed both owners even when logind is not ready. Later publication retries.
	const installed = protection;
	const encoderReady = installed.set("encoder", encoder);
	const carryingReady = installed.set("carrying", carrying);
	if (encoderReady && carryingReady) return;
	const warnUnavailable = () =>
		logger.warn(
			"Shutdown protection unavailable at startup; retaining owners for retry",
		);
	// An active owner starts an asynchronous logind request, so set() reports
	// false until it answers. Only a request that fails is worth a warning.
	const pending = installed.pending();
	if (!pending) {
		warnUnavailable();
		return;
	}
	const reportSettled = () => {
		if (protection !== installed || installed.confirmed()) return;
		if (encoder || carrying) warnUnavailable();
	};
	void pending.then(reportSettled, reportSettled);
}

/** Test seam: drop the installed inhibitor and both owners. */
export function resetShutdownProtectionForTest(): void {
	protection?.dispose();
	protection = undefined;
	encoder = false;
	carrying = false;
}
