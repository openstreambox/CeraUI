import { describe, expect, test } from "bun:test";

import { isSensitiveKey } from "../helpers/logger.ts";
import {
	maskSecretValues,
	type SecretTextRules,
	secretValueSpans,
} from "../helpers/secret-text-lexer.ts";

const RULES: SecretTextRules = {
	isSecretKey: isSensitiveKey,
	marker: () => "[M]",
};
const mask = (text: string) => maskSecretValues(text, RULES);
const SECRET = "fixture-secret-91";

describe("secret text lexer", () => {
	test.each([
		[
			`{"ssh_pass":"${SECRET}","max_br":5000}`,
			'{"ssh_pass":"[M]","max_br":5000}',
		],
		[`{"pin" : 1234, "port":9000}`, '{"pin" : [M], "port":9000}'],
		[
			JSON.stringify({
				preview: JSON.stringify({ remote_key: `a"${SECRET}` }),
			}),
			JSON.stringify({ preview: JSON.stringify({ remote_key: "[M]" }) }),
		],
		[
			JSON.stringify({
				msg: JSON.stringify({ wrapped: JSON.stringify({ psk: SECRET }) }),
			}),
			JSON.stringify({
				msg: JSON.stringify({ wrapped: JSON.stringify({ psk: "[M]" }) }),
			}),
		],
		[`note token=${SECRET} next`, "note token=[M] next"],
		[
			`srt://h:1?api_key=${SECRET}&latency=120`,
			"srt://h:1?api_key=[M]&latency=120",
		],
	])("masks %s", (input, expected) => {
		expect(mask(input)).toBe(expected);
	});

	test("a value cut off by the end of the text, even after a backslash, is masked to the end", () => {
		for (const text of [
			`{"ssh_pass":"${SECRET}`,
			`{"ssh_pass":"${SECRET}\\`,
			`"{\\"ssh_pass\\":\\"${SECRET}\\`,
		])
			expect(mask(text)).not.toContain(SECRET);
	});

	test("only exactly a marker counts as masked", () => {
		expect(mask("note token=[REDACTED] next")).toBe(
			"note token=[REDACTED] next",
		);
		expect(mask('{"token":"[REDACTED:token]"}')).toBe(
			'{"token":"[REDACTED:token]"}',
		);
		// A marker with anything after it may be the start of a credential.
		expect(mask("note token=[REDACTED], next")).toBe("note token=[M] next");
		expect(mask("note token=[REDACTED]x9 next")).toBe("note token=[M] next");
	});

	test("a single-quoted URI argument keeps its closing quote", () => {
		expect(mask(`caller 'srt://h:1?mode=c&api_key=${SECRET}'`)).toBe(
			"caller 'srt://h:1?mode=c&api_key=[M]'",
		);
		// A quote inside the value is still part of it.
		expect(mask(`caller 'srt://h:1?api_key=ab'cd' x`)).toBe(
			"caller 'srt://h:1?api_key=[M]' x",
		);
	});

	test("ordinary keys, words and text are left alone", () => {
		for (const text of [
			'{"video_passthrough":"auto","stableKey":"usb-1.2","deviceKey":"d-1"}',
			"level=info bypass=1 keyframe_interval=2 note: fine",
			"srt://h:1?mode=caller&latency=120",
			"plain text without pairs",
		])
			expect(mask(text)).toBe(text);
	});

	test("JSON-only rules leave key= assignments to the caller", () => {
		const jsonOnly = { ...RULES, assignments: false };
		expect(
			maskSecretValues(`{"token":"${SECRET}"} psk=${SECRET}`, jsonOnly),
		).toBe(`{"token":"[M]"} psk=${SECRET}`);
	});

	test("spans are in source order and don't overlap", () => {
		const text = `{"a":1,"token":"${SECRET}","b":{"psk":"${SECRET}"}} pin=1 x`;
		const spans = secretValueSpans(text, RULES);
		expect(spans).toHaveLength(3);
		for (let i = 1; i < spans.length; i++)
			expect(spans[i]?.start).toBeGreaterThanOrEqual(spans[i - 1]?.end ?? 0);
	});
});
