/**
 * A small lexer that finds the values of secret-bearing keys in log text.
 *
 * A double-quoted string is decoded with JSON escapes, keeping a source range
 * for each decoded character, and read again with the string as its container,
 * recursively, so a JSON object, URI or prose serialized into a string is read
 * at its own level with its own delimiters. At each level a key is:
 *
 * - a JSON field: a key string, any JSON whitespace, a colon, then a string or
 *   number value;
 * - a URI query assignment (`?key=` or `&key=`);
 * - a prose assignment (`key=`).
 *
 * The caller decides which keys are secret and what replaces their values. A
 * value is kept only when its decoded content is exactly a redaction marker,
 * and only its own source span is replaced, so delimiters and neighbouring
 * fields stay as they were. A value is one unit: nothing inside it is read as
 * another key.
 *
 * The logger (`redactKeyValueText`), the log viewer and the support export and
 * bundle all read text through this one lexer, with the logger's
 * `isSensitiveKey` as the key rule.
 */

export interface SecretTextRules {
	/** Whether a JSON key or a `key=` assignment names a secret value. */
	readonly isSecretKey: (key: string) => boolean;
	/** The masked form for a value of this key, without quotes. */
	readonly marker: (key: string) => string;
	/** Also read URI and prose `key=` assignments (default true); false reads JSON fields only. */
	readonly assignments?: boolean;
}

export interface SecretSpan {
	readonly start: number;
	readonly end: number;
	readonly marker: string;
}

const MASKED_VALUE = /^\[REDACTED(?::[a-z0-9_]+)?\]$/;
const JSON_ESCAPES: Readonly<Record<string, string>> = {
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};

/** Decoded text with, for each decoded character, its source range. */
interface View {
	/** The whole source line the offsets point into. */
	readonly source: string;
	readonly text: string;
	/** Source offset where decoded character `index` starts, or undefined past the end. */
	readonly from: (index: number) => number | undefined;
	/** Source offset where decoded character `index` ends. */
	readonly to: (index: number) => number | undefined;
	/** Source offset of the end of the view, for an empty tail. */
	readonly end: number;
}

function sourceView(input: string): View {
	const inside = (index: number) => index >= 0 && index < input.length;
	return {
		source: input,
		text: input,
		from: (index) => (inside(index) ? index : undefined),
		to: (index) => (inside(index) ? index + 1 : undefined),
		end: input.length,
	};
}

/** The string opening at `open`, decoded, and the index of its closing quote. */
function decodeString(
	view: View,
	open: number,
): { readonly content: View; readonly close: number } {
	const { text } = view;
	let decoded = "";
	const from: number[] = [];
	const to: number[] = [];
	let index = open + 1;
	while (index < text.length && text[index] !== '"') {
		let length = 1;
		let char = text.charAt(index);
		if (char === "\\" && index + 1 < text.length) {
			const escaped = text.charAt(index + 1);
			const unicode = /^u[0-9a-f]{4}/i.exec(text.slice(index + 1, index + 6));
			if (unicode) {
				char = String.fromCharCode(Number.parseInt(unicode[0].slice(1), 16));
				length = 6;
			} else {
				char = JSON_ESCAPES[escaped] ?? escaped;
				length = 2;
			}
		}
		decoded += char;
		from.push(view.from(index) ?? view.end);
		to.push(view.to(index + length - 1) ?? view.end);
		index += length;
	}
	const close = index < text.length ? index : -1;
	return {
		content: {
			source: view.source,
			text: decoded,
			from: (position) => from[position],
			to: (position) => to[position],
			end: close === -1 ? view.end : (view.from(close) ?? view.end),
		},
		close,
	};
}

/** Source range of decoded `[start, end)`. */
function sourceOf(view: View, start: number, end: number) {
	return {
		start: view.from(start) ?? view.end,
		end:
			end > start
				? (view.to(end - 1) ?? view.end)
				: (view.from(start) ?? view.end),
	};
}

/** The source text of decoded character `index`, such as `\"` for a quote. */
function sourceText(view: View, index: number): string {
	const range = sourceOf(view, index, index + 1);
	return view.source.slice(range.start, range.end);
}

/**
 * The quote that opened the whitespace-delimited token ending at `index`, if
 * any: a URI given as a single-quoted shell argument closes with that quote,
 * which belongs to the argument, not to the value.
 */
function tokenQuote(text: string, index: number): string | undefined {
	let start = index;
	while (start > 0 && !/\s/.test(text.charAt(start - 1))) start--;
	const first = text.charAt(start);
	return first === "'" ? first : undefined;
}

