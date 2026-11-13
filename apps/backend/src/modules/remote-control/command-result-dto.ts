import {
	audioBackendSchema,
	audioCodecSchema,
	framerateSchema,
	hardwareTypeSchema,
	previewEncodeModeSchema,
	resolutionSchema,
	streamRecoveryPreferenceSchema,
	videoCodecSchema,
	videoPassthroughSchema,
} from "@ceraui/rpc/schemas";

// Command acknowledgements have their own contract; status reduction is unrelated.
function scalarAcknowledgement(v: unknown) {
	const src = obj(v),
		out: Record<string, unknown> = {};
	for (const key of [
		"max_br",
		"srt_latency",
		"delay",
		"bitrate_overlay",
		"slot",
	])
		if (typeof src[key] === "number" && Number.isFinite(src[key]))
			out[key] = src[key];
	for (const key of ["fec_enabled", "autostart", "dhcp", "roaming"])
		if (typeof src[key] === "boolean") out[key] = src[key];
	if (Array.isArray(src.bands))
		out.bands = src.bands.filter(
			(n) => Number.isSafeInteger(n) && n >= 0 && n <= 1024,
		);
	return out;
}

import type { ResultPayload } from "./protocol.ts";

const obj = (v: unknown): Record<string, unknown> =>
	v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};

import { VIDEO_SOURCE_IDS } from "../streaming/pipeline-sources.ts";

const PIPELINES = new Set<string>(VIDEO_SOURCE_IDS);
function configDTO(v: unknown) {
	const src = obj(v),
		out = obj(scalarAcknowledgement(v));
	for (const [key, allowed] of Object.entries({
		pipeline: [...PIPELINES],
		acodec: audioCodecSchema.options,
		audio_backend: audioBackendSchema.options,
		recovery_mode: streamRecoveryPreferenceSchema.options,
		video_codec: videoCodecSchema.options,
		video_passthrough: videoPassthroughSchema.options,
		previewEncode: previewEncodeModeSchema.options,
	}))
		if (allowed.includes(src[key] as never)) out[key] = src[key];
	for (const [key, schema] of [
		["resolution", resolutionSchema],
		["framerate", framerateSchema],
	] as const) {
		const parsed = schema.safeParse(src[key]);
		if (parsed.success) out[key] = parsed.data;
	}
	for (const key of ["source", "asrc", "relay_server"])
		if (key in src)
			out[`${key}_configured`] =
				typeof src[key] === "string" && src[key] !== "";
	return out;
}
export function projectCommandResult(
	type: string,
	payload: ResultPayload,
): ResultPayload {
	if (!payload.ok) return { ...payload, applied: null };
	if (payload.applied === null || payload.applied === undefined) return payload;
	const src = obj(payload.applied);
	switch (type) {
		case "streaming.getPipelines": {
			const entries = Object.entries(obj(src.pipelines));
			const pipelines = Object.fromEntries(
				entries
					.filter(([id]) => PIPELINES.has(id))
					.map(([id, raw]) => {
						const row = obj(raw),
							out: Record<string, unknown> = { name: id, description: "" };
						for (const key of [
							"supportsAudio",
							"supportsResolutionOverride",
							"supportsFramerateOverride",
						])
							if (typeof row[key] === "boolean") out[key] = row[key];
						for (const [key, schema] of [
							["defaultResolution", resolutionSchema],
							["defaultFramerate", framerateSchema],
						] as const) {
							const parsed = schema.safeParse(row[key]);
							if (parsed.success) out[key] = parsed.data;
						}
						if (
							["selectable", "embedded", "none"].includes(
								String(row.audio_kind),
							)
						)
							out.audio_kind = row.audio_kind;
						if (["rtmp", "srt"].includes(String(row.requires_gateway)))
							out.requires_gateway = row.requires_gateway;
						return [id, out];
					}),
			);
			if (entries.length && !Object.keys(pipelines).length)
				return { ok: false, applied: null, error: "withheld" };
			return {
				...payload,
				applied: {
					pipelines,
					...(hardwareTypeSchema.safeParse(src.hardware).success
						? { hardware: src.hardware }
						: {}),
				},
			};
		}
		case "streaming.getConfig":
		case "streaming.setConfig":
			return { ...payload, applied: configDTO(src) };
		case "streaming.setBitrate":
			return {
				...payload,
				applied:
					typeof payload.applied === "number"
						? payload.applied
						: scalarAcknowledgement(src),
			};
		case "streaming.start":
		case "streaming.stop":
			return { ...payload, applied: null };
		default:
			return { ...payload, applied: scalarAcknowledgement(src) };
	}
}
