import { secretVariants } from "./secret-variants.ts";

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
	const label =
		/(?<![\w/\\.])\b(?:(?:srt[_-]?)?stream[_-]?id|relay_streamid_override|ingest[_-]?key)\b(?![-./\\])/i;
	let continuation = false;
	return redactRetainedStreamIds(text)
		.split("\n")
		.map((line) => {
			// A pretty-printed labelled value can span the rest of the record.
			// Stack frames are separate diagnostics, never value continuations.
			if (/^\s*at\s/.test(line)) continuation = false;
			if (label.test(line)) {
				continuation = /[:[({]\s*$/.test(line);
				return "[REDACTED]";
			}
			return continuation ? "[REDACTED]" : line;
		})
		.join("\n");
}

function redactRetainedStreamIds(text: string): string {
	let result = text;
	const variants = new Set(
		retainedValues()
			.filter((value): value is string => Boolean(value))
			.flatMap(secretVariants),
	);
	for (const encoded of [...variants].sort((a, b) => b.length - a.length))
		result = result.replace(
			new RegExp(
				`(?<![\\p{L}\\p{N}_])${encoded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`,
				"gu",
			),
			"[REDACTED]",
		);
	return result;
}
export function redactStreamIdJournal(text: string): string {
	return redactStreamIdText(text);
}
export function isStreamIdKey(key: string): boolean {
	return /^(?:srtstreamid|streamid|relaystreamidoverride|ingestkey)$/i.test(
		key.replace(/[_.-]/g, ""),
	);
}