/** A `key=` value at `start`; returns where reading resumes. */
function readAssignment(
	view: View,
	start: number,
	key: string,
	uri: boolean,
	closer: string | undefined,
	rules: SecretTextRules,
	spans: SecretSpan[],
): number {
	const { text } = view;
	const marker = rules.marker(key);
	const delimiter = uri ? /[\s&#]/ : /[\s&]/;
	if (text[start] === '"' || text[start] === "'") {
		let close = -1;
		let content = "";
		if (text[start] === '"') {
			const string = decodeString(view, start);
			close = string.close;
			content = string.content.text;
		} else {
			close = text.indexOf("'", start + 1);
			content = text.slice(start + 1, close);
		}
		if (close !== -1) {
			let end = close + 1;
			// A URI value runs to its delimiter even past a quote; prose ends there.
			if (uri)
				while (end < text.length && !delimiter.test(text.charAt(end))) end++;
			if (end === close + 1 && MASKED_VALUE.test(content)) return end;
			spans.push({
				...sourceOf(view, start, end),
				marker:
					text[start] === '"' && end === close + 1
						? `${sourceText(view, start)}${marker}${sourceText(view, close)}`
						: marker,
			});
			return end;
		}
	}
	let end = start;
	while (end < text.length && !delimiter.test(text.charAt(end))) end++;
	// The argument's own closing quote stays outside the value.
	if (closer !== undefined && end > start && text.charAt(end - 1) === closer)
		end--;
	const value = text.slice(start, end);
	if (value === "") return end;
	// Only exactly a marker counts as masked: a marker with anything after it,
	// punctuation included, may be the start of a credential.
	if (!MASKED_VALUE.test(value))
		spans.push({ ...sourceOf(view, start, end), marker });
	return end;
}

function readView(
	view: View,
	rules: SecretTextRules,
	spans: SecretSpan[],
): void {
	const { text } = view;
	let index = 0;
	while (index < text.length) {
		if (text[index] === "=" && rules.assignments !== false) {
			let keyStart = index;
			while (keyStart > 0 && /[\w.-]/.test(text.charAt(keyStart - 1)))
				keyStart--;
			const key = text.slice(keyStart, index);
			if (key !== "" && rules.isSecretKey(key)) {
				const uri = keyStart > 0 && "?&".includes(text.charAt(keyStart - 1));
				index = readAssignment(
					view,
					index + 1,
					key,
					uri,
					uri ? tokenQuote(text, keyStart) : undefined,
					rules,
					spans,
				);
				continue;
			}
		}
		if (text[index] !== '"') {
			index++;
			continue;
		}
		const string = decodeString(view, index);
		if (string.close === -1) {
			readView(string.content, rules, spans);
			return;
		}
		const next = string.close + 1;
		const key = string.content.text;
		if (rules.isSecretKey(key)) {
			// A JSON field: any JSON whitespace around the colon, then a value.
			let cursor = next;
			while (/[ \t\n\r]/.test(text.charAt(cursor))) cursor++;
			if (text[cursor] === ":") {
				cursor++;
				while (/[ \t\n\r]/.test(text.charAt(cursor))) cursor++;
				if (text[cursor] === '"') {
					const value = decodeString(view, cursor);
					const close = value.close === -1 ? text.length : value.close;
					const content = value.content.text;
					if (content !== "" && !MASKED_VALUE.test(content)) {
						const range = sourceOf(view, cursor, close + 1);
						spans.push({
							...range,
							marker:
								value.close === -1
									? `${sourceText(view, cursor)}${rules.marker(key)}`
									: `${sourceText(view, cursor)}${rules.marker(key)}${sourceText(view, close)}`,
						});
					}
					index = Math.min(close + 1, text.length);
					continue;
				}
				const number = /^-?\d[\d.eE+-]*/.exec(text.slice(cursor));
				if (number) {
					const end = cursor + number[0].length;
					spans.push({
						...sourceOf(view, cursor, end),
						marker: rules.marker(key),
					});
					index = end;
					continue;
				}
			}
		}
		readView(string.content, rules, spans);
		index = next;
	}
}

/**
 * Every value of a secret-bearing key in `input` that needs masking, in source
 * order and not overlapping: the source range to replace and its masked form.
 */
export function secretValueSpans(
	input: string,
	rules: SecretTextRules,
): SecretSpan[] {
	if (
		!input.includes('"') &&
		(rules.assignments === false || !input.includes("="))
	)
		return [];
	const spans: SecretSpan[] = [];
	readView(sourceView(input), rules, spans);
	return spans;
}

/** `input` with every span from {@link secretValueSpans} replaced. */
export function maskSecretValues(
	input: string,
	rules: SecretTextRules,
): string {
	const spans = secretValueSpans(input, rules);
	if (spans.length === 0) return input;
	let out = "";
	let position = 0;
	for (const span of spans) {
		out += input.slice(position, span.start) + span.marker;
		position = span.end;
	}
	return out + input.slice(position);
}
