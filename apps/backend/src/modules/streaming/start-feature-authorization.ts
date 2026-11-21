/**
 * Fields of a stream start that only some engines accept, checked against the
 * engine that receives the request. Start parameters are assembled before the
 * engine connection opens, from the last capability snapshot, which may come
 * from an earlier engine. A field the receiving engine does not advertise is
 * dropped with a warning, like other start residue; the saved config keeps it.
 */
import type { StartParams } from "@ceralive/cerastream";
import {
	type CapabilitiesMessage,
	COMPOSITION_FEATURE,
	COMPOSITION_GEOMETRY_FEATURE,
} from "@ceraui/rpc/schemas";

interface AuthorizationLogger {
	warn(message: string, meta?: unknown): void;
}

/** Whether the start carries a field that needs the receiving engine's word. */
export function carriesGatedStartFields(params: StartParams): boolean {
	return params.audio?.inputs !== undefined || params.composition !== undefined;
}

/**
 * Drop gated fields the receiving engine has not advertised. `caps` must be a
 * snapshot read on that engine's connection; `undefined` proves nothing, so
 * every gated field is dropped.
 */
export function authorizeStartFeatures(
	params: StartParams,
	caps: CapabilitiesMessage | undefined,
	logger: AuthorizationLogger,
): StartParams {
	let authorized = params;
	if (params.audio?.inputs !== undefined && !caps?.audio_mix) {
		logger.warn(
			"start: dropping the audio mix — the receiving engine has not advertised it",
			{ module: "streaming", inputs: params.audio.inputs.length },
		);
		const { inputs: _dropped, ...audio } = params.audio;
		authorized = { ...authorized, audio };
	}
	const composition = params.composition;
	if (composition !== undefined) {
		const features = caps?.features ?? [];
		const custom =
			composition.layout === "custom" || composition.rect !== undefined;
		const reason = !features.includes(COMPOSITION_FEATURE)
			? "start: dropping composition — the receiving engine has not advertised it"
			: custom && !features.includes(COMPOSITION_GEOMETRY_FEATURE)
				? "start: dropping the custom composition layout — the receiving engine only advertises preset layouts"
				: undefined;
		if (reason !== undefined) {
			logger.warn(reason, {
				module: "streaming",
				dropped: composition.layout,
			});
			const { composition: _dropped, ...rest } = authorized;
			authorized = rest;
		}
	}
	return authorized;
}
