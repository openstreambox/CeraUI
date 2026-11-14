import { logger } from "../../helpers/logger.ts";
import { notePlannedShutdown } from "../streaming/armed-stream-marker.ts";
import { notifyDisruptiveActionRefused } from "./disruptive-action-refusal.ts";
import {
	isPositiveDisruptiveFailure,
	reservePowerAction,
} from "./disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "./disruptive-action-runtime.ts";

export function submitPowerCommand(
	command: "reboot" | "poweroff",
	runner: (command: "reboot" | "poweroff") => void,
	options?: { readonly acceptCarryingCost?: boolean },
): { success: boolean; error?: string } {
	const admission = reservePowerAction(
		getDisruptiveActionDecision({
			powerAction: command,
			acceptCarryingCost:
				command === "reboot" && options?.acceptCarryingCost === true,
		}),
		command,
	);
	if (!admission.allowed) {
		notifyDisruptiveActionRefused(admission.reason);
		return { success: false, error: admission.reason };
	}
	if (command === "reboot" && options?.acceptCarryingCost === true)
		logger.info("System: restart confirmed with its cost to a carried stream");
	let effectInvoked = false;
	try {
		notePlannedShutdown(command);
		effectInvoked = true;
		runner(command);
		admission.reservation.releaseAfterCompletion();
		return { success: true };
	} catch (error) {
		if (!effectInvoked || isPositiveDisruptiveFailure(error))
			admission.reservation.releaseAfterFailure();
		logger.error("System power submission failed", { command, error });
		return {
			success: false,
			error: error instanceof Error ? error.message : "power_submission_failed",
		};
	}
}
