import { isIPv6 } from "node:net";
import type { LogBundleFailureReason } from "@ceraui/rpc/schemas";

export class BundleReadError extends Error {
	readonly code: "READ_FAILED" | "BUSY";
	/** The closed stage that refused; never a cause, an input or a secret's position. */
	constructor(readonly reason: LogBundleFailureReason | "busy" = "internal") {
		const code = reason === "busy" ? "BUSY" : "READ_FAILED";
		super(code);
		this.code = code;
	}
}

const percentCase = (value: string) =>
	value.replace(/%[0-9a-f]{2}/gi, (part) => part.toLowerCase());

function isLocalIPv4(a: number, b: number): boolean {
	return (
		a === 10 ||
		a === 127 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254) ||
		(a === 100 && b >= 64 && b <= 127)
	);
}

// SRT passphrase fields by name, as srt-secret-redaction.ts masks them, so a value
// that is no longer held (changed, cleared or never loaded) stays out too.
//
// A small lexer reads the line: a double-quoted string is decoded with JSON
// escapes and read again inside, recursively, so a JSON object, URI or prose
// serialized into a string is read at its own level with its own delimiters.
// At each level a `passphrase` key is a JSON field (a key string ending in
// `passphrase`, a colon and a string value), a URI query assignment
// (`?`/`&passphrase=`) or a prose assignment (`passphrase=`). A value is masked
// only when its decoded content is exactly a marker, and only its own source
// span, quotes included, is replaced. A value is one unit: nothing inside it is
// read as another key.

/**
 * Whether a JSON key or a `key=` assignment names a secret value: an SRT
 * passphrase field such as `passphrase`, `srt_passphrase` or
 * `relay_passphrase`. The one place this lexer decides it.
 */
export function isPassphraseKey(key: string): boolean {
	return /passphrase$/i.test(key);
}

const MASKED_PASSPHRASE = /^\[REDACTED(?::[a-z0-9_]+)?\]$/;
// Log prose may run a marker into the sentence's trailing punctuation.
const MASKED_PROSE_PASSPHRASE = /^\[REDACTED(?::[a-z0-9_]+)?\][,.;:!?)]+$/;
const REPLACEMENT = "[REDACTED:srt_passphrase]";
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

export interface NamedSpan {
	readonly start: number;
	readonly end: number;
	readonly marker: string;
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

/** A `passphrase=` value at `start`; returns where reading resumes. */
function readAssignment(
	view: View,
	start: number,
	uri: boolean,
	spans: NamedSpan[],
): number {
	const { text } = view;
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
			if (end === close + 1 && MASKED_PASSPHRASE.test(content)) return end;
			spans.push({
				...sourceOf(view, start, end),
				marker:
					text[start] === '"' && end === close + 1
						? `${sourceText(view, start)}${REPLACEMENT}${sourceText(view, close)}`
						: REPLACEMENT,
			});
			return end;
		}
	}
	let end = start;
	while (end < text.length && !delimiter.test(text.charAt(end))) end++;
	const value = text.slice(start, end);
	if (value === "") return end;
	const masked =
		MASKED_PASSPHRASE.test(value) ||
		(!uri &&
			MASKED_PROSE_PASSPHRASE.test(value) &&
			(end === text.length || /\s/.test(text.charAt(end))));
	if (!masked)
		spans.push({ ...sourceOf(view, start, end), marker: REPLACEMENT });
	return end;
}

/** The source text of decoded character `index`, such as `\"` for a quote. */
function sourceText(view: View, index: number): string {
	const range = sourceOf(view, index, index + 1);
	return view.source.slice(range.start, range.end);
}

