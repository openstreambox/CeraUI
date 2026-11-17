import type { PowerFailureReason } from "@ceraui/rpc";
import { logger } from "../../helpers/logger.ts";
import { notePlannedShutdown } from "../streaming/armed-stream-marker.ts";
import { notifyDisruptiveActionRefused } from "./disruptive-action-refusal.ts";
import {
	classifyPowerFailure,
	isPositiveDisruptiveFailure,
	PowerSubmissionError,
	reservePowerAction,
} from "./disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "./disruptive-action-runtime.ts";

export function submitPowerCommand(
	command: "reboot" | "poweroff",
	runner: (command: "reboot" | "poweroff") => void,
): { success: boolean; error?: string; failureReason?: PowerFailureReason } {
	const admission = reservePowerAction(
		getDisruptiveActionDecision({ powerAction: command }),
		command,
	);
	if (!admission.allowed) {
		notifyDisruptiveActionRefused(admission.reason);
		return { success: false, error: admission.reason };
	}
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
			failureReason:
				error instanceof PowerSubmissionError
					? classifyPowerFailure(error.exitCode, error.stderr)
					: "shutdown_unavailable",
			error: error instanceof Error ? error.message : "power_submission_failed",
		};
	}
}
