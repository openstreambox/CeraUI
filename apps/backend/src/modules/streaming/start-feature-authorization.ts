/**
 * Fields of a stream start that only some engines accept, checked against the
 * engine that receives the request. Start parameters are assembled before the
 * engine connection opens, from the last capability snapshot, which may come
 * from an earlier engine. A field the receiving engine does not advertise is
 * dropped; the saved config keeps it, and the caller tells the operator.
 */
import type { StartParams } from "@ceralive/cerastream";
import {
	type CapabilitiesMessage,
	COMPOSITION_FEATURE,
	COMPOSITION_GEOMETRY_FEATURE,
} from "@ceraui/rpc/schemas";

import { compositionNeedsGeometry } from "./composition.ts";

interface AuthorizationLogger {
	warn(message: string, meta?: unknown): void;
}

/** A configured start feature the receiving engine did not get. */
export type DroppedStartFeature = "audio-mix" | "composition" | "custom-layout";

/** Whether the start carries a field that needs the receiving engine's word. */
export function carriesGatedStartFields(params: StartParams): boolean {
	return params.audio?.inputs !== undefined || params.composition !== undefined;
}

/**
 * Drop gated fields the receiving engine has not advertised. `caps` must be the
 * receiving engine's own answer; `undefined` (no answer in time, or a failed
 * read) proves nothing, so every gated field is dropped. A dropped mix falls
 * back to `audioWithoutMix`, the single-input audio the same config would send
 * without a mix (start assembly replaces the selected device when it adds mixer
 * inputs, so stripping `inputs` alone would leave the engine's default device).
 */
export function authorizeStartFeatures(
	params: StartParams,
	caps: Pick<CapabilitiesMessage, "features" | "audio_mix"> | undefined,
	audioWithoutMix: StartParams["audio"],
	logger: AuthorizationLogger,
): { params: StartParams; dropped: DroppedStartFeature[] } {
	const dropped: DroppedStartFeature[] = [];
	let authorized = params;
	if (params.audio?.inputs !== undefined && !caps?.audio_mix) {
		logger.warn(
			"start: dropping the audio mix — the receiving engine has not advertised it",
			{
				module: "streaming",
				inputs: params.audio.inputs.length,
				evidence: caps === undefined ? "none" : "engine",
			},
		);
		const { audio: _mixed, ...rest } = authorized;
		authorized =
			audioWithoutMix === undefined
				? rest
				: { ...rest, audio: audioWithoutMix };
		dropped.push("audio-mix");
	}
	const composition = params.composition;
	if (composition !== undefined) {
		const features = caps?.features ?? [];
		const drop: DroppedStartFeature | undefined = !features.includes(
			COMPOSITION_FEATURE,
		)
			? "composition"
			: compositionNeedsGeometry(composition) &&
					!features.includes(COMPOSITION_GEOMETRY_FEATURE)
				? "custom-layout"
				: undefined;
		if (drop !== undefined) {
			logger.warn(
				drop === "composition"
					? "start: dropping composition — the receiving engine has not advertised it"
					: "start: dropping the custom composition layout — the receiving engine only advertises preset layouts",
				{
					module: "streaming",
					dropped: composition.layout,
					evidence: caps === undefined ? "none" : "engine",
				},
			);
			const { composition: _dropped, ...rest } = authorized;
			authorized = rest;
			dropped.push(drop);
		}
	}
	return { params: authorized, dropped };
}

/** Operator-facing text for a start that left configured features out. */
export function droppedStartFeaturesMessage(
	dropped: readonly DroppedStartFeature[],
	answered: boolean,
): string {
	const parts = dropped.map((feature) =>
		feature === "audio-mix"
			? "the audio mix (the stream uses the selected audio input)"
			: feature === "custom-layout"
				? "the custom layout"
				: "the picture-in-picture composition",
	);
	const what =
		parts.length === 1
			? parts[0]
			: `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
	const why = answered
		? `the streaming engine does not support ${parts.length === 1 ? "it" : "them"}`
		: "the streaming engine did not confirm support in time";
	return `Streaming without ${what}: ${why}. Your saved settings are kept.`;
}
