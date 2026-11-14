import type { StreamLiveness } from "./disruptive-action-gate.ts";
import { getStreamLiveness } from "./stream-liveness-source.ts";

export type IdleAction =
	| "update"
	| "home-ap-pause"
	| "home-cellular-exclusion"
	| "heat-idle-rest";

/** All idle-only consumers must check again immediately before mutation.
 * Heat's emergency safety limits remain independent of this idle permission. */
export function idleActionPolicy(
	action: IdleAction,
	liveness: StreamLiveness = getStreamLiveness(),
): { allowed: true } | { allowed: false; message: string } {
	if (liveness === "idle") return { allowed: true };
	const purpose = {
		update: "The update will wait",
		"home-ap-pause": "Wi-Fi will stay available",
		"home-cellular-exclusion": "The SIM links will stay available",
		"heat-idle-rest": "The links will stay available",
	}[action];
	return {
		allowed: false,
		message:
			liveness === "streaming"
				? `${purpose} while the box carries a stream.`
				: `${purpose} while the box checks stream activity.`,
	};
}
