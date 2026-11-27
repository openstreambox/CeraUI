import type { UpdateSettings } from "@ceraui/rpc/schemas";
import {
	getLastRemoteCommandAt,
	hasActiveRemoteSession,
} from "../remote-control/command-router.ts";
import { currentLifecycleHolder } from "../streaming/lifecycle-admission.ts";
import { getActivePreviewProxyCount } from "../ui/preview-proxy.ts";
import { carryingTracker, getCarryingLiveness } from "./carrying.ts";
import { evaluateIdle, type IdleEvaluation } from "./idle-detector.ts";
import {
	getIdleMemory,
	IdleStateReadError,
	loadIdleState,
} from "./idle-state.ts";
import { isStreamConfirmedIdle } from "./stream-liveness-source.ts";

export { noteUiHeartbeat, setIdleStateFilePathForTest } from "./idle-state.ts";

export async function getIdleStatus(input: {
	readonly now: number;
	readonly schedule: UpdateSettings["schedule"];
}): Promise<IdleEvaluation> {
	let lastStreamEndedAt: number | null;
	try {
		lastStreamEndedAt = await loadIdleState();
	} catch (error) {
		if (!(error instanceof IdleStateReadError)) throw error;
		return { idle: false, since: null, blockers: [error.reason] };
	}
	const memory = getIdleMemory();
	const monoNow = performance.now();
	const carryAt = carryingTracker.activityAt(monoNow);
	return evaluateIdle({
		now: input.now,
		idleMinutes: 30,
		schedule: input.schedule,
		lastActivity: {
			carrying:
				getCarryingLiveness() !== "idle"
					? input.now
					: carryAt === null
						? null
						: input.now - (monoNow - carryAt),
			// Unknown liveness is current activity: only confirmed idle ages it.
			stream: !isStreamConfirmedIdle()
				? input.now
				: Math.max(lastStreamEndedAt ?? 0, memory.bootAt),
			preview: getActivePreviewProxyCount() > 0 ? input.now : memory.preview,
			remote: hasActiveRemoteSession(input.now)
				? input.now
				: getLastRemoteCommandAt(),
			ui: memory.ui,
			startLease:
				currentLifecycleHolder() === "streaming"
					? input.now
					: memory.startLease,
		},
	});
}
