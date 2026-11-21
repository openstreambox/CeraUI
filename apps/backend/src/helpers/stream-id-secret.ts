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

const LABEL_NAME = String.raw`\b(?:(?:srt[_-]?)?stream[_-]?id|relay_streamid_override|ingest[_-]?key)\b`;
// Paths and dotted reads (`settings.streamId`) name a field without a value,
// but a dotted field that is assigned (`cfg.streamid=X`) still labels one. A
// backslash run that ends in a quote is JSON escaping (`\"srt_streamid\":`),
// not a path separator.
const LABEL_SOURCE = String.raw`(?<![\w/\\.])${LABEL_NAME}(?![-./]|\\(?!\\*["']))|(?<=\.)${LABEL_NAME}(?=\\*["']?\s*[=:])`;
const LABEL = new RegExp(LABEL_SOURCE, "i");
const LABELS = new RegExp(LABEL_SOURCE, "gi");
// A JavaScript stack frame: the label can only be a function name there.
const FRAME =
	/^\s*at (?:async )?(?:new )?(?:[\w$.<>]+(?: \[as [\w$]+\])? \((?:(?:file:\/\/|node:|\/|[A-Za-z]:\\)\S*:\d+:\d+|native|<anonymous>)\)|(?:file:\/\/|node:|\/|[A-Za-z]:\\)\S*:\d+:\d+)\s*$/;
// Plain words, optionally after an `Error:` lead, then opening punctuation.
const BEFORE_NAME =
	/^\s*(?:\w*(?:Error|error):\s+)?(?:[A-Za-z]+\s+)*["'`({[]*$/;
// Nothing but punctuation, or a fixed phrase that carries no value.
const AFTER_NAME =
	/^\\*["'`]?(?:\s+(?:is\s+)?(?:not\s+(?:specified|set|configured|provided)|missing|required|empty))?[\s.,;:!?()[\]{}"'`]*$/;
// The support journal's record prefix: boot label, optional time, source.
const RECORD_PREFIX =
	/^\[boot -?\d+\] (?:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z )?[\w.-]+: /;

/** True when a labelled line only names the field, so no value can be on it. */
function namesFieldOnly(line: string, journal: boolean): boolean {
	let text = journal ? line.replace(RECORD_PREFIX, "") : line;
	if (journal && text.startsWith("{")) {
		// A structured support record: only its message may name the field.
		try {
			const { msg, ...rest } = JSON.parse(text);
			if (typeof msg !== "string" || LABEL.test(JSON.stringify(rest)))
				return false;
			text = msg;
		} catch {
			return false;
		}
	}
	const hits = [...text.matchAll(LABELS)];
	const hit = hits[0];
	return (
		hits.length === 1 &&
		hit?.index !== undefined &&
		BEFORE_NAME.test(text.slice(0, hit.index)) &&
		AFTER_NAME.test(text.slice(hit.index + hit[0].length))
	);
}

function redactLabelled(text: string, journal: boolean): string {
	let continuation = false;
	return redactRetainedStreamIds(text)
		.split("\n")
		.map((line) => {
			// A pretty-printed labelled value can span the rest of the record.
			// Stack frames are separate diagnostics, never value continuations,
			// and in a journal an unindented line starts the next record.
			if (/^\s*at\s/.test(line) || (journal && /^\S/.test(line)))
				continuation = false;
			if (LABEL.test(line) && !FRAME.test(line)) {
				const keep = !continuation && namesFieldOnly(line, journal);
				continuation = /[:[({]\s*$/.test(line);
				return keep ? line : "[REDACTED]";
			}
			return continuation ? "[REDACTED]" : line;
		})
		.join("\n");
}

/** Scrub labelled ID records and retained whole tokens in engine errors. */
export function redactStreamIdText(text: string): string {
	return redactLabelled(text, false);
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
/** As redactStreamIdText, but a labelled value never runs past its record. */
export function redactStreamIdJournal(text: string): string {
	return redactLabelled(text, true);
}
export function isStreamIdKey(key: string): boolean {
	return /^(?:srtstreamid|streamid|relaystreamidoverride|ingestkey)$/i.test(
		key.replace(/[_.-]/g, ""),
	);
}
