import type { OrchestratorState } from "./types.ts";

/** Discovery has no surviving producer to reattach; both check clocks are persisted without a kind tag. */
export function normalizeStartupDiscovery(
	state: OrchestratorState,
	now: number,
	// Image apt source: installs launch only for a request in this process.
	imageSource = false,
): OrchestratorState {
	// A queued plan from an earlier process is not a request: discovery again.
	if (imageSource && state.phase === "awaiting-idle")
		return {
			...state,
			phase: "idle",
			enteredAt: now,
			progress: null,
			packageCheck: { ...state.packageCheck, nextAttemptAt: now },
		};
	switch (state.phase) {
		case "checking":
			return {
				...state,
				phase: "idle",
				enteredAt: now,
				progress: null,
				packageCheck: { ...state.packageCheck, nextAttemptAt: now },
				osCheck: { ...state.osCheck, nextAttemptAt: now },
			};
		case "idle":
		case "available":
		case "awaiting-idle":
		case "downloading":
		case "committing":
		case "restarting-services":
		case "settled":
		case "os-available":
		case "os-staging":
		case "os-staged":
		case "os-activation-armed":
		case "os-verifying":
		case "kernel-downloading":
		case "kernel-staging":
		case "kernel-staged":
		case "kernel-verifying":
		case "kernel-succeeded":
		case "kernel-rolled-back":
		case "kernel-failed":
		case "sync-eligible":
		case "syncing":
		case "synced":
		case "quarantined":
		case "failed":
			return state;
		default: {
			const unreachable: never = state.phase;
			return unreachable;
		}
	}
}
