/*
 * Generated log lines that carry SRT passphrases by name, in every wrapper the
 * named-field redactor knows and nested in each other, each built together with
 * its exact expected output: the same line with every credential's own source
 * span replaced by its masked form. Credential values are SECRET<n> tokens,
 * sometimes behind a redaction marker, punctuation, quotes, backslashes, spaces
 * or control characters, and sometimes exactly a marker (left as it is). Every
 * generated line is well formed for its wrapper: quoted values are escaped as
 * the wrapper escapes them, and unquoted ones hold no delimiter. Both the log
 * export (`known`) and the support bundle (`text`) must produce the expected
 * line byte for byte, delimiters and neighbouring fields included.
 */
import { expect, test } from "bun:test";
import { buildRedactor } from "../modules/device-logs/redaction.ts";

const CASES = 4000;
const SEEDS = [0x5eed, 1, 2, 3, 77, 991];
const MASKED = "[REDACTED:srt_passphrase]";

/** mulberry32: a small deterministic generator, so a failure reproduces. */
function generator(seed: number) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		int: (n: number) => Math.floor(next() * n),
		pick: <T>(items: readonly T[]): T =>
			items[Math.floor(next() * items.length)] as T,
	};
}

/** A piece of a line and what it must become. */
interface Piece {
	readonly actual: string;
	readonly expected: string;
}
const same = (text: string): Piece => ({ actual: text, expected: text });
const cat = (...pieces: Piece[]): Piece => ({
	actual: pieces.map((piece) => piece.actual).join(""),
	expected: pieces.map((piece) => piece.expected).join(""),
});
/** A piece serialized into a JSON string, as a log line nests it. */
const quoted = (piece: Piece): Piece => ({
	actual: JSON.stringify(piece.actual),
	expected: JSON.stringify(piece.expected),
});

type Context = "json" | "double" | "single" | "prose" | "uri";

const MARKERS = ["[REDACTED]", "[REDACTED:srt_passphrase]"];
const DECORATIONS = [
	",",
	";",
	"!",
	".",
	")",
	"'",
	'"',
	"\\",
	"\\\\\\",
	" ",
	"\t",
	"&",
	"#",
	"é",
	"\u0001",
];

