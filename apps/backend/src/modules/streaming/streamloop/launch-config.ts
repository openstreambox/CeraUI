import { AUDIO_SOURCE_AUTO } from "@ceraui/rpc/schemas";
import type { RuntimeConfig } from "../../../helpers/config-schemas.ts";
import {
	launchAsrcFor,
	resolveAutoAsrcFromLiveState,
	setResolvedAsrcFromStart,
} from "../auto-audio.ts";

// Only the resolved audio pick crosses the launch boundary, not its input config.
export function resolveLaunchAsrc({
	asrc,
	source,
}: Pick<RuntimeConfig, "asrc" | "source">) {
	if (asrc !== AUDIO_SOURCE_AUTO) return { chosen: asrc, publish: undefined };
	const resolution = resolveAutoAsrcFromLiveState(source ?? null);
	return {
		chosen: launchAsrcFor(resolution),
		publish: () =>
			setResolvedAsrcFromStart(
				resolution.asrcKey,
				resolution.reason,
				resolution.candidates,
			),
	};
}
