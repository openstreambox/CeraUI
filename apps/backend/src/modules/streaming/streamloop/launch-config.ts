import { AUDIO_SOURCE_AUTO } from "@ceraui/rpc/schemas";
import type { RuntimeConfig } from "../../../helpers/config-schemas.ts";
import {
	buildAutoLaunchConfig,
	resolveAutoAsrcFromLiveState,
	setResolvedAsrcFromStart,
} from "../auto-audio.ts";

// "Auto" resolves at launch in a shallow copy; persisted config keeps its sentinel.
export function resolveLaunchConfig(config: RuntimeConfig) {
	if (config.asrc !== AUDIO_SOURCE_AUTO) return { config, publish: undefined };
	const resolution = resolveAutoAsrcFromLiveState(config.source ?? null);
	return {
		config: buildAutoLaunchConfig(config, resolution),
		publish: () =>
			setResolvedAsrcFromStart(
				resolution.asrcKey,
				resolution.reason,
				resolution.candidates,
			),
	};
}