function generateLine(random: ReturnType<typeof generator>): Piece {
	let count = 0;
	const allowed = (context: Context, text: string) => {
		if (context === "single") return !text.includes("'");
		if (context === "prose") return !/[\s&]/.test(text);
		if (context === "uri") return !/[\s&#]/.test(text);
		return true;
	};
	const decoration = (context: Context) => {
		const options = DECORATIONS.filter((item) => allowed(context, item));
		return Array.from({ length: random.int(3) }, () =>
			random.pick(options),
		).join("");
	};
	/** A credential value for `context`, and whether it is already masked. */
	const credential = (context: Context): { value: string; masked: boolean } => {
		const shape = random.int(10);
		if (shape === 0) return { value: random.pick(MARKERS), masked: true };
		if (shape === 1 && context === "prose") {
			const punctuation = random.pick([",", ".", ";", "!", ")", ",."]);
			return { value: `${random.pick(MARKERS)}${punctuation}`, masked: true };
		}
		if (shape === 2)
			return {
				value: `${"\\".repeat(1 + random.int(12))}${decoration(context)}`,
				masked: false,
			};
		const token = `SECRET${count++}`;
		const prefix = random.int(2) === 0 ? random.pick(MARKERS) : "";
		let value = `${prefix}${decoration(context)}${token}${decoration(context)}`;
		// An unquoted value cannot open with a quote: it would read as quoted.
		if (context === "prose" || context === "uri")
			value = value.replace(/^["']+/, "");
		return { value, masked: false };
	};
	/** A `passphrase=` value in prose or a URI, quoted or not. */
	const assigned = (context: "prose" | "uri"): Piece => {
		const form = random.int(3);
		if (form === 0) {
			const { value, masked } = credential(context);
			return { actual: value, expected: masked ? value : MASKED };
		}
		if (form === 1) {
			const { value, masked } = credential("double");
			return quoted({ actual: value, expected: masked ? value : MASKED });
		}
		const { value, masked } = credential("single");
		return {
			actual: `'${value}'`,
			expected: masked ? `'${value}'` : MASKED,
		};
	};
	const uri = (): Piece => {
		const value = assigned("uri");
		return random.int(2) === 0
			? cat(
					same("srt://127.0.0.1:9000?passphrase="),
					value,
					same("&latency=120"),
				)
			: cat(
					same("srt://127.0.0.1:9000?streamid=s&latency=120&passphrase="),
					value,
				);
	};
	const space = () => random.pick(["", " ", "\t", "\n", " \t"]);
	const json = (fields: Array<[string, Piece]>): Piece => {
		const entries: Array<[string, Piece]> = [
			...fields,
			["latency", same("120")],
		];
		if (random.int(2) === 0) entries.reverse();
		const parts: Piece[] = [same("{")];
		entries.forEach(([key, value], index) => {
			if (index > 0) parts.push(same(`${space()},${space()}`));
			parts.push(same(`${JSON.stringify(key)}${space()}:${space()}`), value);
		});
		parts.push(same("}"));
		return cat(...parts);
	};
	const jsonCredential = (value: string, masked: boolean): Piece =>
		quoted({ actual: value, expected: masked ? value : MASKED });
	const key = () => random.pick(["passphrase", "srt_passphrase", "Passphrase"]);
	const fragment = (depth: number): Piece => {
		switch (random.int(depth > 0 ? 9 : 6)) {
			case 0:
				return cat(same("note passphrase="), assigned("prose"));
			case 1: {
				// A quoted prose value ends at its closing quote.
				const { value, masked } = credential("double");
				return cat(
					same("note passphrase="),
					jsonCredential(value, masked),
					same(random.int(2) === 0 ? ",latency=120" : ""),
				);
			}
			case 2:
				return cat(same("caller "), uri());
			case 3:
				// A URI as a quoted argument after prose.
				return cat(same("caller "), quoted(uri()));
			case 4: {
				const { value, masked } = credential("json");
				return json([[key(), jsonCredential(value, masked)]]);
			}
			case 5: {
				// A passphrase whose own value looks like a query assignment, beside
				// a URL that carries another one.
				const inner = `${credential("json").value}${random.pick(["&", "?"])}passphrase=${credential("json").value}`;
				return json([
					[key(), jsonCredential(inner, false)],
					["url", quoted(uri())],
				]);
			}
			case 6:
				return json([["url", quoted(uri())]]);
			case 7:
				return json([["msg", quoted(fragment(depth - 1))]]);
			default:
				return cat(same("wrapped "), quoted(fragment(depth - 1)));
		}
	};
	const parts = Array.from({ length: 1 + random.int(3) }, () => fragment(2));
	const line: Piece[] = [];
	parts.forEach((part, index) => {
		if (index > 0) line.push(same(" "));
		line.push(part);
	});
	return cat(...line);
}

test.each(SEEDS)(
	`${CASES} generated passphrase lines redact to their exact expected text (seed %d)`,
	(seed) => {
		const random = generator(seed);
		const redactor = buildRedactor([]);
		const failures: string[] = [];
		for (let index = 0; index < CASES; index++) {
			const { actual, expected } = generateLine(random);
			for (const [path, result] of [
				["export", redactor.known(actual).text],
				["bundle", redactor.text(actual).text],
			] as const) {
				if (result !== expected)
					failures.push(
						`${path}: ${JSON.stringify(actual)}\n  want ${JSON.stringify(expected)}\n  got  ${JSON.stringify(result)}`,
					);
			}
		}
		expect(failures.slice(0, 5)).toEqual([]);
		expect(failures).toHaveLength(0);
	},
);