function readView(view: View, spans: NamedSpan[]): void {
	const { text } = view;
	let index = 0;
	while (index < text.length) {
		if (text[index] === "=") {
			let key = index;
			while (key > 0 && /[\w.-]/.test(text.charAt(key - 1))) key--;
			if (isPassphraseKey(text.slice(key, index))) {
				index = readAssignment(
					view,
					index + 1,
					key > 0 && "?&".includes(text.charAt(key - 1)),
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
			readView(string.content, spans);
			return;
		}
		const next = string.close + 1;
		if (isPassphraseKey(string.content.text)) {
			// A JSON field: any JSON whitespace around the colon, then a string.
			let cursor = next;
			while (/[ \t\n\r]/.test(text.charAt(cursor))) cursor++;
			if (text[cursor] === ":") {
				cursor++;
				while (/[ \t\n\r]/.test(text.charAt(cursor))) cursor++;
				if (text[cursor] === '"') {
					const value = decodeString(view, cursor);
					const close = value.close === -1 ? text.length : value.close;
					const content = value.content.text;
					if (content !== "" && !MASKED_PASSPHRASE.test(content)) {
						const range = sourceOf(view, cursor, close + 1);
						spans.push({
							...range,
							marker:
								value.close === -1
									? `${sourceText(view, cursor)}${REPLACEMENT}`
									: `${sourceText(view, cursor)}${REPLACEMENT}${sourceText(view, close)}`,
						});
					}
					index = Math.min(close + 1, text.length);
					continue;
				}
			}
		}
		readView(string.content, spans);
		index = next;
	}
}

/**
 * Every value of a secret-bearing key in `input` that needs masking, in source
 * order and not overlapping: the source range to replace and its masked form.
 */
export function namedPassphraseSpans(input: string): NamedSpan[] {
	const spans: NamedSpan[] = [];
	readView(sourceView(input), spans);
	return spans;
}

/** Held values shorter than this are not matched: too many false hits. */
export const MIN_REDACTED_LENGTH = 4;

type TextSpan = readonly [start: number, end: number];

interface Redactor {
	/**
	 * Kinds (sorted, unique) of held values that are NOT matched because they
	 * are shorter than {@link MIN_REDACTED_LENGTH}. Callers must not treat
	 * output as redacted while this is non-empty.
	 */
	readonly unredacted: readonly string[];
	structured(value: string | number | boolean | null): void;
	/** Held secrets and SRT passphrase fields, without identifier and address patterns. */
	known(value: string): { readonly text: string; readonly redactions: number };
	text(
		value: string,
		exempt?: { readonly boot: TextSpan; readonly numeric?: TextSpan },
	): { readonly text: string; readonly redactions: number };
}

export function buildRedactor(
	secrets: readonly { readonly kind: string; readonly value: string }[],
	bootIds?: ReadonlySet<string>,
): Redactor {
	const literals = new Map<string, string>();
	const unredacted = new Set<string>();
	let secretBytes = 0;
	for (const { kind, value } of secrets) {
		if (!/^[a-z][a-z0-9_]{0,31}$/.test(kind)) throw new BundleReadError();
		if (value.length < MIN_REDACTED_LENGTH) {
			if (value.length > 0) unredacted.add(kind);
			continue;
		}
		secretBytes += Buffer.byteLength(value);
		if (secretBytes > 64 * 1024) throw new BundleReadError("budget");
		const bytes = Buffer.from(value);
		const base64 = bytes.toString("base64");
		let uri: string;
		try {
			uri = encodeURIComponent(value);
		} catch {
			throw new BundleReadError();
		}
		for (const form of [
			value,
			JSON.stringify(value).slice(1, -1),
			uri,
			base64,
			base64.replace(/\+/g, "-").replace(/\//g, "_"),
			bytes.toString("base64url"),
		]) {
			const key = percentCase(form);
			if (!literals.has(key)) literals.set(key, `[REDACTED:${kind}]`);
		}
	}
	const alternatives = [...literals.keys()]
		.sort((a, b) => b.length - a.length)
		.map((value) =>
			value
				.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
				.replace(/%[0-9a-f]{2}/g, (part) =>
					part.replace(
						/[a-f]/g,
						(letter) => `[${letter}${letter.toUpperCase()}]`,
					),
				),
		);
	const exact = alternatives.length
		? new RegExp(alternatives.join("|"), "g")
		: null;
	const bootForms = [...(bootIds ?? [])]
		.filter((id) => /^[0-9a-f]{32}$/i.test(id))
		.flatMap((id) => [
			id,
			id.replace(/^(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-"),
		]);
	// A lookahead visits each start so overlapping IDs reach the span merger.
	const exactBoot = bootForms.length
		? new RegExp(`(?=(${bootForms.join("|")}))`, "gi")
		: null;
	return {
		unredacted: [...unredacted].sort(),
		structured(value: string | number | boolean | null) {
			if (exact === null || value === null) return;
			exact.lastIndex = 0;
			if (exact.test(String(value))) throw new BundleReadError("collision");
		},
		known(value: string) {
			let redactions = 0;
			const text =
				exact === null
					? value
					: value.replace(exact, (match) => {
							redactions++;
							return literals.get(percentCase(match)) ?? "[REDACTED]";
						});
			let position = 0;
			let named = "";
			for (const span of namedPassphraseSpans(text)) {
				named += text.slice(position, span.start) + span.marker;
				position = span.end;
				redactions++;
			}
			return { text: named + text.slice(position), redactions };
		},
		text(value: string, exempt) {
			const spans: Array<{
				start: number;
				end: number;
				marker: string;
				known: boolean;
			}> = [];
			if (exact !== null) {
				for (const match of value.matchAll(exact))
					spans.push({
						start: match.index,
						end: match.index + match[0].length,
						marker: literals.get(percentCase(match[0])) ?? "",
						known: true,
					});
			}
			const addresses: Array<{
				readonly start: number;
				readonly end: number;
				readonly masked: boolean;
				readonly local: boolean;
			}> = [];
			for (const match of value.matchAll(
				/(?<![\w.])(?<![\da-f:]:)[\da-f]{0,4}:[\da-f:.]+(?:%[\w.~-]+)?(?![\w:%]|\.[\w:.])/gi,
			)) {
				const address = match[0].replace(/\.+$/, "");
				const host = address.split("%", 1)[0] ?? "";
				if (!isIPv6(host)) continue;
				const start = match.index;
				const end = start + address.length;
				let masked = /^[23][\da-f]{3}:/i.test(host);
				if (!masked && /(?:ffff|ff9b):/i.test(host)) {
					const canonical = new URL(`http://[${host}]`).hostname;
					const mapped = /^\[::ffff:([\da-f]+):[\da-f]+\]$/.exec(canonical);
					const translated = /^\[64:ff9b::(?:([\da-f]+):)?[\da-f]*\]$/.exec(
						canonical,
					);
					if (mapped || translated) {
						// A single translated hextet is the low 16 bits.
						const high = Number.parseInt(
							mapped?.[1] ?? translated?.[1] ?? "0",
							16,
						);
						masked = !isLocalIPv4(high >>> 8, high & 255);
					}
				}
				const local = /^(?:f[cd][\da-f]{2}|fe[89ab][\da-f]):/i.test(host);
				addresses.push({ start, end, masked, local });
				if (masked) {
					const bracketed = value[start - 1] === "[" && value[end] === "]";
					spans.push({
						start: bracketed ? start - 1 : start,
						end: bracketed ? end + 1 : end,
						marker: "[IP]",
						known: false,
					});
				}
			}
			const mask = (
				pattern: RegExp,
				replacement: (
					match: string,
					address: (typeof addresses)[number] | undefined,
					index: number,
				) => string,
				addressContext = false,
				ignore?: TextSpan,
				spanGroup = 0,
			) => {
				let addressIndex = 0;
				for (const match of value.matchAll(pattern)) {
					const text = match[spanGroup];
					if (!text) continue;
					const end = match.index + text.length;
					if (ignore && ignore[0] <= match.index && end <= ignore[1]) continue;
					let containing: (typeof addresses)[number] | undefined;
					if (addressContext) {
						let address = addresses[addressIndex];
						while (address && address.end <= match.index)
							address = addresses[++addressIndex];
						if (address && address.start <= match.index && end <= address.end)
							containing = address;
					}
					const next = replacement(text, containing, match.index);
					if (next !== text)
						spans.push({
							start: match.index,
							end,
							marker: next,
							known: false,
						});
				}
			};
			if (exactBoot) mask(exactBoot, () => "[BOOT_ID]", false, exempt?.boot, 1);
			const numericSpan = exempt?.numeric ?? exempt?.boot;
			mask(/(?<!\d)89\d{17,18}(?!\d)/g, () => "[ICCID]", false, numericSpan);
			mask(/(?<!\d)\d{15}(?!\d)/g, () => "[ID]", false, numericSpan);
			mask(
				/\b[0-9a-f]{2}([:-])[0-9a-f]{2}\1[0-9a-f]{2}\1[0-9a-f]{2}\1[0-9a-f]{2}\1[0-9a-f]{2}\b/gi,
				(match, address) => {
					if (address) return match;
					const separator = match.charAt(2);
					return `${match.slice(0, 8)}${separator}**${separator}**${separator}**`;
				},
				true,
			);
			mask(
				/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g,
				(match, address) => {
					if (address?.masked || address?.local) return match;
					const a = Number.parseInt(match, 10);
					const b = Number.parseInt(match.slice(match.indexOf(".") + 1), 10);
					if (
						match
							.split(".")
							.map(Number)
							.some((octet) => octet > 255) ||
						isLocalIPv4(a, b)
					)
						return match;
					return "[IP]";
				},
				true,
			);
			mask(
				/(?<![\d.])[+-]?\d{1,3}\.\d{4,}\s*,\s*[+-]?\d{1,3}\.\d{4,}(?![\d.])/g,
				(match) => {
					const latitude = Number.parseFloat(match);
					const longitude = Number.parseFloat(
						match.slice(match.indexOf(",") + 1),
					);
					return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
						? "[GPS]"
						: match;
				},
			);
			// Same value shapes as the logger, global here to count every occurrence.
			mask(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, () => "[REDACTED:token]");
			mask(
				/v[0-9]+\.(?:public|local)\.[A-Za-z0-9\-_]+/g,
				() => "[REDACTED:token]",
			);
			mask(
				/eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g,
				() => "[REDACTED:token]",
			);
			for (const span of namedPassphraseSpans(value))
				spans.push({ ...span, known: false });
			spans.sort((a, b) => a.start - b.start);
			const merged: typeof spans = [];
			for (const span of spans) {
				const previous = merged.at(-1);
				if (previous && span.start < previous.end) {
					previous.end = Math.max(previous.end, span.end);
					if (span.known && !previous.known) {
						previous.marker = span.marker;
						previous.known = true;
					}
				} else merged.push({ ...span });
			}
			let position = 0;
			const parts = merged.map((span) => {
				const part = value.slice(position, span.start) + span.marker;
				position = span.end;
				return part;
			});
			return {
				text: parts.join("") + value.slice(position),
				redactions: merged.length,
			};
		},
	};
}
