/** Stream IDs can be bearer publish keys, even when SRT encryption is enabled. */
export function publicStreamIds<
	T extends {
		srt_streamid?: unknown;
		relay_streamid_override?: unknown;
		srt_streamid_configured?: boolean | undefined;
		relay_streamid_override_configured?: boolean | undefined;
	},
>(
	value: T,
	stored: {
		srt_streamid?: unknown;
		relay_streamid_override?: unknown;
		srt_streamid_configured?: boolean | undefined;
		relay_streamid_override_configured?: boolean | undefined;
	} = value,
	includeUnchanged = true,
) {
	const { srt_streamid, relay_streamid_override, ...rest } = value;
	return {
		...rest,
		...(includeUnchanged || "srt_streamid" in value
			? {
					srt_streamid_configured:
						stored.srt_streamid !== undefined
							? Boolean(stored.srt_streamid)
							: (stored.srt_streamid_configured ?? false),
				}
			: {}),
		...(includeUnchanged || "relay_streamid_override" in value
			? {
					relay_streamid_override_configured:
						stored.relay_streamid_override !== undefined
							? Boolean(stored.relay_streamid_override)
							: (stored.relay_streamid_override_configured ?? false),
				}
			: {}),
	};
}

let retainedValues: () => readonly (string | undefined)[] = () => [];
export function setStreamIdRedactionSource(
	source: typeof retainedValues,
): typeof retainedValues {
	const previous = retainedValues;
	retainedValues = source;
	return previous;
}

/** Scrub labelled ID records and retained whole tokens in engine errors. */
export function redactStreamIdText(text: string): string {
	if (
		/\b(?:(?:srt[_-]?)?stream[_-]?id|relay_streamid_override|ingest[_-]?key)\b/i.test(
			text,
		) &&
		/[=:]/.test(text)
	)
		return "[REDACTED]";
	return redactRetainedStreamIds(text);
}

function redactRetainedStreamIds(text: string): string {
	let result = text;
	for (const value of retainedValues()) {
		if (!value) continue;
		for (const encoded of new Set([
			value,
			encodeURIComponent(value),
			JSON.stringify(value).slice(1, -1),
		]))
			result = result.replace(
				new RegExp(
					`(?<![\\p{L}\\p{N}_])${encoded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`,
					"gu",
				),
				"[REDACTED]",
			);
	}
	return result;
}
export function redactStreamIdJournal(text: string): string {
	return redactRetainedStreamIds(text)
		.split("\n")
		.map(redactStreamIdText)
		.join("\n");
}
export function isStreamIdKey(key: string): boolean {
	return /^(?:srtstreamid|streamid|relaystreamidoverride|ingestkey)$/i.test(
		key.replace(/[_.-]/g, ""),
	);
}
